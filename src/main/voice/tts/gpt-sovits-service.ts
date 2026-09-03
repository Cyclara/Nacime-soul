// src/main/voice/tts/gpt-sovits-service.ts
// P3B-05：GPT-SoVITS 本地服务管理器--进程生命周期 + health check + 有界自动重启 +
// shutdown + loopback 精确 origin 注册。
//
// 职责边界：
//   - 本模块管「服务进程」的生老病死（跨 turn 常驻）；P3B-06 的 turn-bound provider
//     只消费 ensureReady() 给出的 baseUrl，不管进程。
//   - 进程层协议（spawn/握手/退出原因）全部委托 local-process.ts（P3B-04）；
//     本模块注入 spawnService 以便测试用假进程驱动（不真起 Python）。
//   - HTTP 探测注入：生产接线必须传 createSecureFetch 产物（携带 LocalServiceOriginRegistry
//     的 NetworkPolicyOptions），健康探测同样不许绕过网络策略。
//
// 有界自动重启（验收「连续故障不重启风暴」）两条独立预算：
//   1. 连续启动失败（握手超时/提前退出）>= maxConsecutiveStartFailures -> failed，不再尝试；
//   2. 就绪后退出（崩溃/健康判死杀掉）在 restartWindowMs 滑窗内 > maxRestartsInWindow -> failed。
//   failed 是本会话终态（降级纯文字），直到 reset()（设置开关重arm）或重启应用。
//
// Health check：GPT-SoVITS api_v2 没有 /health 端点（实测本地克隆只有 /tts /control
// /set_gpt_weights /set_sovits_weights）；GET / 会得到 FastAPI 404，但**任何 HTTP 应答
// 都证明 HTTP 服务活着**，真死表现为 ECONNREFUSED/超时。连续 healthFailureThreshold
// 次失败 -> kill -> 走正常崩溃重启预算。
//
// shutdown：taskkill 树杀（local-process.kill）+ origin 出册 + 定时器清理，幂等；
// app quit 时调用，不留孤儿 Python。

import { AppError } from '@shared/errors'
import type { Logger } from '@shared/observability/types'
import type { LocalServiceOriginRegistry } from '../../security/network-policy'
import {
  findFreeLoopbackPort,
  startLocalServiceProcess,
  type LocalProcessExitReason,
  type LocalServiceProcess
} from './local-process'

export type GptSovitsServiceState = 'idle' | 'starting' | 'running' | 'failed' | 'stopped'

export interface GptSovitsServiceOptions {
  /** Python 可执行文件（或绝对路径）。 */
  readonly command: string
  /** 端口以参数形式传给启动脚本，由调用方决定具体形制。 */
  readonly buildArgs: (port: number) => readonly string[]
  readonly cwd?: string
  readonly env?: NodeJS.ProcessEnv
  /** 启动超时 = 握手超时；GPT-SoVITS 首次加载模型可达分钟级，由接线层定值。 */
  readonly handshakeTimeoutMs: number
  readonly healthIntervalMs: number
  readonly healthTimeoutMs: number
  readonly maxConsecutiveStartFailures: number
  readonly maxRestartsInWindow: number
  readonly restartWindowMs: number
  readonly healthFailureThreshold: number
  /** 重启退避基数（线性 * 次数）与上限。 */
  readonly restartBackoffBaseMs: number
  readonly restartBackoffMaxMs: number
}

export interface GptSovitsServiceDeps {
  readonly logger: Logger
  readonly originRegistry: LocalServiceOriginRegistry
  /** 探测用 fetch：生产必须传 createSecureFetch 产物（过网络策略），测试传假实现。 */
  readonly fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<unknown>
  readonly spawnService?: (port: number) => LocalServiceProcess
  readonly findPort?: () => Promise<number>
  readonly now?: () => number
}

export interface GptSovitsService {
  state(): GptSovitsServiceState
  /** 当前服务 origin（http://127.0.0.1:{port}）；非 running 时为 null。 */
  baseUrl(): string | null
  /** 幂等启动并等待就绪；failed/stopped 抛 AppError(TTS_ENGINE_DOWN)。 */
  ensureReady(): Promise<string>
  /** 单次健康探测（不触发重启逻辑）；供 provider health() 消费。 */
  checkHealth(): Promise<boolean>
  /** 本会话累计自动重启次数（诊断用）。 */
  restartCount(): number
  /**
   * /tts 推理占用服务时的忙碌账本。官方 api_v2 单 worker 在 GPU 推理期间可能不响应
   * GET /；health loop 必须跳过忙碌期，不能把「正在合成」误杀成假死。引用计数防御未来并发。
   */
  beginSynthesis(): void
  endSynthesis(): void
  /** failed -> idle：清空预算计数，允许下一次 ensureReady 重试（设置开关重arm路径）。 */
  reset(): void
  /** app quit / 用户关闭语音：树杀进程、origin 出册、停定时器。幂等。 */
  shutdown(): Promise<void>
}

