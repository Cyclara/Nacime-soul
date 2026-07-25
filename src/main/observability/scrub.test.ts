// src/main/observability/scrub.test.ts
// P1-12 验收测试：scrub 脱敏管道 + Logger + ErrorBuffer
// 依据：F5-011 §3/§5、S-004 测试 #11/#12、S-001 P1-12 验收标准

import { describe, it, expect, vi, afterEach } from 'vitest'
import { scrub } from './scrub'
import { createErrorBuffer, type ErrorEntry } from './error-buffer'
import {
  createLogger,
  configureLogger,
  getLogger,
  createElectronLogSink,
  type LogSink,
  type ElectronLogLike
} from './logger'
import { SCRUB_RULES } from '@shared/observability/types'
import type { LogFields } from '@shared/observability/types'

// === scrub 脱敏测试（S-004 #11）===

describe('P1-12 scrub 脱敏管道', () => {
  describe('OpenAI API Key', () => {
    it('sk- 前缀 key 被替换为 <api-key>', () => {
      const input = 'Using key sk-1234567890abcdefGHIJ for request'
      const result = scrub(input)
      expect(result).not.toContain('sk-1234567890abcdefGHIJ')
      expect(result).toContain('<api-key>')
    })

    it('多个 key 全部脱敏', () => {
      const input = 'keys: sk-aaaaaaaaBBBBBB and sk-ccccccccDDDDDDDD'
      const result = scrub(input)
      expect(result).not.toContain('sk-aaaaaaaaBBBBBB')
      expect(result).not.toContain('sk-ccccccccDDDDDDDD')
      expect(result.match(/<api-key>/g)?.length).toBe(2)
    })

    it('短于 8 字符的 sk- 前缀不脱敏（规则要求 {8,}）', () => {
      const input = 'short: sk-abcd'
      const result = scrub(input)
      // sk-abcd 只有 4 个字符后缀，不匹配 sk-[A-Za-z0-9_-]{8,}
      expect(result).toContain('sk-abcd')
    })
  })

  describe('Bearer token', () => {
    it('Bearer token 被替换', () => {
      const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
      const result = scrub(input)
      expect(result).not.toContain('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')
      expect(result).toContain('Bearer <token>')
    })
  })

  describe('通用 key/token/secret', () => {
    it('api_key=... 被脱敏', () => {
      const input = 'config api_key=abcdefghijklmnop123456'
      const result = scrub(input)
      expect(result).not.toContain('abcdefghijklmnop123456')
      expect(result).toContain('api_key=<redacted>')
    })

    it('token=... 被脱敏', () => {
      const input = 'request token=secretTokenValue12345678'
      const result = scrub(input)
      expect(result).not.toContain('secretTokenValue12345678')
      expect(result).toContain('token=<redacted>')
    })

    it('secret=... 被脱敏', () => {
      const input = 'env secret=mySecretValue987654321'
      const result = scrub(input)
      expect(result).not.toContain('mySecretValue987654321')
      expect(result).toContain('secret=<redacted>')
    })
  })

  describe('Windows 用户路径', () => {
    it('C:\\Users\\<name> 被脱敏', () => {
      const input = 'log file at C:\\Users\\johnsmith\\AppData\\logs\\main.log'
      const result = scrub(input)
      expect(result).not.toContain('johnsmith')
      expect(result).toContain('C:\\Users\\<user>')
    })

    it('D:\\Users 路径被脱敏', () => {
      const input = 'path: D:\\Users\\alice\\data'
      const result = scrub(input)
      expect(result).not.toContain('alice')
    })
  })

  describe('Unix home 路径', () => {
    it('/home/<user> 被脱敏', () => {
      const input = 'config at /home/bob/.config/nacime-soul'
      const result = scrub(input)
      expect(result).not.toContain('/home/bob')
      expect(result).toContain('/home/<user>')
    })

    it('/Users/<user> 被脱敏', () => {
      const input = 'macOS path /Users/charlie/Library/logs'
      const result = scrub(input)
      expect(result).not.toContain('charlie')
    })
  })

  describe('data URI', () => {
    it('base64 data URI 被脱敏', () => {
      const longBase64 = 'A'.repeat(80)
      const input = `data:image/png;base64,${longBase64}`
      const result = scrub(input)
      expect(result).not.toContain(longBase64)
      expect(result).toContain('<data-uri>')
    })
  })

  describe('长 base64', () => {
    it('256+ 字符 base64 被脱敏', () => {
      const longB64 = 'ABcdef1234'.repeat(30) // 300 字符
      const input = `response body: ${longB64}`
      const result = scrub(input)
      expect(result).not.toContain(longB64)
      expect(result).toContain('<base64>')
    })
  })

  describe('邮箱', () => {
    it('邮箱地址被脱敏', () => {
      const input = 'contact: user@example.com for support'
      const result = scrub(input)
      expect(result).not.toContain('user@example.com')
      expect(result).toContain('<email>')
    })

    it('多个邮箱全部脱敏', () => {
      const input = 'from alice@test.com to bob@mail.org'
      const result = scrub(input)
      expect(result).not.toContain('alice@test.com')
      expect(result).not.toContain('bob@mail.org')
    })
  })

  describe('中国手机号', () => {
    it('11 位手机号被脱敏', () => {
      const input = 'phone: 13812345678 call me'
      const result = scrub(input)
      expect(result).not.toContain('13812345678')
      expect(result).toContain('<phone>')
    })

    it('手机号前后有数字时不脱敏（边界检查）', () => {
      const input = 'id: 1238123456789'
      const result = scrub(input)
      // 13812345678 前面有 2，后面有 9，不是独立手机号
      expect(result).toContain('1238123456789')
    })
  })

  describe('URL query 参数', () => {
    it('URL query 被脱敏', () => {
      const input = 'GET https://api.example.com/v1/chat?secret=abc123&token=xyz'
      const result = scrub(input)
      expect(result).not.toContain('secret=abc123')
      expect(result).not.toContain('token=xyz')
      expect(result).toContain('?<query>')
    })
  })

  describe('混合脱敏', () => {
    it('多种敏感信息同时存在全部脱敏', () => {
      const input =
        'user sk-abcdefgh12345678 at C:\\Users\\admin\\logs, email admin@test.com, phone 13900001111'
      const result = scrub(input)
      expect(result).not.toContain('sk-abcdefgh12345678')
      expect(result).not.toContain('admin')
      expect(result).not.toContain('admin@test.com')
      expect(result).not.toContain('13900001111')
      expect(result).toContain('<api-key>')
      expect(result).toContain('<email>')
      expect(result).toContain('<phone>')
    })

    it('无敏感信息的普通文本不变', () => {
      const input = 'ChatService started turn, latency 234ms, tokens 89'
      const result = scrub(input)
      expect(result).toBe(input)
    })

    it('普通中文文本不变', () => {
      const input = '用户发送了一条消息，长度 42 字符'
      const result = scrub(input)
      expect(result).toBe(input)
    })

    it('空字符串不变', () => {
      expect(scrub('')).toBe('')
    })
  })

  describe('自定义规则', () => {
    it('传入自定义规则集', () => {
      const customRules = [
        { name: 'test-secret', pattern: /TEST-\d+/g, replacement: '<test-secret>' }
      ]
      const input = 'value TEST-12345 here'
      const result = scrub(input, customRules)
      expect(result).not.toContain('TEST-12345')
      expect(result).toContain('<test-secret>')
    })

    it('空规则集不脱敏', () => {
      const input = 'key sk-1234567890abcdef'
      const result = scrub(input, [])
      expect(result).toBe(input)
    })
  })

  it('SCRUB_RULES 常量包含 10 条规则', () => {
    expect(SCRUB_RULES).toHaveLength(10)
    for (const rule of SCRUB_RULES) {
      expect(rule.pattern.global).toBe(true) // 必须带 g flag
    }
  })
})

