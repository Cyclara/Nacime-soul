// src/main/voice/tts/gpt-sovits-service.test.ts
// P3B-05：GPT-SoVITS 服务管理器合同。进程层全部注入假 LocalServiceProcess
// （真 spawn 协议已在 local-process.test.ts 用假 Node 子进程覆盖）；覆盖验收：
// 连续故障不重启风暴 / app quit 无孤儿（kill 调用与出册）/ loopback origin 注册。

import { describe, expect, it } from 'vitest'
import type { Logger } from '@shared/observability/types'
import { createLocalServiceOriginRegistry } from '../../security/network-policy'
import type { LocalProcessExitReason, LocalServiceProcess } from './local-process'
import { createGptSovitsService, type GptSovitsServiceOptions } from './gpt-sovits-service'

function noopLogger(): Logger {
  const l: Logger = {
    fatal() {
      /* noop */
    },
    error() {
      /* noop */
    },
    warn() {
      /* noop */
    },
    info() {
      /* noop */
    },
    debug() {
      /* noop */
    },
    child: () => l
  }
  return l
}

const BASE_OPTIONS: GptSovitsServiceOptions = {
  command: 'python',
  buildArgs: (port) => ['-u', 'api_v2.py', '-a', '127.0.0.1', '-p', String(port)],
  handshakeTimeoutMs: 500,
  healthIntervalMs: 10,
  healthTimeoutMs: 50,
  maxConsecutiveStartFailures: 3,
  maxRestartsInWindow: 5,
  restartWindowMs: 10_000,
  healthFailureThreshold: 3,
  restartBackoffBaseMs: 10,
  restartBackoffMaxMs: 50
}

interface FakeProc {
  proc: LocalServiceProcess
  resolveReady: (port: number) => void
  rejectReady: (reason: LocalProcessExitReason) => void
  emitExit: (reason: LocalProcessExitReason) => void
  killReasons: string[]
}

function makeFakeProc(): FakeProc {
  let resolveReady!: (port: number) => void
  let rejectReady!: (reason: LocalProcessExitReason) => void
  let emitExit!: (reason: LocalProcessExitReason) => void
  const killReasons: string[] = []
  let exitReason: LocalProcessExitReason | null = null
  const ready = new Promise<number>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const exited = new Promise<LocalProcessExitReason>((resolve) => {
    emitExit = resolve
  })
  const proc: LocalServiceProcess = {
    pid: 4321,
    ready,
    exited,
    exitReason: () => exitReason,
    stderrTail: () => [],
    kill: async (reason: string) => {
      killReasons.push(reason)
      exitReason = { kind: 'killed', reason }
      // 真实 local-process 的 kill 会导致子进程退出 -> exited resolve；fake 同步模拟之
      emitExit(exitReason)
    }
  }
  return { proc, resolveReady, rejectReady, emitExit, killReasons }
}

interface Harness {
  service: ReturnType<typeof createGptSovitsService>
  registry: ReturnType<typeof createLocalServiceOriginRegistry>
  procs: FakeProc[]
  spawnCalls: number[]
  setNow: (ms: number) => void
}