function originOf(port: number): string {
  return `http://127.0.0.1:${port}`
}

export function createGptSovitsService(
  options: GptSovitsServiceOptions,
  deps: GptSovitsServiceDeps
): GptSovitsService {
  const now = deps.now ?? Date.now
  const findPort = deps.findPort ?? findFreeLoopbackPort
  const spawnService =
    deps.spawnService ??
    ((port: number) =>
      startLocalServiceProcess({
        command: options.command,
        args: options.buildArgs(port),
        cwd: options.cwd,
        env: options.env,
        handshakeTimeoutMs: options.handshakeTimeoutMs,
        logger: deps.logger
      }))

  let state: GptSovitsServiceState = 'idle'
  let current: LocalServiceProcess | null = null
  let currentPort: number | null = null
  let startPromise: Promise<string> | null = null
  let consecutiveStartFailures = 0
  let healthFailures = 0
  let activeSyntheses = 0
  let totalRestarts = 0
  let shutDown = false
  const restartTimestamps: number[] = []
  let healthTimer: ReturnType<typeof setInterval> | null = null
  let restartTimer: ReturnType<typeof setTimeout> | null = null

  function stopHealthLoop(): void {
    if (healthTimer !== null) {
      clearInterval(healthTimer)
      healthTimer = null
    }
  }

  function clearRestartTimer(): void {
    if (restartTimer !== null) {
      clearTimeout(restartTimer)
      restartTimer = null
    }
  }

  function scheduleRestart(reason: string): void {
    if (restartTimer !== null || shutDown) return
    totalRestarts++
    const attempt = Math.max(1, consecutiveStartFailures, restartTimestamps.length)
    const delay = Math.min(options.restartBackoffBaseMs * attempt, options.restartBackoffMaxMs)
    deps.logger.warn('gpt-sovits service restart scheduled', {
      scope: 'tts',
      tags: { provider: 'gpt-sovits', reason },
      metrics: { delayMs: delay, restartCount: totalRestarts }
    })
    restartTimer = setTimeout(() => {
      restartTimer = null
      if (state === 'idle' && !shutDown) {
        void start().catch(() => {
          /* 失败已在 performStart 内记账；后台重试不打断任何人 */
        })
      }
    }, delay)
  }

  function pruneRestartWindow(timestamp: number): void {
    while (
      restartTimestamps.length > 0 &&
      restartTimestamps[0]! < timestamp - options.restartWindowMs
    ) {
      restartTimestamps.shift()
    }
  }

  function failPermanently(reason: string, metrics: Record<string, number>): void {
    state = 'failed'
    stopHealthLoop()
    deps.logger.error('gpt-sovits service failed permanently; degrading to text-only', {
      scope: 'tts',
      tags: { provider: 'gpt-sovits', reason },
      metrics
    })
  }

  async function performStart(): Promise<string> {
    state = 'starting'
    const port = await findPort()
    const proc = spawnService(port)
    current = proc
    try {
      const readyPort = await proc.ready
      if (!deps.originRegistry.register(originOf(readyPort))) {
        // 理论不可达（握手端口已过 1-65535 校验）；防御性处理
        throw new Error(`origin registry rejected ${originOf(readyPort)}`)
      }
      currentPort = readyPort
      consecutiveStartFailures = 0
      healthFailures = 0
      state = 'running'
      void watchExit(proc)
      startHealthLoop()
      deps.logger.info('gpt-sovits service ready', {
        scope: 'tts',
        tags: { provider: 'gpt-sovits' },
        metrics: { port: readyPort }
      })
      return originOf(readyPort)
    } catch (err) {
      current = null
      await proc.kill('start-failed').catch(() => {
        /* best-effort：进程可能已自行退出 */
      })
      if (shutDown) {
        state = 'stopped'
      } else {
        consecutiveStartFailures++
        if (consecutiveStartFailures >= options.maxConsecutiveStartFailures) {
          failPermanently('consecutive-start-failures', {
            failures: consecutiveStartFailures
          })
        } else {
          state = 'idle'
          scheduleRestart('start-failure')
        }
      }
      throw new AppError({
        code: 'TTS_ENGINE_DOWN',
        userMessage: '语音服务未能启动，本轮改为纯文字。',
        severity: 'error',
        retryable: true,
        cause: err instanceof Error ? err : new Error(String(err))
      })
    }
  }

  function start(): Promise<string> {
    if (state === 'running' && currentPort !== null) return Promise.resolve(originOf(currentPort))
    if (state === 'failed' || state === 'stopped') {
      return Promise.reject(
        new AppError({
          code: 'TTS_ENGINE_DOWN',
          userMessage: '语音服务当前不可用，本轮改为纯文字。',
          severity: 'error',
          retryable: false,
          cause: new Error(`gpt-sovits service state: ${state}`)
        })
      )
    }
    if (startPromise !== null) return startPromise
    clearRestartTimer()
    startPromise = performStart().finally(() => {
      startPromise = null
    })
    return startPromise
  }

  async function watchExit(proc: LocalServiceProcess): Promise<void> {
    const reason: LocalProcessExitReason = await proc.exited
    if (current !== proc) return // 已被新一轮 start 替换，迟到事件丢弃
    current = null
    if (currentPort !== null) {
      deps.originRegistry.unregister(originOf(currentPort))
      currentPort = null
    }
    stopHealthLoop()
    if (shutDown) {
      state = 'stopped'
      return
    }
    const timestamp = now()
    restartTimestamps.push(timestamp)
    pruneRestartWindow(timestamp)
    if (restartTimestamps.length > options.maxRestartsInWindow) {
      failPermanently('restart-budget-exhausted', {
        restarts: restartTimestamps.length,
        windowMs: options.restartWindowMs
      })
      return
    }
    state = 'idle'
    scheduleRestart(`process-exit-${reason.kind}`)
  }

  async function probe(): Promise<boolean> {
    if (currentPort === null) return false
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options.healthTimeoutMs)
    try {
      // api_v2 无 /health：404 也是「活着」；死 = fetch 抛错（ECONNREFUSED/超时/中止）
      await deps.fetch(`${originOf(currentPort)}/`, { signal: controller.signal })
      return true
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  function startHealthLoop(): void {
    stopHealthLoop()
    healthTimer = setInterval(() => {
      void runHealthCheck().catch((err: unknown) => {
        // kill/探测的意外异常不能变成未处理 rejection
        deps.logger.warn('gpt-sovits health check loop error', {
          scope: 'tts',
          tags: { provider: 'gpt-sovits' },
          detail: err instanceof Error ? err.message : String(err)
        })
      })
    }, options.healthIntervalMs)
  }

  async function runHealthCheck(): Promise<void> {
    if (state !== 'running' || current === null || currentPort === null) return
    // 官方 api_v2 的同步 GPU 推理会占住唯一 worker，推理期间 GET / 也可能超时。
    // provider 自己有 requestTimeout；health 在 busy 期间跳过，推理结束后再恢复探测。
    if (activeSyntheses > 0) return
    const alive = await probe()
    if (state !== 'running' || current === null) return // 探测期间状态已变
    if (alive) {
      healthFailures = 0
      return
    }
    healthFailures++
    if (healthFailures >= options.healthFailureThreshold) {
      deps.logger.warn('gpt-sovits health check failed repeatedly; killing for restart', {
        scope: 'tts',
        tags: { provider: 'gpt-sovits' },
        metrics: { failures: healthFailures }
      })
      healthFailures = 0
      const proc = current
      await proc.kill('health-check-failed') // watchExit 接手重启预算与调度
    }
  }

  return {
    state: () => state,
    baseUrl: () => (state === 'running' && currentPort !== null ? originOf(currentPort) : null),
    ensureReady: () => start(),
    checkHealth: () => probe(),
    restartCount: () => totalRestarts,
    beginSynthesis() {
      activeSyntheses += 1
    },
    endSynthesis() {
      activeSyntheses = Math.max(0, activeSyntheses - 1)
    },
    reset() {
      if (state !== 'failed') return
      state = 'idle'
      consecutiveStartFailures = 0
      restartTimestamps.length = 0
      deps.logger.info('gpt-sovits service reset from failed; next ensureReady will retry', {
        scope: 'tts',
        tags: { provider: 'gpt-sovits' }
      })
    },
    async shutdown() {
      if (state === 'stopped') return
      shutDown = true
      stopHealthLoop()
      clearRestartTimer()
      const proc = current
      if (proc !== null) {
        await proc.kill('app-quit') // taskkill 树杀，无孤儿 Python
      }
      current = null
      activeSyntheses = 0
      if (currentPort !== null) {
        deps.originRegistry.unregister(originOf(currentPort))
        currentPort = null
      }
      state = 'stopped'
      deps.logger.info('gpt-sovits service shut down', {
        scope: 'tts',
        tags: { provider: 'gpt-sovits' }
      })
    }
  }
}