// === Logger 测试（S-004 #12、F5-011 验收）===

/** 收集写入行的 fake sink */
function createFakeSink(shouldThrow = false): {
  sink: LogSink
  lines: Array<{ level: string; line: string }>
} {
  const lines: Array<{ level: string; line: string }> = []
  return {
    sink: {
      write(level, line) {
        if (shouldThrow) throw new Error('sink write failed')
        lines.push({ level, line })
      }
    },
    lines
  }
}

describe('P1-12 Logger', () => {
  describe('级别过滤', () => {
    it('minLevel=info 时 debug 被丢弃', () => {
      const { sink, lines } = createFakeSink()
      const logger = createLogger({ scope: 'test', sink, minLevel: 'info' })
      logger.debug('debug message', { scope: 'test' })
      expect(lines).toHaveLength(0)
    })

    it('minLevel=debug 时 debug 通过', () => {
      const { sink, lines } = createFakeSink()
      const logger = createLogger({ scope: 'test', sink, minLevel: 'debug' })
      logger.debug('debug message', { scope: 'test' })
      expect(lines).toHaveLength(1)
      expect(lines[0].level).toBe('debug')
    })

    it('minLevel=warn 时 info 被丢弃', () => {
      const { sink, lines } = createFakeSink()
      const logger = createLogger({ scope: 'test', sink, minLevel: 'warn' })
      logger.info('info message', { scope: 'test' })
      expect(lines).toHaveLength(0)
    })

    it('fatal 始终通过（最高优先级）', () => {
      const { sink, lines } = createFakeSink()
      const logger = createLogger({ scope: 'test', sink, minLevel: 'error' })
      logger.fatal('fatal message', { scope: 'test' })
      expect(lines).toHaveLength(1)
      expect(lines[0].level).toBe('fatal')
    })

    it('默认 minLevel=info', () => {
      const { sink, lines } = createFakeSink()
      const logger = createLogger({ scope: 'test', sink })
      logger.info('info', { scope: 'test' })
      logger.debug('debug', { scope: 'test' })
      expect(lines).toHaveLength(1)
      expect(lines[0].line).toContain('info')
    })
  })

  describe('msg 脱敏（F5-011 验收 ①）', () => {
    it('msg 中的 API Key 被脱敏后写入 sink', () => {
      const { sink, lines } = createFakeSink()
      const logger = createLogger({ scope: 'llm', sink, minLevel: 'debug' })
      logger.error('request failed with key sk-1234567890abcdef', { scope: 'llm' })
      expect(lines[0].line).not.toContain('sk-1234567890abcdef')
      expect(lines[0].line).toContain('<api-key>')
    })

    it('msg 中的邮箱被脱敏', () => {
      const { sink, lines } = createFakeSink()
      const logger = createLogger({ scope: 'config', sink, minLevel: 'debug' })
      logger.warn('user email user@example.com not found', { scope: 'config' })
      expect(lines[0].line).not.toContain('user@example.com')
      expect(lines[0].line).toContain('<email>')
    })

    it('msg 中的用户路径被脱敏', () => {
      const { sink, lines } = createFakeSink()
      const logger = createLogger({ scope: 'config', sink, minLevel: 'debug' })
      logger.error('cannot read C:\\Users\\bob\\data\\config.json', { scope: 'config' })
      expect(lines[0].line).not.toContain('bob')
      expect(lines[0].line).toContain('C:\\Users\\<user>')
    })
  })

  describe('detail 脱敏（S-004 #12）', () => {
    it('detail 中的 API Key 被脱敏', () => {
      const { sink, lines } = createFakeSink()
      const logger = createLogger({ scope: 'ipc', sink, minLevel: 'debug' })
      logger.error('handler failed', {
        scope: 'ipc',
        detail: 'authorization header: Bearer eyJhbGciOiJIUzI1NiJ9abcdefgh'
      })
      expect(lines[0].line).not.toContain('eyJhbGciOiJIUzI1NiJ9abcdefgh')
      expect(lines[0].line).toContain('Bearer <token>')
    })

    it('detail 中的手机号被脱敏', () => {
      const { sink, lines } = createFakeSink()
      const logger = createLogger({ scope: 'config', sink, minLevel: 'debug' })
      logger.warn('phone validation', { scope: 'config', detail: 'value 13812345678 invalid' })
      expect(lines[0].line).not.toContain('13812345678')
      expect(lines[0].line).toContain('<phone>')
    })

    it('detail 为 undefined 时不追加 detail 字段', () => {
      const { sink, lines } = createFakeSink()
      const logger = createLogger({ scope: 'test', sink, minLevel: 'debug' })
      logger.info('simple message', { scope: 'test' })
      expect(lines[0].line).not.toContain('detail=')
    })
  })

  describe('聊天正文不进日志（S-004 #12）', () => {
    it('LogFields 类型层面拒绝对象型自由字段', () => {
      // F5-011 验收 ②：LogFields 类型拒绝对象型自由字段
      // detail 是 string，传对象会 tsc 报错。此测试验证类型约束生效。
      // @ts-expect-error - detail 不接受对象
      const _bad: LogFields = { scope: 'test', detail: { secret: 'chat content' } }
      // 如果编译通过则类型约束生效（_bad 不会被使用）
      expect(_bad).toBeDefined()
    })

    it('需要引用消息时只传 messageId + 长度到 metrics/tags', () => {
      const { sink, lines } = createFakeSink()
      const logger = createLogger({ scope: 'chat', sink, minLevel: 'debug' })
      // 正确做法：传 messageId 和 inputLen，不传消息内容
      logger.info('turn started', {
        scope: 'chat',
        tags: { messageId: 'msg_01JG...' },
        metrics: { inputLen: 42 }
      })
      const line = lines[0].line
      expect(line).toContain('messageId=msg_01JG...')
      expect(line).toContain('inputLen=42')
      // 不含任何聊天正文
      expect(line).not.toContain('detail=')
    })
  })

  describe('格式化', () => {
    it('输出包含级别、scope、msg', () => {
      const { sink, lines } = createFakeSink()
      const logger = createLogger({ scope: 'llm', sink, minLevel: 'debug' })
      logger.info('stream started', { scope: 'llm' })
      const line = lines[0].line
      expect(line).toContain('INFO')
      expect(line).toContain('[llm]')
      expect(line).toContain('stream started')
    })

    it('code 和 turnId 出现在输出中', () => {
      const { sink, lines } = createFakeSink()
      const logger = createLogger({ scope: 'chat', sink, minLevel: 'debug' })
      logger.error('llm call failed', {
        scope: 'chat',
        code: 'LLM_AUTH',
        turnId: '01JG turn123'
      })
      expect(lines[0].line).toContain('code=LLM_AUTH')
      expect(lines[0].line).toContain('turnId=01JG turn123')
    })

    it('tags 值超长被截断到 64 字符', () => {
      const { sink, lines } = createFakeSink()
      const logger = createLogger({ scope: 'test', sink, minLevel: 'debug' })
      const longValue = 'x'.repeat(100)
      logger.info('msg', { scope: 'test', tags: { provider: longValue } })
      expect(lines[0].line).toContain('provider=' + 'x'.repeat(64))
      expect(lines[0].line).not.toContain('x'.repeat(100))
    })

    it('metrics 数值和布尔值出现在输出中', () => {
      const { sink, lines } = createFakeSink()
      const logger = createLogger({ scope: 'llm', sink, minLevel: 'debug' })
      logger.info('call done', {
        scope: 'llm',
        metrics: { latencyMs: 234, cached: true }
      })
      expect(lines[0].line).toContain('latencyMs=234')
      expect(lines[0].line).toContain('cached=true')
    })
  })

  describe('child scope', () => {
    it('child 创建带前缀的子 logger', () => {
      const { sink, lines } = createFakeSink()
      const logger = createLogger({ scope: 'security', sink, minLevel: 'debug' })
      const child = logger.child('secret-store')
      child.warn('key rotation', { scope: 'security' })
      expect(lines[0].line).toContain('[security.secret-store]')
    })

    it('child 继承 sink 和 minLevel', () => {
      const { sink, lines } = createFakeSink()
      const logger = createLogger({ scope: 'root', sink, minLevel: 'warn' })
      const child = logger.child('sub')
      child.debug('debug', { scope: 'root' }) // 被丢弃
      child.warn('warn', { scope: 'root' }) // 通过
      expect(lines).toHaveLength(1)
      expect(lines[0].level).toBe('warn')
    })

    it('child 继承 errorBuffer', () => {
      const errorBuffer = createErrorBuffer()
      const { sink } = createFakeSink()
      const logger = createLogger({ scope: 'root', sink, minLevel: 'debug', errorBuffer })
      const child = logger.child('sub')
      child.error('sub error', { scope: 'root' })
      expect(errorBuffer.size).toBe(1)
    })
  })

  describe('写盘失败降级 console（F5-011 §5）', () => {
    it('sink 抛错时降级到 console', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { sink } = createFakeSink(true) // sink 会 throw
      const logger = createLogger({ scope: 'test', sink, minLevel: 'debug' })
      // 不应 throw
      expect(() => logger.error('message', { scope: 'test' })).not.toThrow()
      // console 被调用
      expect(consoleErrorSpy).toHaveBeenCalled()
      const loggedLine = consoleErrorSpy.mock.calls[0][0] as string
      expect(loggedLine).toContain('message')
      consoleErrorSpy.mockRestore()
    })

    it('sink 抛错时 warn 降级到 console.warn', () => {
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { sink } = createFakeSink(true)
      const logger = createLogger({ scope: 'test', sink, minLevel: 'debug' })
      expect(() => logger.warn('warning', { scope: 'test' })).not.toThrow()
      expect(consoleWarnSpy).toHaveBeenCalled()
      consoleWarnSpy.mockRestore()
    })
  })

  describe('ErrorBuffer 集成', () => {
    it('error 级别推入 errorBuffer', () => {
      const errorBuffer = createErrorBuffer()
      const { sink } = createFakeSink()
      const logger = createLogger({ scope: 'test', sink, minLevel: 'debug', errorBuffer })
      logger.error('error occurred', { scope: 'test', code: 'LLM_AUTH' })
      const snapshot = errorBuffer.snapshot()
      expect(snapshot).toHaveLength(1)
      expect(snapshot[0].msg).toBe('error occurred')
      expect(snapshot[0].code).toBe('LLM_AUTH')
      expect(snapshot[0].level).toBe('error')
    })

    it('fatal 级别推入 errorBuffer', () => {
      const errorBuffer = createErrorBuffer()
      const { sink } = createFakeSink()
      const logger = createLogger({ scope: 'test', sink, minLevel: 'debug', errorBuffer })
      logger.fatal('crash', { scope: 'test' })
      expect(errorBuffer.snapshot()).toHaveLength(1)
    })

    it('warn 级别不推入 errorBuffer', () => {
      const errorBuffer = createErrorBuffer()
      const { sink } = createFakeSink()
      const logger = createLogger({ scope: 'test', sink, minLevel: 'debug', errorBuffer })
      logger.warn('warning', { scope: 'test' })
      expect(errorBuffer.snapshot()).toHaveLength(0)
    })

    it('info 级别不推入 errorBuffer', () => {
      const errorBuffer = createErrorBuffer()
      const { sink } = createFakeSink()
      const logger = createLogger({ scope: 'test', sink, minLevel: 'debug', errorBuffer })
      logger.info('info', { scope: 'test' })
      expect(errorBuffer.snapshot()).toHaveLength(0)
    })

    it('errorBuffer 中的 msg 已脱敏', () => {
      const errorBuffer = createErrorBuffer()
      const { sink } = createFakeSink()
      const logger = createLogger({ scope: 'llm', sink, minLevel: 'debug', errorBuffer })
      logger.error('auth failed key sk-1234567890abcdef', { scope: 'llm', code: 'LLM_AUTH' })
      const entry = errorBuffer.snapshot()[0]
      expect(entry.msg).not.toContain('sk-1234567890abcdef')
      expect(entry.msg).toContain('<api-key>')
    })
  })
})

