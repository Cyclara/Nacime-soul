// src/main/voice/tts/gpu-info.ts
// P3V-16：显卡名探测（GPT runtime 变体**推荐**用；main-only）。
//
// 只做推荐不做决定（handoff §7）：探测结果只是把某个变体标上 recommended，
// 用户随时可以选另一个；探测失败就两个都不推荐，绝不替用户拍板。
//
// 实现纪律：
//   - 命令是**固定字面量**，不拼接任何用户输入（与 edge-sapi-runner 的
//     -EncodedCommand 是同一条红线的两种满足方式：那边有用户文本必须编码，
//     这里没有可变量）。
//   - 单进程只探一次（memoize）：overview 每次刷新都 spawn 一个 PowerShell
//     太重，而显卡不会在会话中途换。
//   - 超时/失败/非 Windows 一律 null——上层按「检测不到」处理，不是错误。

import { spawn } from 'node:child_process'

const PROBE_TIMEOUT_MS = 8_000

const PS_COMMAND =
  'Get-CimInstance -ClassName Win32_VideoController | Select-Object -ExpandProperty Name'

export interface GpuNameProbeDeps {
  /** 注入执行器（测试用）；默认 spawn PowerShell 读 Win32_VideoController。 */
  readonly run?: () => Promise<string>
  /** 注入平台（测试用）；默认 process.platform。 */
  readonly platform?: NodeJS.Platform
}

/** 从 PowerShell 多行输出里挑一个代表性显卡名：优先 NVIDIA，其次第一块非空。 */
export function pickPrimaryGpuName(stdout: string): string | null {
  const names = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  if (names.length === 0) return null
  return names.find((name) => /NVIDIA/i.test(name)) ?? names[0]!
}

function runPowerShellGpuQuery(): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_COMMAND],
      { windowsHide: true, timeout: PROBE_TIMEOUT_MS }
    )
    const chunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => {
      // 显卡名列表只有几行；上界防异常输出撑爆内存
      if (chunks.length < 32) chunks.push(chunk)
    })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString('utf8'))
      else reject(new Error(`powershell exit ${String(code)}`))
    })
  })
}

/**
 * 建一个 memoize 过的显卡名探测器（GptRuntimeManagerDeps.gpuName）。
 * 失败/超时/非 Windows → null，且结果同样被缓存（不反复重试拖慢设置页）。
 */
export function createGpuNameProbe(deps: GpuNameProbeDeps = {}): () => Promise<string | null> {
  const platform = deps.platform ?? process.platform
  const run = deps.run ?? runPowerShellGpuQuery
  let pending: Promise<string | null> | null = null
  return () => {
    if (platform !== 'win32') return Promise.resolve(null)
    pending ??= run()
      .then(pickPrimaryGpuName)
      .catch(() => null)
    return pending
  }
}
