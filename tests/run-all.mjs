#!/usr/bin/env node
/**
 * run-all.mjs — 顺序执行全部测试。
 * 用法: node tests/run-all.mjs
 */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

// 测试要用真实版本的 @deepseek-ai/dsh-tools 校验工具定义：
// 首次运行自动从本机 DSH Desktop 的 app.asar 提取依赖闭包到 <repo>/.dsh-runtime。
if (!process.env.DSH_RUNTIME_NODE_MODULES) {
  try {
    const { extractRuntime } = await import('./asar-extract.mjs')
    extractRuntime()
  } catch (error) {
    console.error(`⚠️  运行时提取失败：${error.message}`)
    console.error('   → 请安装 DSH Desktop，或用 DSH_APP_ASAR / DSH_RUNTIME_NODE_MODULES 指定运行时后重试。')
    process.exit(1)
  }
}

const cases = [
  'validate-tools.mjs',
  'validate-apply.mjs',
  'approval-gate.mjs',
  'redaction.mjs',
  'dns-fallback.mjs',
  'push-upload.mjs'
]

let failed = 0
for (const file of cases) {
  console.log(`\n━━━ 运行 ${file} ━━━`)
  // 相对路径 + cwd 指向插件根目录（Windows 下 file:// URL 易被二次编码）
  const result = spawnSync(process.execPath, ['--import', './tests/register-loader.mjs', `./tests/${file}`], {
    stdio: 'inherit',
    cwd: root
  })
  if (result.status !== 0) failed += 1
}

console.log(`\n========================================`)
if (failed === 0) {
  console.log('✅ 全部测试通过。')
} else {
  console.log(`❌ ${failed} 个测试文件失败`)
  process.exitCode = 1
}
