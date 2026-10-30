#!/usr/bin/env node
/**
 * redaction.mjs — 验收标准 5 的专项测试：token 不出现于日志与工具输出。
 *
 * 1. 客户端错误信息对 token 做脱敏（redact）；
 * 2. 代表性工具的输出 value 与 render 文本不含 token（token 只进请求头）；
 * 3. auth_status / get_me 的输出不含 token 值。
 *
 * 用法: node --import ./tests/register-loader.mjs tests/redaction.mjs
 */

import { redact, createClient, GithubAuthError } from '../lib/client.js'
import { buildTools } from '../lib/tools.js'

let failures = 0
function assert(cond, label) {
  if (cond) console.log(`  ✅ ${label}`)
  else { failures += 1; console.log(`  ❌ FAIL: ${label}`) }
}

const FAKE_TOKEN = 'ghp_S3CR3T_TOKEN_1234567890abcdef'

console.log('===== redact 脱敏 =====')
assert(redact(`error ${FAKE_TOKEN} here`, FAKE_TOKEN) === 'error *** here', 'redact 替换 token 为 ***')
assert(redact('no token here', FAKE_TOKEN) === 'no token here', '无 token 时原样返回')

console.log('\n===== 客户端：token 只进请求头，错误信息脱敏 =====')
{
  const seen = []
  // createClient 的注入点是 transport({ method, url, headers, body, signal }) → { status, statusText, headers, text }
  const transport = async ({ method, url, headers }) => {
    seen.push({ method, url: String(url), headers: headers ?? {} })
    return {
      status: 422,
      statusText: 'Unprocessable Entity',
      headers: { 'x-ratelimit-remaining': '59', 'x-ratelimit-limit': '60' },
      text: JSON.stringify({ message: `bad request: ${FAKE_TOKEN}` })
    }
  }
  const client = createClient({
    resolveToken: async () => ({ token: FAKE_TOKEN, source: 'env' }),
    logger: { warn: () => {} },
    transport
  })
  const err = await client.request('POST', '/repos/o/r/issues', { body: { title: 'x' } }).then(() => null, (e) => e)
  assert(err instanceof Error && !String(err.message).includes(FAKE_TOKEN), `422 错误信息不含 token（${err.message.slice(0, 40)}…）`)
  assert(seen[0]?.headers.Authorization === `Bearer ${FAKE_TOKEN}`, 'token 以 Bearer 头发送')
  assert(!String(seen[0]?.url).includes(FAKE_TOKEN), 'URL 不含 token')
}

console.log('\n===== 工具输出不含 token =====')
{
  const api = {
    request: async (method, path) => {
      if (path === '/user') return { data: { login: 'octocat', name: 'Octo', html_url: 'https://github.com/octocat', public_repos: 1, followers: 1, following: 1, bio: null, company: null, email: null, location: null } }
      throw new Error('unexpected')
    }
  }
  const ctxWithToken = {
    get: () => ({ resolve: async () => ({ value: FAKE_TOKEN, source: 'file' }) }),
    logger: { warn: () => {} }
  }
  const tools = buildTools({ api, config: {}, state: {}, ctx: ctxWithToken })
  const getMe = tools.find((t) => t.name === 'github_get_me')
  const exec = { signal: void 0 }
  const result = await getMe.execute({}, exec)
  const serialized = JSON.stringify(result)
  assert(!serialized.includes(FAKE_TOKEN), 'github_get_me 输出不含 token')

  const statusTool = tools.find((t) => t.name === 'github_auth_status')
  const statusResult = await statusTool.execute({}, exec)
  assert(!JSON.stringify(statusResult).includes(FAKE_TOKEN), 'github_auth_status 输出不含 token')
  assert(statusResult.configured === true && statusResult.source === 'file', 'github_auth_status 正确报告来源')
  const rendered = statusTool.output.render({}, statusResult)
  assert(!JSON.stringify(rendered).includes(FAKE_TOKEN), 'github_auth_status render 文本不含 token')
}

console.log('\n===== 认证缺失错误提示（不泄露任何凭据）=====')
{
  const client = createClient({ resolveToken: async () => null, fetchImpl: async () => { throw new Error('should not fetch') } })
  const err = await client.request('GET', '/user').then(() => null, (e) => e)
  assert(err instanceof GithubAuthError, '无 token → GithubAuthError')
  assert(!err.message.includes(FAKE_TOKEN), '错误提示不含 token')
  assert(err.code === 'GITHUB_AUTH_REQUIRED', '错误码 GITHUB_AUTH_REQUIRED')
}

console.log('\n========================================')
if (failures === 0) {
  console.log('✅ token 脱敏专项验证通过：日志/错误/输出均不出现 token。')
} else {
  console.log(`❌ ${failures} 项断言失败`)
  process.exitCode = 1
}