// === ErrorBuffer 测试 ===

describe('P1-12 ErrorBuffer', () => {
  it('push 和 snapshot', () => {
    const buf = createErrorBuffer()
    const entry: ErrorEntry = { ts: 1000, level: 'error', msg: 'test error' }
    buf.push(entry)
    const snap = buf.snapshot()
    expect(snap).toHaveLength(1)
    expect(snap[0]).toEqual(entry)
  })

  it('超出容量丢弃最旧', () => {
    const buf = createErrorBuffer(3)
    buf.push({ ts: 1, level: 'error', msg: 'first' })
    buf.push({ ts: 2, level: 'error', msg: 'second' })
    buf.push({ ts: 3, level: 'error', msg: 'third' })
    buf.push({ ts: 4, level: 'error', msg: 'fourth' })
    const snap = buf.snapshot()
    expect(snap).toHaveLength(3)
    expect(snap[0].msg).toBe('second') // first 被丢弃
    expect(snap[2].msg).toBe('fourth')
  })

  it('默认容量 50', () => {
    const buf = createErrorBuffer()
    for (let i = 0; i < 60; i++) {
      buf.push({ ts: i, level: 'error', msg: `error-${i}` })
    }
    const snap = buf.snapshot()
    expect(snap).toHaveLength(50)
    expect(snap[0].msg).toBe('error-10') // 前 10 条被丢弃
    expect(snap[49].msg).toBe('error-59')
  })

  it('clear 清空缓冲', () => {
    const buf = createErrorBuffer()
    buf.push({ ts: 1, level: 'error', msg: 'a' })
    buf.push({ ts: 2, level: 'error', msg: 'b' })
    buf.clear()
    expect(buf.snapshot()).toHaveLength(0)
    expect(buf.size).toBe(0)
  })

  it('snapshot 返回副本（修改不影响内部）', () => {
    const buf = createErrorBuffer()
    buf.push({ ts: 1, level: 'error', msg: 'original' })
    const snap = buf.snapshot()
    snap.push({ ts: 2, level: 'error', msg: 'injected' })
    expect(buf.snapshot()).toHaveLength(1)
  })
})

