#!/usr/bin/env node
/**
 * asar-extract.mjs — 从 DSH Desktop 的 app.asar 提取测试所需的运行时包
 *
 * 测试要用「真实版本」的 @deepseek-ai/dsh-tools 校验工具定义，
 * 但这些包随 DSH 桌面版打进 app.asar，不在插件目录里。
 * 本脚本按依赖闭包从 app.asar 中提取所需包到 `<repo>/.dsh-runtime/node_modules`
 * （已被 .gitignore 忽略），供 tests/dsh-loader.mjs 解析。
 *
 * 查找 app.asar 的顺序：
 *   1. 环境变量 DSH_APP_ASAR
 *   2. 从 PATH 上的 dsh 命令反推（<resources>/runtime/cli/bin/dsh.cmd → <resources>/app.asar）
 *   3. 常见安装位置（Windows / macOS）
 *
 * 用法:
 *   node tests/asar-extract.mjs            # 需要时提取（带缓存）
 *   node tests/asar-extract.mjs --force    # 强制重新提取
 *   DSH_APP_ASAR=/path/to/app.asar node tests/asar-extract.mjs
 *   DSH_RUNTIME_NODE_MODULES=/path/to/node_modules node tests/run-all.mjs   # 直接用已解包的运行时
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.join(here, '..')
export const RUNTIME_NODE_MODULES = path.join(REPO_ROOT, '.dsh-runtime', 'node_modules')

/** 校验工具定义所需的顶层包（其余按 dependencies 闭包自动补齐）。 */
const ROOT_PACKAGES = ['@deepseek-ai/dsh-tools', '@deepseek-ai/schemastery', '@deepseek-ai/cordis']

function whichDsh() {
  const cmd = process.platform === 'win32' ? 'where' : 'which'
  try {
    const out = execFileSync(cmd, ['dsh'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return out.split(/\r?\n/)[0]?.trim() || null
  } catch {
    return null
  }
}

function asarCandidates() {
  const list = []
  if (process.env.DSH_APP_ASAR) list.push(process.env.DSH_APP_ASAR)
  const dsh = whichDsh()
  if (dsh) {
    // <resources>/runtime/cli/bin/dsh.cmd → <resources>/app.asar
    list.push(path.resolve(path.dirname(dsh), '..', '..', '..', 'app.asar'))
  }
  if (process.platform === 'win32') {
    list.push('D:/DeepSeek Harness/resources/app.asar')
    if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'resources', 'app.asar'))
    list.push('C:/Program Files/DeepSeek Harness/resources/app.asar')
  } else if (process.platform === 'darwin') {
    list.push('/Applications/DeepSeek Harness.app/Contents/Resources/app.asar')
  }
  return list
}

function findAsar() {
  for (const candidate of asarCandidates()) {
    if (candidate && fs.existsSync(candidate)) return path.resolve(candidate)
  }
  throw new Error(
    '找不到 app.asar。请用 DSH_APP_ASAR=/path/to/app.asar 指定，或用 DSH_RUNTIME_NODE_MODULES 直接指向已解包的运行时 node_modules。\n已尝试:\n  ' +
      asarCandidates().filter(Boolean).join('\n  ')
  )
}

/** 读取 asar 头，返回 { entries: Map<相对路径, 条目>, baseOffset }。 */
function readAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r')
  try {
    const head = Buffer.alloc(16)
    fs.readSync(fd, head, 0, 16, 0)
    const pickleSize = head.readUInt32LE(4)
    const jsonLen = head.readUInt32LE(12)
    const json = Buffer.alloc(jsonLen)
    fs.readSync(fd, json, 0, jsonLen, 16)
    const header = JSON.parse(json.toString('utf8'))
    const entries = new Map()
    const walk = (node, prefix) => {
      for (const [name, value] of Object.entries(node.files ?? {})) {
        const key = prefix ? `${prefix}/${name}` : name
        if (value.files) walk(value, key)
        else entries.set(key, { size: value.size ?? 0, offset: Number(value.offset ?? 0), link: value.link, unpacked: value.unpacked === true })
      }
    }
    walk(header, '')
    return { fd, entries, baseOffset: 8 + pickleSize }
  } catch (error) {
    fs.closeSync(fd)
    throw error
  }
}

function readEntry(asarPath, asar, entry) {
  if (entry.unpacked) return fs.readFileSync(`${asarPath}.unpacked/${entry.path ?? ''}`.replace(/\/$/, ''))
  const buf = Buffer.alloc(entry.size)
  fs.readSync(asar.fd, buf, 0, entry.size, asar.baseOffset + entry.offset)
  return buf
}

const dirname = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

/** 在 asar 虚拟目录树里按 node 解析规则找依赖包目录。 */
function resolvePackageDir(entries, fromDir, name) {
  let dir = fromDir
  for (;;) {
    const candidate = `${dir ? `${dir}/` : ''}node_modules/${name}`
    if (entries.has(`${candidate}/package.json`)) return candidate
    if (dir === '') return null
    dir = dirname(dir)
  }
}

