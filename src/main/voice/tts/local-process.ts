// src/main/voice/tts/local-process.ts
// P3B-04：本地 API 服务子进程协议（GPT-SoVITS Python 桥接的进程层）。
//
// 协议（借鉴 super-agent-party，为 GPT-SoVITS 打样）：
//   1. 调用方先 findFreeLoopbackPort() 拿一个建议端口（OS 分配，随机、冲突窗口极小）；
//   2. spawn 子进程（windowsHide: true），把端口作为参数传给启动脚本；
//   3. 子进程在端口**真正绑定后**向 stdout 打印一行 `REAL_PORT_FOUND:{port}`；
//   4. 本模块逐行解析 stdout（容忍脏输出：进度条/警告/其他日志行一律跳过），
//      第一个合法握手行 resolve `ready`；此后 stdout 只排水防背压。
//   5. 退出原因分类（退出原因 是本模块的交付物之一）：
//      spawn-failed / handshake-timeout / exited-before-ready / clean-exit / crashed / killed。
//
// Windows 杀进程用 `taskkill /PID x /T /F` 树杀：GPT-SoVITS 启动器可能再 fork
// Python 子进程，只杀直接子进程会留孤儿（P3B-05 验收「app quit 无孤儿 Python」）。
//
// 编码/中文路径（任务行反模式）：Node spawn 参数经 CreateProcess 走 UTF-16，
// 中文安装路径原样可达 Python（sys.argv 宽字符）；握手行是纯 ASCII，
// stdout 解码对它无歧义。stderr 只做有界环形缓冲供诊断，不整段入日志。

import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import type { Logger } from '@shared/observability/types'

/** 握手行：`REAL_PORT_FOUND:{port}`，允许行尾空白/CRLF。 */
const HANDSHAKE_LINE = /^REAL_PORT_FOUND:(\d{1,5})\s*$/
const MAX_STDERR_LINES = 20
const KILL_WAIT_MS = 5_000

export type LocalProcessExitReason =
  | { readonly kind: 'spawn-failed'; readonly error: string }
  | { readonly kind: 'handshake-timeout'; readonly timeoutMs: number }
  | {
      readonly kind: 'exited-before-ready'
      readonly exitCode: number | null
      readonly signal: string | null
    }
  | { readonly kind: 'clean-exit'; readonly exitCode: number | null }
  | { readonly kind: 'crashed'; readonly exitCode: number | null; readonly signal: string | null }
  | { readonly kind: 'killed'; readonly reason: string }

export interface LocalServiceProcess {
  readonly pid: number | undefined
  /** 握手成功后 resolve 实际端口；启动失败（含超时/提前退出/spawn 失败）reject。 */
  readonly ready: Promise<number>
  /** 进程退出（含启动失败与被 kill）；once 语义。 */
  readonly exited: Promise<LocalProcessExitReason>
  /** 当前退出原因；未退出为 null。 */
  exitReason(): LocalProcessExitReason | null
  /** stderr 尾部有界快照（诊断用，最多 20 行）。 */
  stderrTail(): readonly string[]
  /** 树杀并等待退出。幂等；reason 记入退出原因。 */
  kill(reason: string): Promise<void>
}

/** OS 分配一个空闲的 127.0.0.1 端口（listen(0) 后读回再关闭；存在极小竞争窗口）。 */
export function findFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : null
      server.close(() => {
        if (port === null) reject(new Error('failed to allocate loopback port'))
        else resolve(port)
      })
    })
  })
}

export interface StartLocalServiceOptions {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  /** 不传则继承父进程环境（Python 需要自己的 PATH/conda 环境）。 */
  readonly env?: NodeJS.ProcessEnv
  /** 握手超时；GPT-SoVITS 首次加载模型可达分钟级，由调用方（P3B-05）定值。 */
  readonly handshakeTimeoutMs: number
  readonly logger: Logger
}

/** 解析一行 stdout；返回端口号或 null。导出供单测直接验证脏行处理。 */
export function parseHandshakeLine(line: string): number | null {
  const trimmed = line.replace(/^\uFEFF/, '').trim()
  const match = HANDSHAKE_LINE.exec(trimmed)
  if (match === null) return null
  const port = Number.parseInt(match[1] ?? '', 10)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
  return port
}