// === 全局配置测试 ===

describe('P1-12 全局 Logger 配置', () => {
  afterEach(() => {
    // 重置全局配置
    configureLogger({
      sink: {
        write() {
          /* noop */
        }
      },
      minLevel: 'info'
    })
  })

  it('configureLogger + getLogger 使用全局 sink', () => {
    const { sink, lines } = createFakeSink()
    configureLogger({ sink, minLevel: 'debug' })
    const logger = getLogger('global-test')
    logger.info('global message', { scope: 'global-test' })
    expect(lines).toHaveLength(1)
    expect(lines[0].line).toContain('[global-test]')
  })

  it('configureLogger 设置全局 minLevel', () => {
    const { sink, lines } = createFakeSink()
    configureLogger({ sink, minLevel: 'error' })
    const logger = getLogger('test')
    logger.warn('warn', { scope: 'test' }) // 被丢弃
    logger.error('error', { scope: 'test' }) // 通过
    expect(lines).toHaveLength(1)
  })

  it('configureLogger 传入 errorBuffer', () => {
    const errorBuffer = createErrorBuffer()
    const { sink } = createFakeSink()
    configureLogger({ sink, minLevel: 'debug', errorBuffer })
    const logger = getLogger('test')
    logger.error('global error', { scope: 'test' })
    expect(errorBuffer.size).toBe(1)
  })
})

