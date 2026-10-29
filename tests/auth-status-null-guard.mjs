#!/usr/bin/env node
/**
 * auth-status-null-guard.mjs — 回归测试：github_auth_status 在 state.pendingFlow
 * 为 null（插件初始状态 / 调用 github_auth_logout 之后）时不得抛错。
 *
 * 背景：旧实现用 `state.pendingFlow === void 0` 判空，而 index.js 把
 * pendingFlow 初始化为 null；null !== undefined 会继续执行
 * `state.pendingFlow.status()`，抛出
 * `TypeError: Cannot read properties of null (reading 'status')`。
 * 该表达式在 token 解析之后、configured 分支之前求值，因此未配置认证的场景
 * 也会直接失败，而不是返回“未配置认证”。
 *
 * 用法: node --import ./tests/register-loader.mjs tests/auth-status-null-guard.mjs
 */

import { buildTools } from '../lib/tools.js'

let failures = 0
function assert(cond, label) {
  if (cond) console.log(`  ✅ ${label}`)
  else { failures += 1; console.log(`  ❌ FAIL: ${label}`) }
}

const TOKEN = 'ghp_test_token_not_a_real_secret'

const USER = {
  login: 'octocat',
  name: 'Octo Cat',
  html_url: 'https://github.com/octocat',
  public_repos: 8,
  followers: 9,
  following: 10,
  bio: null,
  company: null,
  email: null,
  location: null,
  avatar_url: 'https://avatars.githubusercontent.com/u/1'
}

/** 构造运行时；token 走 config.token / config.tokenRef，不依赖外部环境。 */
function makeRuntime({ pendingFlow, deviceFlowStatus = null, lastFlowPublic = null, config = { token: TOKEN } }) {
  const api = {
    request: async (method, path) => {
      if (method === 'GET' && path === '/user') return { data: USER }
      throw new Error(`unexpected request: ${method} ${path}`)
    }
  }
  const state = { authInfo: null, pendingFlow, deviceFlowStatus, lastFlowPublic }
  const ctx = { get: () => void 0, logger: { warn: () => {} } }
  return { api, config, state, ctx }
}

function statusTool(runtime) {
  return buildTools(runtime).find((t) => t.name === 'github_auth_status')
}

async function execute(tool, label) {
  try {
    return { ok: true, value: await tool.execute({}, {}) }
  } catch (error) {
    failures += 1
    console.log(`  ❌ FAIL: ${label} 抛出 ${error.constructor.name}: ${error.message}`)
    return { ok: false }
  }
}

console.log('===== pendingFlow 为 null 时不得抛错（已配置 token）=====')
{
  const runtime = makeRuntime({ pendingFlow: null })
  const tool = statusTool(runtime)
  const result = await execute(tool, 'pendingFlow=null')
  if (result.ok) {
    assert(result.value.configured === true, 'pendingFlow=null：报告已配置')
    assert(result.value.valid === true, 'pendingFlow=null：token 校验通过')
    assert(result.value.username === 'octocat', 'pendingFlow=null：返回登录用户')
    assert(result.value.deviceFlow === null, 'pendingFlow=null：deviceFlow 为 null')
    const rendered = JSON.stringify(tool.output.render({}, result.value))
    assert(rendered.includes('认证有效'), 'pendingFlow=null：render 文本正常')
  }
}

console.log('\n===== pendingFlow 为 null 且未配置 token =====')
{
  // 旧实现在这里同样崩：表达式先于 configured 分支求值
  const runtime = makeRuntime({ pendingFlow: null, config: { tokenRef: 'GITHUB_TEST_ABSENT_TOKEN' } })
  delete process.env.GITHUB_TEST_ABSENT_TOKEN
  const tool = statusTool(runtime)
  const result = await execute(tool, 'pendingFlow=null 且无 token')
  if (result.ok) {
    assert(result.value.configured === false, '未配置 token：configured=false')
    assert(result.value.valid === false, '未配置 token：valid=false')
    assert(result.value.deviceFlow === null, '未配置 token：deviceFlow 为 null')
    const rendered = JSON.stringify(tool.output.render({}, result.value))
    assert(rendered.includes('未配置'), '未配置 token：render 提示未配置')
  }
}

console.log('\n===== pendingFlow 为 undefined（state 缺字段）=====')
{
  const runtime = makeRuntime({ pendingFlow: void 0 })
  const tool = statusTool(runtime)
  const result = await execute(tool, 'pendingFlow=undefined')
  if (result.ok) assert(result.value.deviceFlow === null, 'pendingFlow=undefined：deviceFlow 为 null')
}

console.log('\n===== Device Flow 进行中仍然上报状态 =====')
{
  const poller = { status: () => 'pending', stop: () => {} }
  const runtime = makeRuntime({
    pendingFlow: poller,
    lastFlowPublic: { userCode: 'ABCD-1234', verificationUri: 'https://github.com/login/device' }
  })
  const tool = statusTool(runtime)
  const result = await execute(tool, 'pendingFlow=poller')
  if (result.ok) {
    assert(result.value.deviceFlow !== null, 'poller：deviceFlow 不为 null')
    assert(result.value.deviceFlow.status === 'pending', 'poller：上报 pending 状态')
    assert(result.value.deviceFlow.userCode === 'ABCD-1234', 'poller：带出用户码')
    const rendered = JSON.stringify(tool.output.render({}, result.value))
    assert(rendered.includes('pending'), 'poller：render 包含 Device Flow 状态')
  }
}

console.log('\n========================================')
if (failures === 0) {
  console.log('✅ auth_status 空值守卫回归测试通过。')
} else {
  console.log(`❌ ${failures} 项断言失败`)
  process.exitCode = 1
}
