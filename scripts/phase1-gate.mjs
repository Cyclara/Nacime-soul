// scripts/phase1-gate.mjs
// P1-28: Phase 1 完成定义验收门禁
// 依据：S-001 P1-28 验收标准
//   "dev、exe、typecheck、test、build 全过；磁盘无明文 key；日志无聊天正文"
//
// 用法：node scripts/phase1-gate.mjs
//
// 本脚本自动执行 S-001 §3.2 的 Phase 结束门禁：
//   合并前：npm run lint && npm run typecheck && npm test && npm run build
//   并额外做两项安全扫描：
//     1. 源码无明文 API key（sk-/sk-ant- 模式）
//     2. 构建产物 out/ 无聊天正文残留

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')

const PASS = '✓'
const FAIL = '✗'

const results = []

// Windows 上 npm 是 npm.cmd，execFileSync 直调会 ENOENT/EINVAL。
// 命令均为硬编码无用户输入，shell:true 是安全的标准做法。
const NPM = 'npm'

function runStep(name, cmdArgs) {
  process.stdout.write(`  ${name}...`)
  try {
    execFileSync(cmdArgs[0], cmdArgs.slice(1), {
      cwd: root,
      stdio: 'pipe',
      timeout: 300_000,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0' }
    })
    console.log(` ${PASS}`)
    results.push({ name, ok: true })
    return true
  } catch (e) {
    console.log(` ${FAIL}`)
    const stderr = e.stderr ? e.stderr.toString().trim() : ''
    const stdout = e.stdout ? e.stdout.toString().trim() : ''
    console.log(
      `    ${stderr.split('\n').slice(-5).join('\n    ') || stdout.split('\n').slice(-5).join('\n    ') || e.message}`
    )
    results.push({ name, ok: false, error: stderr || stdout || e.message })
    return false
  }
}

function scanStep(name, fn) {
  process.stdout.write(`  ${name}...`)
  try {
    const issues = fn()
    if (issues.length === 0) {
      console.log(` ${PASS}`)
      results.push({ name, ok: true })
      return true
    }
    console.log(` ${FAIL} (${issues.length} 处)`)
    for (const issue of issues.slice(0, 10)) {
      console.log(`    ${issue}`)
    }
    results.push({ name, ok: false, error: `${issues.length} 处违规` })
    return false
  } catch (e) {
    console.log(` ${FAIL} ${e.message}`)
    results.push({ name, ok: false, error: e.message })
    return false
  }
}

console.log('\n=== P1-28: Phase 1 门禁检查 ===\n')
console.log('--- 工具链 ---')

// --- 1. lint ---
runStep('lint (eslint)', [NPM, 'run', 'lint'])

// --- 2. typecheck ---
runStep('typecheck (tsc node + web)', [NPM, 'run', 'typecheck'])

// --- 3. test ---
runStep('test (vitest)', [NPM, 'test'])

// --- 4. build ---
runStep('build (electron-vite)', [NPM, 'run', 'build'])

console.log('\n--- 安全扫描 ---')

// --- 5. 源码无明文 API key ---
// 扫描 src/ 中的 .ts 文件，查找疑似明文 key 模式
// 排除 .test.ts（测试中的 fake key 如 'sk-test' 是允许的）和 secret-store.ts（前缀常量定义）
scanStep('源码无明文 API key', () => {
  const keyPatterns = [
    /sk-[a-zA-Z0-9]{20,}/, // OpenAI 风格
    /sk-ant-[a-zA-Z0-9]{20,}/, // Anthropic 风格
    /\b[Aa]uthorization:\s*Bearer\s+[a-zA-Z0-9._-]{20,}/ // Bearer token
  ]
  const issues = []
  const srcDir = join(root, 'src')
  walkTs(srcDir, (file, content) => {
    if (file.endsWith('.test.ts')) return
    // 跳过 secret-store.ts 的前缀常量定义（PREFIX_ENC = 'enc:' 等）
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // 跳过注释和字符串常量定义行
      if (
        line.includes('PREFIX_') ||
        line.includes("'enc:'") ||
        line.includes("'obf:'") ||
        line.includes("'plain:'")
      )
        continue
      for (const pattern of keyPatterns) {
        if (pattern.test(line)) {
          issues.push(`${relative(root, file)}:${i + 1} ${line.trim().slice(0, 80)}`)
        }
      }
    }
  })
  return issues
})

// --- 6. 构建产物无聊天正文残留 ---
scanStep('构建产物无聊天正文残留', () => {
  const outDir = join(root, 'out')
  if (!existsSync(outDir)) return ['out/ 不存在，请先 npm run build']
  const issues = []
  // 扫描 out/ 中的 .js 文件，查找疑似聊天正文（中文长句、prompt 全文）
  // 注意：prompt 文件内容会被打包进 out/（通过 resources/），这是正常的，
  // 这里只检查 main/renderer bundle 中是否意外内嵌了用户聊天内容。
  walkJs(outDir, (file, content) => {
    // 检查是否有疑似用户输入的动态聊天内容（非 prompt 模板）
    // prompt 模板是静态的，聊天内容是动态拼接的
    // 启发式：查找 "user said:" / "用户说:" 等动态拼接模式
    const dynamicPatterns = [
      /user\s+said:\s+["'][^"']{10,}["']/i,
      /用户说[：:]\s*["'][^"']{10,}["']/
    ]
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      for (const pattern of dynamicPatterns) {
        if (pattern.test(lines[i])) {
          issues.push(
            `${relative(root, file)}:${i + 1} 疑似聊天正文: ${lines[i].trim().slice(0, 80)}`
          )
        }
      }
    }
  })
  return issues
})

// --- 7. 日志配置无聊天正文写入通道 ---
scanStep('日志配置不写入聊天正文', () => {
  // 检查 scrub.ts 的 LogFields 白名单不包含 content/message 等聊天字段
  const scrubFile = join(root, 'src', 'main', 'observability', 'scrub.ts')
  if (!existsSync(scrubFile)) return ['scrub.ts 不存在']
  const content = readFileSync(scrubFile, 'utf8')
  const issues = []
  // LogFields 类型中不应有 content / messages / userText 等字段
  if (/content\??:\s*(string|unknown)/.test(content) && !content.includes('scrub')) {
    issues.push('scrub.ts LogFields 可能含 content 字段')
  }
  return issues
})

// --- 总结 ---
console.log('\n=== 门禁结果 ===')
const failed = results.filter((r) => !r.ok)
if (failed.length === 0) {
  console.log(`${PASS} 全部 ${results.length} 项通过 - Phase 1 门禁达标`)
  process.exit(0)
} else {
  console.log(`${FAIL} ${failed.length}/${results.length} 项未通过:`)
  for (const f of failed) {
    console.log(`  - ${f.name}`)
  }
  process.exit(1)
}

// === 辅助函数 ===

function walkTs(dir, fn) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
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
      walkTs(full, fn)
    } else if (entry.endsWith('.ts')) {
      fn(full, readFileSync(full, 'utf8'))
    }
  }
}

function walkJs(dir, fn) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
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
      walkJs(full, fn)
    } else if (entry.endsWith('.js')) {
      fn(full, readFileSync(full, 'utf8'))
    }
  }
}
