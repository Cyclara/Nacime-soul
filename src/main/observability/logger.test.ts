// src/main/observability/logger.test.ts
// M-35：日志写盘降级链"绝不 throw"——sink 失败降级 console，console 也失败时哑火。
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createLogger, type LogSink } from './logger'

const FIELDS = { scope: 'test' }

describe('M-35 logger 写盘失败降级链（F5-011 §5 绝不 throw）', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('主 sink 抛错 -> 降级 console（console 正常时降级生效）', () => {
    const sink: LogSink = {
      write() {
        throw new Error('disk full')
      }
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logger = createLogger({ scope: 'test', sink, minLevel: 'debug' })

    expect(() => logger.error('boom', FIELDS)).not.toThrow()
    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(consoleError.mock.calls[0][0]).toContain('boom')
  })

  it('主 sink 抛错 + console 也抛错 -> 哑火，绝不把异常甩回调用方', () => {
    const sink: LogSink = {
      write() {
        throw new Error('disk full')
      }
    }
    // console 底层 stdout 断管且同步抛错的极端组合（M-35 事故路径）
    vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('write EPIPE')
    })
    const logger = createLogger({ scope: 'test', sink, minLevel: 'debug' })

    expect(() => logger.error('boom', FIELDS)).not.toThrow()
    expect(() => logger.fatal('boom', FIELDS)).not.toThrow()
  })

  it('主 sink 正常时不走降级', () => {
    const written: string[] = []
    const sink: LogSink = {
      write(_level, line) {
        written.push(line)
      }
    }
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const logger = createLogger({ scope: 'test', sink, minLevel: 'debug' })

    logger.info('hello', FIELDS)
    expect(written).toHaveLength(1)
    expect(consoleError).not.toHaveBeenCalled()
  })
})
