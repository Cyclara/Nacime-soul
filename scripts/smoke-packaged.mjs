// scripts/smoke-packaged.mjs
// P1-27: 打包后冒烟测试
// 依据：S-001 §3.1、S-001 P1-27 验收标准
//
// 用法：npm run build:win 后，运行 node scripts/smoke-packaged.mjs
//
// 检查项：
//   1. electron-builder.yml 配置完整（NSIS/asarUnpack/安装范围/占位符）
//   2. 图标存在
//   3. package.json 脚本齐全
//   4. prompt 文件齐全且已纳入打包文件列表（生产环境不崩）
//   5. 构建产物 out/ 存在
//   6. 若已打包（dist-electron/ 存在）：native addon 已从 asar 解包
//
// 原则：检查必须基于真实证据。条件不满足时报告 SKIP（而非 || true 假通过）。

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const root = join(__dirname, '..')

const PASS = '✓'
const FAIL = '✗'
const SKIP = '○'

const results = []

function pass(name, detail) {
  console.log(`  ${PASS} ${name}${detail ? ' — ' + detail : ''}`)
  results.push({ name, ok: true })
}

function fail(name, detail) {
  console.log(`  ${FAIL} ${name}${detail ? ' — ' + detail : ''}`)
  results.push({ name, ok: false, error: detail })
}

function skip(name, reason) {
  console.log(`  ${SKIP} ${name} (SKIP: ${reason})`)
  results.push({ name, ok: true, skipped: true })
}

function check(name, fn) {
  try {
    const result = fn()
    if (result === true) {
      pass(name)
    } else if (result === false) {
      fail(name)
    } else if (typeof result === 'string') {
      // 返回字符串 = 失败原因
      fail(name, result)
    } else if (result && typeof result === 'object' && result.skip) {
      skip(name, result.skip)
    } else if (result && typeof result === 'object' && result.ok) {
      pass(name, result.detail)
    } else {
      fail(name, 'unexpected return')
    }
  } catch (e) {
    fail(name, e.message)
  }
}

console.log('\n=== P1-27: 打包冒烟检查 ===\n')

// --- 1. electron-builder.yml 存在且配置完整 ---
check('electron-builder.yml 存在', () => existsSync(join(root, 'electron-builder.yml')))

const builderYml = readFileSync(join(root, 'electron-builder.yml'), 'utf8')
check('appId 已配置', () => builderYml.includes('appId:'))
check('productName 已配置', () => builderYml.includes('productName:'))
check('NSIS 目标已配置', () => builderYml.includes('nsis'))
check('asarUnpack better-sqlite3', () => builderYml.includes('better-sqlite3'))
check('deleteAppDataOnUninstall=false', () =>
  builderYml.includes('deleteAppDataOnUninstall: false')
)
check('oneClick=false', () => builderYml.includes('oneClick: false'))
check('允许选择安装目录', () => builderYml.includes('allowToChangeInstallationDirectory: true'))
check('桌面快捷方式', () => builderYml.includes('createDesktopShortcut: true'))
check('开始菜单快捷方式', () => builderYml.includes('createStartMenuShortcut: true'))
check('perMachine=false（per-user 安装）', () => builderYml.includes('perMachine: false'))

// --- 2. prompt 文件已纳入打包列表（S-004 #20: seed 缺失会 fatal） ---
check('electron-builder.yml files 含 resources/prompts', () =>
  builderYml.includes('resources/prompts') ? { ok: true, detail: 'prompt 文件将被打包' } : false
)
check('seed.md 存在（关键层，缺失会 fatal）', () =>
  existsSync(join(root, 'resources', 'prompts', 'seed.md'))
)
check('system.md 存在（关键层，缺失会 fatal）', () =>
  existsSync(join(root, 'resources', 'prompts', 'system.md'))
)
check('identity.md 存在', () => existsSync(join(root, 'resources', 'prompts', 'identity.md')))
check('soul.md 存在', () => existsSync(join(root, 'resources', 'prompts', 'soul.md')))
check('styles/casual.md 存在', () =>
  existsSync(join(root, 'resources', 'prompts', 'styles', 'casual.md'))
)

// --- 2b. seed 记忆文件已纳入打包列表（P2-36/37：seed 缺失 = 打包版无人格记忆） ---
check('electron-builder.yml files 含 resources/seeds', () =>
  builderYml.includes('resources/seeds') ? { ok: true, detail: 'seed 记忆将被打包' } : false
)
check('seed 记忆目录存在', () =>
  existsSync(join(root, 'resources', 'seeds'))
    ? { ok: true, detail: 'resources/seeds/ 存在' }
    : 'resources/seeds/ 缺失'
)