export function startLocalServiceProcess(options: StartLocalServiceOptions): LocalServiceProcess {
  const child: ChildProcess = spawn(options.command, options.args, {
    windowsHide: true,
    cwd: options.cwd,
    env: options.env
  })

  let exitReason: LocalProcessExitReason | null = null
  let handshakePort: number | null = null
  let killedReason: string | null = null
  let stdoutRest = ''
  const stderrLines: string[] = []

  let settleReady!: (port: number) => void
  let rejectReady!: (reason: LocalProcessExitReason) => void
  let settleExited!: (reason: LocalProcessExitReason) => void
  const ready = new Promise<number>((resolve, reject) => {
    settleReady = resolve
    rejectReady = reject
  })
  const exited = new Promise<LocalProcessExitReason>((resolve) => {
    settleExited = resolve
  })

  function finalize(reason: LocalProcessExitReason): void {
    if (exitReason !== null) return
    exitReason = reason
    if (handshakePort === null) rejectReady(reason)
    settleExited(reason)
  }

  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    if (handshakePort !== null) return // 已握手：只排水，不再解析
    stdoutRest += chunk
    let newlineIndex = stdoutRest.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = stdoutRest.slice(0, newlineIndex)
      stdoutRest = stdoutRest.slice(newlineIndex + 1)
      const port = parseHandshakeLine(line)
      if (port !== null) {
        handshakePort = port
        clearTimeout(handshakeTimer)
        settleReady(port)
        // 把残余 stdout 排干即可，不解析
        return
      }
      newlineIndex = stdoutRest.indexOf('\n')
    }
  })

  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => {
    for (const line of chunk.split('\n')) {
      if (line.trim().length === 0) continue
      stderrLines.push(line.trimEnd())
      if (stderrLines.length > MAX_STDERR_LINES) stderrLines.shift()
    }
  })

  const handshakeTimer = setTimeout(() => {
    const reason: LocalProcessExitReason = {
      kind: 'handshake-timeout',
      timeoutMs: options.handshakeTimeoutMs
    }
    if (exitReason === null) {
      // 先置原因再杀：close 事件会把 'killed' 覆盖逻辑挡在 finalize 幂等之外
      finalize(reason)
      void kill('handshake-timeout')
    }
  }, options.handshakeTimeoutMs)

  child.once('error', (err: Error) => {
    if (exitReason === null) {
      finalize({ kind: 'spawn-failed', error: err.message })
    }
  })

  child.once('close', (code, signal) => {
    clearTimeout(handshakeTimer)
    if (exitReason !== null) return // 已定性（握手超时/被杀）
    if (killedReason !== null) {
      finalize({ kind: 'killed', reason: killedReason })
      return
    }
    if (handshakePort === null) {
      finalize({ kind: 'exited-before-ready', exitCode: code, signal: signal ?? null })
      return
    }
    if (code === 0) {
      finalize({ kind: 'clean-exit', exitCode: code })
    } else {
      finalize({ kind: 'crashed', exitCode: code, signal: signal ?? null })
    }
  })

  async function kill(reason: string): Promise<void> {
    if (killedReason === null) killedReason = reason
    if (child.exitCode !== null || child.signalCode !== null) return
    if (child.pid === undefined) return
    if (process.platform === 'win32') {
      // 树杀：/T 连同启动器 fork 的 Python 子进程一起终结，不留孤儿
      await new Promise<void>((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true
        })
        killer.once('error', () => resolve())
        killer.once('close', () => resolve())
      })
    } else {
      child.kill('SIGTERM')
    }
    // 等真正退出；超时则放弃等待（进程已收到 kill，close 迟早会来）
    const deadline = Date.now() + KILL_WAIT_MS
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (child.exitCode === null && child.signalCode === null) {
      options.logger.warn('local service process did not exit after kill', {
        scope: 'tts',
        metrics: { killWaitMs: KILL_WAIT_MS }
      })
    }
  }

  return {
    pid: child.pid,
    ready,
    exited,
    exitReason: () => exitReason,
    stderrTail: () => [...stderrLines],
    kill
  }
}