function readPackageJson(asar, asarPath, pkgDir) {
  const entry = asar.entries.get(`${pkgDir}/package.json`)
  if (!entry) return null
  entry.path = `${pkgDir}/package.json`
  try {
    return JSON.parse(readEntry(asarPath, asar, entry).toString('utf8'))
  } catch {
    return null
  }
}

export function extractRuntime({ force = false, quiet = false } = {}) {
  const asarPath = findAsar()
  const stat = fs.statSync(asarPath)
  const markerPath = path.join(RUNTIME_NODE_MODULES, '..', '.extract.json')
  if (!force && fs.existsSync(markerPath)) {
    try {
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'))
      if (marker.asar === asarPath && marker.size === stat.size && marker.mtimeMs === stat.mtimeMs) {
        if (!quiet) console.log(`✅ 运行时已提取（${RUNTIME_NODE_MODULES}），跳过。`)
        return RUNTIME_NODE_MODULES
      }
    } catch {
      /* 缓存损坏则重新提取 */
    }
  }

  const asar = readAsar(asarPath)
  let extracted = 0
  let bytes = 0
  try {
    // 定位 asar 内的 node_modules 根（形如 "dsh/node_modules"）
    const probe = asar.entries.get('')
    void probe
    const toolsEntry = [...asar.entries.keys()].find((key) => key.endsWith('/node_modules/@deepseek-ai/dsh-tools/package.json'))
    if (!toolsEntry) throw new Error('app.asar 里找不到 @deepseek-ai/dsh-tools，可能版本布局不同')
    const nmRoot = toolsEntry.slice(0, toolsEntry.indexOf('/node_modules/') + '/node_modules'.length)
    const appRoot = dirname(nmRoot)

    // BFS 依赖闭包
    const queue = []
    for (const name of ROOT_PACKAGES) {
      const dir = resolvePackageDir(asar.entries, appRoot, name)
      if (!dir) throw new Error(`app.asar 里找不到 ${name}`)
      queue.push(dir)
    }
    const seen = new Set()
    const packages = []
    while (queue.length) {
      const pkgDir = queue.shift()
      if (seen.has(pkgDir)) continue
      seen.add(pkgDir)
      packages.push(pkgDir)
      const pkg = readPackageJson(asar, asarPath, pkgDir)
      // 静态 import 的兄弟包可能声明在 peerDependencies 里（如 dsh-tools → dsh-scope），
      // 因此依赖闭包同时沿 dependencies / peerDependencies / optionalDependencies 扩散。
      const deps = new Set([
        ...Object.keys(pkg?.dependencies ?? {}),
        ...Object.keys(pkg?.peerDependencies ?? {}),
        ...Object.keys(pkg?.optionalDependencies ?? {})
      ])
      for (const dep of deps) {
        const dir = resolvePackageDir(asar.entries, pkgDir, dep)
        if (!dir) {
          if (!quiet) console.warn(`⚠️  依赖缺失（交由运行时提供）: ${dep} ← ${pkgDir}`)
          continue
        }
        if (!seen.has(dir)) queue.push(dir)
      }
    }

    // 落盘（跳过包内嵌套 node_modules，它们作为独立包处理）
    fs.rmSync(RUNTIME_NODE_MODULES, { recursive: true, force: true })
    for (const pkgDir of packages) {
      const prefix = `${pkgDir}/`
      for (const [key, entry] of asar.entries) {
        if (!key.startsWith(prefix)) continue
        const rest = key.slice(prefix.length)
        if (rest.includes('node_modules/')) continue
        if (entry.link) continue
        const entryWithPath = { ...entry, path: key }
        // 以 node_modules 根为基准落盘，保留 @scope/pkg 结构
        const target = path.join(RUNTIME_NODE_MODULES, key.slice(nmRoot.length + 1))
        fs.mkdirSync(path.dirname(target), { recursive: true })
        const data = readEntry(asarPath, asar, entryWithPath)
        fs.writeFileSync(target, data)
        extracted += 1
        bytes += data.length
      }
    }
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ asar: asarPath, size: stat.size, mtimeMs: stat.mtimeMs, packages: packages.length, files: extracted }, null, 2)
    )
    if (!quiet) {
      console.log(`✅ 已从 ${asarPath} 提取 ${packages.length} 个包 / ${extracted} 个文件（${(bytes / 1048576).toFixed(1)} MB）`)
      console.log(`   → ${RUNTIME_NODE_MODULES}`)
    }
    return RUNTIME_NODE_MODULES
  } finally {
    fs.closeSync(asar.fd)
  }
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('asar-extract.mjs')) {
  extractRuntime({ force: process.argv.includes('--force') })
}