// --- 3. 图标 ---
check('assets/icon.ico 存在', () => existsSync(join(root, 'assets', 'icon.ico')))

// --- 4. package.json 脚本 ---
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
check('package.json 有 build:win 脚本', () => pkg.scripts['build:win'] !== undefined)
check('package.json 有 build:unpack 脚本', () => pkg.scripts['build:unpack'] !== undefined)
check(
  'electron-builder 为 devDependency',
  () => pkg.devDependencies['electron-builder'] !== undefined
)
check(
  '@electron/rebuild 为 devDependency',
  () => pkg.devDependencies['@electron/rebuild'] !== undefined
)
check('postinstall 含 electron-rebuild better-sqlite3', () =>
  typeof pkg.scripts['postinstall'] === 'string' &&
  pkg.scripts['postinstall'].includes('better-sqlite3')
    ? { ok: true }
    : false
)

// --- 5. 发布占位符（S-005: 占位值不可用于发布） ---
check('发布配置使用占位值（未发布）', () => builderYml.includes('REPLACE_BEFORE_RELEASE'))

// --- 6. 构建产物 ---
const outDir = join(root, 'out')
const distDir = join(root, 'dist-electron')
const mainJs = join(root, 'out', 'main', 'index.js')

check('out/ 目录存在（已构建）', () => existsSync(outDir))
check('out/main/index.js 存在', () => existsSync(mainJs))

// --- 7. native addon 解包验证（P1-27 首要风险：打包版 better-sqlite3 可加载） ---
// 仅在已打包时检查；未打包时 SKIP（不假通过）
check('dist-electron/ 存在（已打包）', () => {
  if (!existsSync(distDir)) return { skip: '尚未打包（npm run build:win 后再查）' }
  return true
})

check('better-sqlite3 .node 已从 asar 解包', () => {
  if (!existsSync(distDir)) return { skip: 'dist-electron/ 不存在' }
  // electron-builder asarUnpack 会将 native addon 放到 app.asar.unpacked/
  const winUnpacked = join(distDir, 'win-unpacked')
  if (!existsSync(winUnpacked)) return { skip: 'win-unpacked/ 不存在' }
  return findNodeFile(winUnpacked)
})

check('asar 包存在', () => {
  if (!existsSync(distDir)) return { skip: 'dist-electron/ 不存在' }
  const winUnpacked = join(distDir, 'win-unpacked')
  if (!existsSync(winUnpacked)) return { skip: 'win-unpacked/ 不存在' }
  const resourcesDir = join(winUnpacked, 'resources')
  if (!existsSync(resourcesDir)) return 'resources/ 不存在'
  const asarExists = existsSync(join(resourcesDir, 'app.asar'))
  const unpackedExists = existsSync(join(resourcesDir, 'app.asar.unpacked'))
  if (asarExists && unpackedExists)
    return { ok: true, detail: 'app.asar + app.asar.unpacked 均存在' }
  if (asarExists && !unpackedExists)
    return 'app.asar 存在但 app.asar.unpacked 缺失（native addon 可能未解包）'
  return 'app.asar 不存在'
})

// --- 7c. asar 内容校验（M-09：smoke 必须检查实际打包内容，而非只查源码目录/配置字符串） ---
// 此前 smoke 只查 resources/ 源码目录 + electron-builder.yml 里的字符串，
// 当前 dist-electron 曾因此漏掉 resources/seeds（seed 加入前的陈旧产物）却判 PASS。
check('electron-builder.yml files 含 resources/growth', () =>
  builderYml.includes('resources/growth')
    ? { ok: true, detail: 'growth 里程碑配置将被打包' }
    : 'resources/growth/** 不在 files 列表（打包版里程碑配置会是死配置）'
)

