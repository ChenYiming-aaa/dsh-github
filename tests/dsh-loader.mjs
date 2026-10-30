/**
 * dsh-loader.mjs — 测试专用 ESM loader
 *
 * 把 `@deepseek-ai/*`（以及运行时顶层依赖）映射到从 DSH 桌面版
 * `resources/app.asar` 中提取出来的 node_modules（见 tests/asar-extract.mjs），
 * 使测试用真实版本的 dsh-tools 校验插件。仅用于测试，不随插件分发。
 *
 * 运行时的查找顺序：
 *   1. 环境变量 DSH_RUNTIME_NODE_MODULES
 *   2. <repo>/.dsh-runtime/node_modules（tests/asar-extract.mjs 的默认输出）
 *
 * 解析规则：在运行时里找到对应文件就短路，找不到再交给默认 loader。
 */

import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const RUNTIME_ROOTS = [
  process.env.DSH_RUNTIME_NODE_MODULES,
  path.join(REPO_ROOT, '.dsh-runtime', 'node_modules')
].filter(Boolean)

function entryCandidates(pkgDir, pkg) {
  const candidates = []
  const pickString = (value) => (typeof value === 'string' ? value : null)
  if (pkg.exports && typeof pkg.exports === 'object') {
    const dot = pkg.exports['.']
    candidates.push(pickString(dot), pickString(dot?.import), pickString(dot?.default))
  } else {
    candidates.push(pickString(pkg.exports))
  }
  candidates.push(pickString(pkg.module), pickString(pkg.main), 'lib/index.js', 'index.js')
  return candidates.filter(Boolean).map((rel) => path.join(pkgDir, rel))
}

function runtimePath(specifier) {
  // specifier 形如 '@deepseek-ai/dsh-tools'、'@deepseek-ai/dsh-tools/package.json'、'cosmokit'
  const parts = specifier.split('/')
  const scoped = specifier.startsWith('@')
  const pkgName = scoped ? `${parts[0]}/${parts[1]}` : parts[0]
  const sub = scoped ? parts.slice(2).join('/') : parts.slice(1).join('/')

  for (const root of RUNTIME_ROOTS) {
    const pkgDir = path.join(root, pkgName)
    if (!existsSync(path.join(pkgDir, 'package.json'))) continue
    let pkg = {}
    try {
      pkg = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
    } catch {
      /* 保持空对象 */
    }
    if (sub === '') {
      const found = entryCandidates(pkgDir, pkg).find((file) => existsSync(file))
      if (found) return found
      continue
    }
    const candidates = [
      path.join(pkgDir, sub),
      path.join(pkgDir, `${sub}.js`),
      path.join(pkgDir, `${sub}.mjs`),
      path.join(pkgDir, 'lib', sub),
      path.join(pkgDir, 'lib', `${sub}.js`),
      path.join(pkgDir, 'lib', `${sub}.mjs`),
      path.join(pkgDir, 'lib', sub, 'index.js')
    ]
    const found = candidates.find((file) => existsSync(file))
    if (found) return found
  }
  return null
}

export async function resolve(specifier, context, nextResolve) {
  // 相对路径/绝对路径/URL/内建模块交给默认 loader
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('file:') || specifier.startsWith('node:')) {
    return nextResolve(specifier, context)
  }
  const target = runtimePath(specifier)
  if (target) {
    return { url: pathToFileURL(target).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