// === electron-log sink 工厂测试 ===

describe('P1-12 createElectronLogSink', () => {
  it('将 fatal 映射到 error（electron-log 无 fatal 级别）', () => {
    const calls: Array<{ method: string; arg: string }> = []
    const fakeElectronLog: ElectronLogLike = {
      error(...args) {
        calls.push({ method: 'error', arg: String(args[0]) })
      },
      warn(...args) {
        calls.push({ method: 'warn', arg: String(args[0]) })
      },
      info(...args) {
        calls.push({ method: 'info', arg: String(args[0]) })
      },
      debug(...args) {
        calls.push({ method: 'debug', arg: String(args[0]) })
      },
      verbose() {
        /* noop */
      }
    }
    const sink = createElectronLogSink(fakeElectronLog)
    sink.write('fatal', 'fatal line')
    expect(calls[0].method).toBe('error')
    expect(calls[0].arg).toBe('fatal line')
  })

  it('各级别正确映射', () => {
    const calls: string[] = []
    const fakeElectronLog: ElectronLogLike = {
      error(...a) {
        calls.push('error:' + String(a[0]))
      },
      warn(...a) {
        calls.push('warn:' + String(a[0]))
      },
      info(...a) {
        calls.push('info:' + String(a[0]))
      },
      debug(...a) {
        calls.push('debug:' + String(a[0]))
      },
      verbose() {
        /* noop */
      }
    }
    const sink = createElectronLogSink(fakeElectronLog)
    sink.write('error', 'e')
    sink.write('warn', 'w')
    sink.write('info', 'i')
    sink.write('debug', 'd')
    expect(calls).toEqual(['error:e', 'warn:w', 'info:i', 'debug:d'])
  })
})
