// src/main/voice/tts/local-process.test.ts
// P3B-04：本地 API 子进程协议合同。用真 spawn 的假 Node 子进程驱动
// （ELECTRON_RUN_AS_NODE=1 让 electron 二进制以纯 node 行为跑 -e 脚本），
// 覆盖验收四场景：假进程正常 / 超时 / 脏 stdout / 提前退出，外加
// 退出原因分类、kill 幂等与 stderr 有界快照。不碰真实 Python/端口绑定。

import { describe, expect, it } from 'vitest'
import type { Logger } from '@shared/observability/types'
import {
  findFreeLoopbackPort,
  parseHandshakeLine,
  startLocalServiceProcess,
  type StartLocalServiceOptions
} from './local-process'

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

/**
 * 用当前可执行文件（electron 二进制）当假子进程：ELECTRON_RUN_AS_NODE=1 使其以纯
 * node 行为执行 -e 脚本；纯 node 环境下该变量无害。
 */
function fakeService(script: string, timeoutMs = 3_000): StartLocalServiceOptions {
  return {
    command: process.execPath,
    args: ['-e', script],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    handshakeTimeoutMs: timeoutMs,
    logger: noopLogger()
  }
}

describe('P3B-04 parseHandshakeLine（纯函数）', () => {
  it('合法行解析端口；脏行全部拒绝', () => {
    expect(parseHandshakeLine('REAL_PORT_FOUND:54321')).toBe(54_321)
    expect(parseHandshakeLine('REAL_PORT_FOUND:54321\r')).toBe(54_321)
    expect(parseHandshakeLine('REAL_PORT_FOUND: 54321 ')).toBeNull()
    expect(parseHandshakeLine('REAL_PORT_FOUND:abc')).toBeNull()
    expect(parseHandshakeLine('REAL_PORT_FOUND:0')).toBeNull()
    expect(parseHandshakeLine('REAL_PORT_FOUND:99999')).toBeNull()
    expect(parseHandshakeLine('garbage REAL_PORT_FOUND:54321')).toBeNull()
    expect(parseHandshakeLine('[INFO] loading model...')).toBeNull()
    expect(parseHandshakeLine('')).toBeNull()
  })
})

describe('P3B-04 startLocalServiceProcess（真 spawn 假子进程）', () => {
  it('正常握手：脏行中夹着合法握手行也能解析，ready resolve 端口', async () => {
    const port = await findFreeLoopbackPort()
    const script = [
      `console.log('[INFO] booting...')`,
      `console.log('progress 12% REAL_PORT_FOUND:not-a-port')`,
      `console.log('REAL_PORT_FOUND:' + ${port})`,
      `setInterval(() => {}, 1000)` // 保活，模拟常驻服务
    ].join('\n')
    const proc = startLocalServiceProcess(fakeService(script))
    await expect(proc.ready).resolves.toBe(port)
    expect(proc.exitReason()).toBeNull()
    expect(proc.pid).toBeGreaterThan(0)

    await proc.kill('test-shutdown')
    expect(proc.exitReason()).toEqual({ kind: 'killed', reason: 'test-shutdown' })
    await expect(proc.exited).resolves.toEqual({ kind: 'killed', reason: 'test-shutdown' })
  }, 10_000)

  it('握手行跨 chunk 拆开仍能拼回（行缓冲）', async () => {
    const script = [
      `process.stdout.write('REAL_PORT_')`,
      `setTimeout(() => { process.stdout.write('FOUND:18745\\n'); setInterval(() => {}, 1000) }, 150)`
    ].join('\n')
    const proc = startLocalServiceProcess(fakeService(script))
    await expect(proc.ready).resolves.toBe(18_745)
    await proc.kill('test-shutdown')
  }, 10_000)

  it('握手超时：静默进程被拒绝并自动树杀', async () => {
    const script = `setInterval(() => {}, 1000)` // 永不握手
    const proc = startLocalServiceProcess(fakeService(script, 400))
    await expect(proc.ready).rejects.toEqual({ kind: 'handshake-timeout', timeoutMs: 400 })
    await expect(proc.exited).resolves.toEqual({ kind: 'handshake-timeout', timeoutMs: 400 })
  }, 10_000)

  it('提前退出：握手前非零退出码 -> exited-before-ready', async () => {
    const proc = startLocalServiceProcess(fakeService(`process.exit(3)`))
    await expect(proc.ready).rejects.toEqual({
      kind: 'exited-before-ready',
      exitCode: 3,
      signal: null
    })
  }, 10_000)

  it('spawn 失败：不存在的命令 -> spawn-failed', async () => {
    const proc = startLocalServiceProcess({
      command: 'definitely-not-a-real-command-xyz',
      args: [],
      handshakeTimeoutMs: 1_000,
      logger: noopLogger()
    })
    let caught: unknown
    try {
      await proc.ready
    } catch (err) {
      caught = err
    }
    expect((caught as { kind?: string }).kind).toBe('spawn-failed')
    await expect(proc.exited).resolves.toMatchObject({ kind: 'spawn-failed' })
  }, 10_000)

  it('握手成功后崩溃 -> ready 已 resolve、exited 判 crashed；正常退出 0 判 clean-exit', async () => {
    const crash = startLocalServiceProcess(
      fakeService(`console.log('REAL_PORT_FOUND:20001'); setTimeout(() => process.exit(1), 120)`)
    )
    await expect(crash.ready).resolves.toBe(20_001)
    await expect(crash.exited).resolves.toEqual({ kind: 'crashed', exitCode: 1, signal: null })

    const clean = startLocalServiceProcess(
      fakeService(`console.log('REAL_PORT_FOUND:20002'); setTimeout(() => process.exit(0), 120)`)
    )
    await expect(clean.ready).resolves.toBe(20_002)
    await expect(clean.exited).resolves.toEqual({ kind: 'clean-exit', exitCode: 0 })
  }, 10_000)

  it('stderr 有界快照：只保留最后 20 行供诊断', async () => {
    const script = [
      `for (let i = 1; i <= 30; i++) console.error('warn line ' + i)`,
      `console.log('REAL_PORT_FOUND:20003')`,
      `setTimeout(() => process.exit(0), 200)`
    ].join('\n')
    const proc = startLocalServiceProcess(fakeService(script))
    await expect(proc.ready).resolves.toBe(20_003)
    await expect(proc.exited).resolves.toMatchObject({ kind: 'clean-exit' })
    const tail = proc.stderrTail()
    expect(tail.length).toBe(20)
    expect(tail[0]).toBe('warn line 11')
    expect(tail[19]).toBe('warn line 30')
  }, 10_000)

  it('kill 幂等：重复调用不报错、退出原因稳定', async () => {
    const port = await findFreeLoopbackPort()
    const script = `console.log('REAL_PORT_FOUND:' + ${port}); setInterval(() => {}, 1000)`
    const proc = startLocalServiceProcess(fakeService(script))
    await expect(proc.ready).resolves.toBe(port)
    await proc.kill('first')
    await proc.kill('second')
    expect(proc.exitReason()).toEqual({ kind: 'killed', reason: 'first' })
  }, 10_000)

  it('findFreeLoopbackPort：返回 1024-65535 的可用端口', async () => {
    const port = await findFreeLoopbackPort()
    expect(port).toBeGreaterThanOrEqual(1024)
    expect(port).toBeLessThanOrEqual(65_535)
    // 立即再取一个应不冲突
    const other = await findFreeLoopbackPort()
    expect(other).toBeGreaterThan(0)
  })
})