check('asar 内含 resources/prompts/seeds/growth（M-09）', () => {
  if (!existsSync(distDir)) return { skip: 'dist-electron/ 不存在' }
  const winUnpacked = join(distDir, 'win-unpacked')
  if (!existsSync(winUnpacked)) return { skip: 'win-unpacked/ 不存在' }
  const asarPath = join(winUnpacked, 'resources', 'app.asar')
  if (!existsSync(asarPath)) return { skip: 'app.asar 不存在（先 npm run build:win）' }
  let asar
  try {
    asar = require('@electron/asar')
  } catch {
    return { skip: '@electron/asar 不可用（未安装）' }
  }
  const files = asar.listPackage(asarPath)
  // asar 路径分隔符在 Windows 为反斜杠；统一归一化后匹配 resources/<seg>/
  const normalized = files.map((f) => f.replace(/\\/g, '/'))
  const missing = []
  for (const seg of ['prompts', 'seeds', 'growth']) {
    if (!normalized.some((f) => f.includes(`resources/${seg}/`))) missing.push(`resources/${seg}`)
  }
  if (missing.length > 0) {
    return `app.asar 中缺失运行时资源: ${missing.join(', ')}（请重新打包后再发布）`
  }
  return { ok: true, detail: 'prompts/seeds/growth 均在 app.asar 内' }
})

// --- 7d. asar 内 index.html 含 CSP meta（V-01：file:// 下 onHeadersReceived 不触发， ---
// meta 是生产环境唯一的 CSP 来源；缺失意味着打包版无内容安全策略）
check('asar 内 index.html 含 CSP meta（V-01）', () => {
  if (!existsSync(distDir)) return { skip: 'dist-electron/ 不存在' }
  const winUnpacked = join(distDir, 'win-unpacked')
  if (!existsSync(winUnpacked)) return { skip: 'win-unpacked/ 不存在' }
  const asarPath = join(winUnpacked, 'resources', 'app.asar')
  if (!existsSync(asarPath)) return { skip: 'app.asar 不存在（先 npm run build:win）' }
  let asar
  try {
    asar = require('@electron/asar')
  } catch {
    return { skip: '@electron/asar 不可用（未安装）' }
  }
  const entry = asar
    .listPackage(asarPath)
    // 归一化只用于匹配；extractFile 要求"无前导分隔符 + 平台原生分隔符"
    //（listPackage 在 Windows 返回带 \\ 前缀的反斜杠路径，实测两种常见写法都取不到文件）
    .find((f) => f.replace(/\\/g, '/').endsWith('out/renderer/index.html'))
  if (!entry) return 'app.asar 中找不到 out/renderer/index.html'
  const relPath = entry
    .replace(/^[\\/]+/, '')
    .split(/[\\/]/)
    .join(sep)
  const html = asar.extractFile(asarPath, relPath).toString('utf8')
  if (!html.includes('http-equiv="Content-Security-Policy"')) {
    return 'index.html 缺少 CSP meta（构建期注入失效？检查 electron.vite.config.ts 的 injectCspMeta）'
  }
  return { ok: true, detail: 'CSP meta 已随打包注入' }
})

// --- 总结 ---
console.log('\n=== 结果 ===')
const failed = results.filter((r) => !r.ok && !r.skipped)
const skipped = results.filter((r) => r.skipped)
const passed = results.filter((r) => r.ok && !r.skipped)
console.log(
  `${PASS} ${passed.length} 通过  ${SKIP} ${skipped.length} 跳过  ${FAIL} ${failed.length} 失败`
)

if (failed.length > 0) {
  console.log(`\n${FAIL} 失败项:`)
  for (const f of failed) {
    console.log(`  - ${f.name}${f.error ? ': ' + f.error : ''}`)
  }
  process.exit(1)
} else {
  console.log(`\n${PASS} 无失败项（${skipped.length} 项因未打包而跳过，打包后重跑可验证）`)
  process.exit(0)
}

/**
 * 在 win-unpacked 目录中递归查找 better-sqlite3 的 .node 文件。
 * 限制递归深度避免遍历整个产物。
 */
function findNodeFile(baseDir, depth = 0) {
  if (depth > 6) return false
  let entries
  try {
    entries = readdirSync(baseDir)
  } catch {
    return false
  }
  for (const entry of entries) {
    const full = join(baseDir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      // 快速路径：better-sqlite3 目录
      if (entry === 'better-sqlite3') {
        const nodeFile = findNodeFileRecursive(full)
        if (nodeFile) return { ok: true, detail: nodeFile.replace(baseDir, '...') }
      }
      const sub = findNodeFile(full, depth + 1)
      if (sub && typeof sub === 'object' && sub.ok) return sub
    } else if (entry.endsWith('.node') && full.includes('better-sqlite3')) {
      return { ok: true, detail: full.replace(baseDir, '...') }
    }
  }
  return false
}

function findNodeFileRecursive(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) {
      const sub = findNodeFileRecursive(full)
      if (sub) return sub
    } else if (entry.endsWith('.node')) {
      return full
    }
  }
  return null
}
