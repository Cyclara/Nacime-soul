// src/main/observability/stream-error-tolerance.test.ts
// M-35：stdout/stderr 写入失败容忍——'error' 事件被吞掉，不升级 uncaughtException。
import { describe, it, expect, vi } from 'vitest'
import { installStreamErrorTolerance, type ErrorTolerantStream } from './stream-error-tolerance'

type ErrorListener = (error: Error & { code?: string }) => void

function makeFakeStream(): ErrorTolerantStream & { emit(error: Error & { code?: string }): void } {
  const listeners: ErrorListener[] = []
  return {
    on(event: string, listener: ErrorListener) {
      expect(event).toBe('error')
      listeners.push(listener)
    },
    emit(error) {
      for (const l of listeners) l(error)
    }
  }
}

describe('M-35 installStreamErrorTolerance', () => {
  it('吞掉 EPIPE 错误事件（不抛出、不升级），回调通知一次', () => {
    const stdout = makeFakeStream()
    const stderr = makeFakeStream()
    const onFirst = vi.fn()
    installStreamErrorTolerance([stdout, stderr], onFirst)

    // 有监听 = Node 不把 'error' 升级为 uncaughtException；emit 本身不抛
    expect(() =>
      stdout.emit(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    ).not.toThrow()
    expect(onFirst).toHaveBeenCalledTimes(1)
    expect(onFirst).toHaveBeenCalledWith('EPIPE')
  })

  it('后续错误静默吞掉，不再重复通知（日志路径自己打转转的防护）', () => {
    const stdout = makeFakeStream()
    const onFirst = vi.fn()
    installStreamErrorTolerance([stdout], onFirst)

    stdout.emit(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    stdout.emit(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    stdout.emit(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    expect(onFirst).toHaveBeenCalledTimes(1)
  })

  it('stderr 与 stdout 共享同一次通知（先触发者留痕）', () => {
    const stdout = makeFakeStream()
    const stderr = makeFakeStream()
    const onFirst = vi.fn()
    installStreamErrorTolerance([stdout, stderr], onFirst)

    stderr.emit(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    stdout.emit(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    expect(onFirst).toHaveBeenCalledTimes(1)
  })

  it('错误对象无 code 时回退 UNKNOWN', () => {
    const stdout = makeFakeStream()
    const onFirst = vi.fn()
    installStreamErrorTolerance([stdout], onFirst)

    stdout.emit(new Error('some stream error'))
    expect(onFirst).toHaveBeenCalledWith('UNKNOWN')
  })

  it('无回调时纯吞掉，不抛错', () => {
    const stdout = makeFakeStream()
    installStreamErrorTolerance([stdout])
    expect(() => stdout.emit(Object.assign(new Error('x'), { code: 'EPIPE' }))).not.toThrow()
  })
})