function makeHarness(
  opts?: Partial<GptSovitsServiceOptions>,
  fetchImpl?: (url: string, init?: { signal?: AbortSignal }) => Promise<unknown>
): Harness {
  const registry = createLocalServiceOriginRegistry()
  const procs: FakeProc[] = []
  const spawnCalls: number[] = []
  let fakeNow = 0
  const service = createGptSovitsService(
    { ...BASE_OPTIONS, ...opts },
    {
      logger: noopLogger(),
      originRegistry: registry,
      fetch:
        fetchImpl ??
        (async () => {
          throw new Error('fetch not configured for this test')
        }),
      spawnService: (port: number) => {
        spawnCalls.push(port)
        const fake = makeFakeProc()
        procs.push(fake)
        return fake.proc
      },
      findPort: async () => 20_000 + spawnCalls.length,
      now: () => fakeNow
    }
  )
  return { service, registry, procs, spawnCalls, setNow: (ms) => (fakeNow = ms) }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 等到第 n 个 spawn 发生（重启调度有退避）。 */
async function waitForSpawn(procs: FakeProc[], n: number, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (procs.length < n && Date.now() < deadline) await sleep(5)
  expect(procs.length).toBeGreaterThanOrEqual(n)
}

const CRASH: LocalProcessExitReason = { kind: 'crashed', exitCode: 1, signal: null }
const START_FAIL: LocalProcessExitReason = { kind: 'handshake-timeout', timeoutMs: 500 }

describe('P3B-05 GPT-SoVITS 服务：启动与就绪', () => {
  it('ensureReady -> running：origin 注册、baseUrl 可用、并发去重为一次 spawn', async () => {
    const h = makeHarness({}, async () => ({ status: 404 }))
    const first = h.service.ensureReady()
    const second = h.service.ensureReady()
    await sleep(5)
    expect(h.procs.length).toBe(1)
    h.procs[0]!.resolveReady(20_001)
    await expect(first).resolves.toBe('http://127.0.0.1:20001')
    await expect(second).resolves.toBe('http://127.0.0.1:20001')
    expect(h.service.state()).toBe('running')
    expect(h.service.baseUrl()).toBe('http://127.0.0.1:20001')
    expect(h.registry.has('http://127.0.0.1:20001')).toBe(true)
    expect(await h.service.checkHealth()).toBe(true) // 404 也算活着
  })

  it('就绪后再次 ensureReady 直接返回，不重复 spawn', async () => {
    const h = makeHarness()
    const pending = h.service.ensureReady()
    await sleep(5)
    h.procs[0]!.resolveReady(20_001)
    await pending
    await expect(h.service.ensureReady()).resolves.toBe('http://127.0.0.1:20001')
    expect(h.spawnCalls.length).toBe(1)
  })
})

describe('P3B-05 GPT-SoVITS 服务：启动失败与有界重试', () => {
  it('单次启动失败：本轮抛 TTS_ENGINE_DOWN，退避后自动重试成功', async () => {
    const h = makeHarness()
    const pending = h.service.ensureReady()
    await sleep(5)
    h.procs[0]!.rejectReady(START_FAIL)
    await expect(pending).rejects.toMatchObject({ code: 'TTS_ENGINE_DOWN' })
    expect(h.procs[0]!.killReasons).toContain('start-failed')
    expect(h.service.state()).toBe('idle')

    await waitForSpawn(h.procs, 2)
    h.procs[1]!.resolveReady(20_002)
    await sleep(5)
    expect(h.service.state()).toBe('running')
    expect(h.registry.has('http://127.0.0.1:20002')).toBe(true)
  })

  it('连续启动失败达到上限 -> failed 永久放弃，不再形成重启风暴', async () => {
    const h = makeHarness({ maxConsecutiveStartFailures: 3, restartBackoffBaseMs: 5 })
    const pending = h.service.ensureReady()
    await sleep(5)
    h.procs[0]!.rejectReady(START_FAIL)
    await expect(pending).rejects.toMatchObject({ code: 'TTS_ENGINE_DOWN' })

    // 后台自动重试 2 次，全部失败
    await waitForSpawn(h.procs, 2)
    h.procs[1]!.rejectReady(START_FAIL)
    await waitForSpawn(h.procs, 3)
    h.procs[2]!.rejectReady(START_FAIL)
    await sleep(60)

    expect(h.service.state()).toBe('failed')
    expect(h.spawnCalls.length).toBe(3) // 上限之后不再有第 4 次 spawn
    await expect(h.service.ensureReady()).rejects.toMatchObject({
      code: 'TTS_ENGINE_DOWN',
      retryable: false
    })
  })

  it('reset() 后从 failed 回到 idle，下一次 ensureReady 重新尝试', async () => {
    const h = makeHarness({ maxConsecutiveStartFailures: 1, restartBackoffBaseMs: 5 })
    const pending = h.service.ensureReady()
    await sleep(5)
    h.procs[0]!.rejectReady(START_FAIL)
    await expect(pending).rejects.toMatchObject({ code: 'TTS_ENGINE_DOWN' })
    await sleep(20)
    expect(h.service.state()).toBe('failed')

    h.service.reset()
    expect(h.service.state()).toBe('idle')
    const retry = h.service.ensureReady()
    await sleep(5)
    expect(h.procs.length).toBe(2)
    h.procs[1]!.resolveReady(20_002)
    await expect(retry).resolves.toBe('http://127.0.0.1:20002')
  })
})

describe('P3B-05 GPT-SoVITS 服务：崩溃自动重启（有界）', () => {
  it('就绪后崩溃：origin 出册、按退避重启、计数累加', async () => {
    // 退避拉长，断言窗口内不会误触发重启（避免用例数变多后的计时抖动）
    const h = makeHarness({ restartBackoffBaseMs: 200, restartBackoffMaxMs: 500 })
    const pending = h.service.ensureReady()
    await sleep(5)
    h.procs[0]!.resolveReady(20_001)
    await pending

    h.procs[0]!.emitExit(CRASH)
    await sleep(5)
    expect(h.service.state()).toBe('idle')
    expect(h.registry.has('http://127.0.0.1:20001')).toBe(false)

    await waitForSpawn(h.procs, 2)
    h.procs[1]!.resolveReady(20_002)
    await sleep(5)
    expect(h.service.state()).toBe('running')
    expect(h.service.restartCount()).toBe(1)
    expect(h.registry.has('http://127.0.0.1:20002')).toBe(true)
  })

  it('滑窗内重启超过预算 -> failed，spawn 总数有界（不重启风暴）', async () => {
    const h = makeHarness({ maxRestartsInWindow: 2, restartBackoffBaseMs: 5 })
    const pending = h.service.ensureReady()
    await sleep(5)
    h.procs[0]!.resolveReady(20_001)
    await pending

    // 3 次崩溃：前 2 次在预算内重启，第 3 次击穿 -> failed
    h.procs[0]!.emitExit(CRASH)
    await waitForSpawn(h.procs, 2)
    h.procs[1]!.resolveReady(20_002)
    await sleep(5)
    h.procs[1]!.emitExit(CRASH)
    await waitForSpawn(h.procs, 3)
    h.procs[2]!.resolveReady(20_003)
    await sleep(5)
    h.procs[2]!.emitExit(CRASH)
    await sleep(80)

    expect(h.service.state()).toBe('failed')
    expect(h.spawnCalls.length).toBe(3) // 初始 1 + 预算内重启 2，之后不再 spawn
  })

  it('旧进程迟到退出事件不影响新一轮服务', async () => {
    const h = makeHarness()
    const pending = h.service.ensureReady()
    await sleep(5)
    h.procs[0]!.resolveReady(20_001)
    await pending
    h.procs[0]!.emitExit(CRASH)
    await waitForSpawn(h.procs, 2)
    h.procs[1]!.resolveReady(20_002)
    await sleep(5)

    // 旧进程（procs[0]）的 exited 已消费过一次；此处模拟更旧迟到事件无副作用
    h.procs[0]!.emitExit(CRASH)
    await sleep(10)
    expect(h.service.state()).toBe('running')
    expect(h.service.baseUrl()).toBe('http://127.0.0.1:20002')
  })
})

describe('P3B-05 GPT-SoVITS 服务：健康检查', () => {
  it('连续探测失败达到阈值 -> kill 判死并按崩溃预算重启', async () => {
    const h = makeHarness({ healthFailureThreshold: 2, healthIntervalMs: 10 }, async () => {
      throw new Error('ECONNREFUSED')
    })
    const pending = h.service.ensureReady()
    await sleep(5)
    h.procs[0]!.resolveReady(20_001)
    await pending

    await waitForSpawn(h.procs, 2, 1_500) // 健康判死 -> kill -> 重启
    expect(h.procs[0]!.killReasons).toContain('health-check-failed')
    h.procs[1]!.resolveReady(20_002)
    await sleep(5)
    expect(h.service.state()).toBe('running')
  })

  it('GPU 合成忙碌期间跳过健康探测，不把单 worker 阻塞误判成假死', async () => {
    let probes = 0
    const h = makeHarness({ healthFailureThreshold: 2, healthIntervalMs: 10 }, async () => {
      probes++
      throw new Error('api worker busy')
    })
    const pending = h.service.ensureReady()
    await sleep(5)
    h.procs[0]!.resolveReady(20_001)
    await pending

    h.service.beginSynthesis()
    await sleep(80) // 远超 2 次 interval；busy 期间一次 probe 都不应发
    expect(probes).toBe(0)
    expect(h.procs[0]!.killReasons).toEqual([])
    expect(h.service.state()).toBe('running')

    h.service.endSynthesis()
    await waitForSpawn(h.procs, 2, 1_500) // 空闲后恢复探测，连续失败才判死重启
    expect(probes).toBeGreaterThanOrEqual(2)
    expect(h.procs[0]!.killReasons).toContain('health-check-failed')
  })

  it('健康恢复即清零连续失败计数（不误杀抖动）', async () => {
    let failNext = 1 // 第 1 次失败，之后成功；阈值 3 不应触发 kill
    const h = makeHarness({ healthFailureThreshold: 3, healthIntervalMs: 10 }, async () => {
      if (failNext > 0) {
        failNext--
        throw new Error('flaky')
      }
      return { status: 200 }
    })
    const pending = h.service.ensureReady()
    await sleep(5)
    h.procs[0]!.resolveReady(20_001)
    await pending
    await sleep(120)
    expect(h.service.state()).toBe('running')
    expect(h.procs[0]!.killReasons).toEqual([])
    expect(h.spawnCalls.length).toBe(1)
  })
})

describe('P3B-05 GPT-SoVITS 服务：shutdown', () => {
  it('树杀 + origin 出册 + stopped；幂等；之后 ensureReady 明确拒绝', async () => {
    const h = makeHarness()
    const pending = h.service.ensureReady()
    await sleep(5)
    h.procs[0]!.resolveReady(20_001)
    await pending

    await h.service.shutdown()
    expect(h.procs[0]!.killReasons).toContain('app-quit')
    expect(h.registry.has('http://127.0.0.1:20001')).toBe(false)
    expect(h.service.state()).toBe('stopped')

    await h.service.shutdown() // 幂等
    expect(h.procs[0]!.killReasons.length).toBe(1)
    await expect(h.service.ensureReady()).rejects.toMatchObject({ code: 'TTS_ENGINE_DOWN' })
  })

  it('启动中 shutdown：中断本次启动且不计入失败预算', async () => {
    const h = makeHarness({ maxConsecutiveStartFailures: 1 })
    const pending = h.service.ensureReady()
    await sleep(5)
    await h.service.shutdown()
    h.procs[0]!.rejectReady(START_FAIL)
    await expect(pending).rejects.toMatchObject({ code: 'TTS_ENGINE_DOWN' })
    await sleep(30)
    expect(h.service.state()).toBe('stopped')
    expect(h.spawnCalls.length).toBe(1) // 不因 shutdown 触发重试
  })
})
