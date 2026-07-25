// src/main/ipc/validators.test.ts
// P1-11 验收测试：IPC validators + isTrustedSender
// 依据：S-003 §3.5/§3.6、S-004 测试 #5/#6/#7、S-001 P1-11 验收标准

import { describe, it, expect } from 'vitest'
import {
  IPC_VALIDATORS,
  validateIpcPayload,
  validateEventPayload,
  isTrustedSender,
  type IpcGuardConfig
} from './validators'
import { IPC_INVOKE_CHANNELS } from '@shared/ipc/channels'
import type { IpcInvokeChannel } from '@shared/ipc/channels'

// === S-004 #5：每个 invoke channel 都存在 validator ===

describe('P1-11 IPC_VALIDATORS 全覆盖', () => {
  it('IPC_INVOKE_CHANNELS 的每个通道都在 IPC_VALIDATORS 中有 validator', () => {
    for (const channel of IPC_INVOKE_CHANNELS) {
      expect(IPC_VALIDATORS[channel]).toBeDefined()
      expect(typeof IPC_VALIDATORS[channel]).toBe('function')
    }
  })

  it('IPC_VALIDATORS 的 key 数量与 IPC_INVOKE_CHANNELS 一致（17 个）', () => {
    expect(Object.keys(IPC_VALIDATORS)).toHaveLength(17)
    expect(IPC_INVOKE_CHANNELS).toHaveLength(17)
  })

  it('IPC_VALIDATORS 没有多余的 key', () => {
    const validatorKeys = new Set(Object.keys(IPC_VALIDATORS))
    const channelKeys = new Set(IPC_INVOKE_CHANNELS as readonly string[])
    expect(validatorKeys.size).toBe(channelKeys.size)
    for (const key of channelKeys) {
      expect(validatorKeys.has(key)).toBe(true)
    }
  })
})

// === undefined 通道 validator ===

describe('P1-11 undefined 通道 validator', () => {
  const undefinedChannels: IpcInvokeChannel[] = [
    'companion:app:get-info',
    'companion:app:open-user-data',
    'companion:window:minimize',
    'companion:window:toggle-maximize',
    'companion:window:close',
    'companion:window:get-state',
    'companion:config:get',
    'companion:chat:create-session',
    'companion:debug:get-snapshot',
    'companion:debug:open-log-folder'
  ]

  for (const channel of undefinedChannels) {
    describe(`${channel}`, () => {
      it('undefined 通过', () => {
        expect(validateIpcPayload(channel, undefined)).toBe(true)
      })

      it('null 拒绝', () => {
        expect(validateIpcPayload(channel, null)).toBe(false)
      })

      it('对象拒绝', () => {
        expect(validateIpcPayload(channel, {})).toBe(false)
      })

      it('数组拒绝', () => {
        expect(validateIpcPayload(channel, [])).toBe(false)
      })

      it('字符串拒绝', () => {
        expect(validateIpcPayload(channel, 'hello')).toBe(false)
      })
    })
  }
})

// === S-004 #6：多余字段、超长 ID、NaN、数组伪装对象 ===

describe('P1-11 ChatSendRequest validator', () => {
  const validPayload = {
    sessionId: 'sess_01JG-test123',
    text: '你好，今天天气怎么样？',
    clientRequestId: 'req_abc123'
  }

  it('合法 payload 通过', () => {
    expect(validateIpcPayload('companion:chat:send', validPayload)).toBe(true)
  })

  it('多余字段被拒绝', () => {
    expect(
      validateIpcPayload('companion:chat:send', {
        ...validPayload,
        extraField: 'malicious'
      })
    ).toBe(false)
  })

  it('缺少必需字段被拒绝', () => {
    expect(
      validateIpcPayload('companion:chat:send', {
        sessionId: 'sess_01JG',
        text: 'hello'
        // 缺少 clientRequestId
      })
    ).toBe(false)
  })

  it('超长 ID 被拒绝（>200 字符）', () => {
    expect(
      validateIpcPayload('companion:chat:send', {
        ...validPayload,
        sessionId: 'x'.repeat(201)
      })
    ).toBe(false)
  })

  it('ID 含非法字符被拒绝', () => {
    expect(
      validateIpcPayload('companion:chat:send', {
        ...validPayload,
        sessionId: 'sess with spaces'
      })
    ).toBe(false)
  })

  it('空文本（trim 后）被拒绝', () => {
    expect(
      validateIpcPayload('companion:chat:send', {
        ...validPayload,
        text: '   '
      })
    ).toBe(false)
  })

  it('超长文本（>20000 字符）被拒绝', () => {
    expect(
      validateIpcPayload('companion:chat:send', {
        ...validPayload,
        text: 'x'.repeat(20001)
      })
    ).toBe(false)
  })

  it('数组伪装对象被拒绝', () => {
    expect(validateIpcPayload('companion:chat:send', ['sess', 'text', 'req'])).toBe(false)
  })

  it('null 被拒绝', () => {
    expect(validateIpcPayload('companion:chat:send', null)).toBe(false)
  })

  it('NaN 被拒绝（字段类型不对时）', () => {
    expect(
      validateIpcPayload('companion:chat:send', {
        sessionId: 'sess_01JG',
        text: NaN, // NaN 不是 string
        clientRequestId: 'req_abc'
      })
    ).toBe(false)
  })

  it('恰好 200 字符的 ID 通过', () => {
    expect(
      validateIpcPayload('companion:chat:send', {
        ...validPayload,
        sessionId: 'a'.repeat(200)
      })
    ).toBe(true)
  })

  it('恰好 20000 字符的文本通过', () => {
    expect(
      validateIpcPayload('companion:chat:send', {
        ...validPayload,
        text: 'x'.repeat(20000)
      })
    ).toBe(true)
  })
})

describe('P1-11 ChatListRequest validator', () => {
  it('合法 payload（含可选 sessionId）通过', () => {
    expect(
      validateIpcPayload('companion:chat:list', {
        sessionId: 'sess_01JG',
        limit: 100
      })
    ).toBe(true)
  })

  it('合法 payload（不含 sessionId）通过', () => {
    expect(validateIpcPayload('companion:chat:list', { limit: 50 })).toBe(true)
  })

  it('limit < 1 被拒绝', () => {
    expect(validateIpcPayload('companion:chat:list', { limit: 0 })).toBe(false)
  })

  it('limit > 500 被拒绝', () => {
    expect(validateIpcPayload('companion:chat:list', { limit: 501 })).toBe(false)
  })

  it('limit 非整数被拒绝', () => {
    expect(validateIpcPayload('companion:chat:list', { limit: 1.5 })).toBe(false)
  })

  it('limit 为 NaN 被拒绝', () => {
    expect(validateIpcPayload('companion:chat:list', { limit: NaN })).toBe(false)
  })

  it('多余字段被拒绝', () => {
    expect(validateIpcPayload('companion:chat:list', { limit: 50, extra: 'bad' })).toBe(false)
  })

  it('数组被拒绝', () => {
    expect(validateIpcPayload('companion:chat:list', [50])).toBe(false)
  })
})

describe('P1-11 ChatCancelRequest validator', () => {
  it('合法 payload 通过', () => {
    expect(validateIpcPayload('companion:chat:cancel', { requestId: 'req_abc123' })).toBe(true)
  })

  it('多余字段被拒绝', () => {
    expect(
      validateIpcPayload('companion:chat:cancel', {
        requestId: 'req_abc',
        extra: 'bad'
      })
    ).toBe(false)
  })
})

describe('P1-11 ChatRetryRequest validator', () => {
  it('合法 payload 通过', () => {
    expect(
      validateIpcPayload('companion:chat:retry', {
        sessionId: 'sess_01JG',
        messageId: 'msg_abc123'
      })
    ).toBe(true)
  })

  it('缺少 messageId 被拒绝', () => {
    expect(validateIpcPayload('companion:chat:retry', { sessionId: 'sess_01JG' })).toBe(false)
  })
})

describe('P1-11 ModelConnectionTestRequest validator', () => {
  const validPayload = {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: 'sk-1234567890abcdef',
    timeoutMs: 10000
  }

  it('合法 payload 通过', () => {
    expect(validateIpcPayload('companion:config:test-model', validPayload)).toBe(true)
  })

  it('不含可选字段也通过', () => {
    expect(
      validateIpcPayload('companion:config:test-model', {
        provider: 'deepseek',
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-chat'
      })
    ).toBe(true)
  })

  it('非法 URL 被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:test-model', {
        ...validPayload,
        baseUrl: 'not-a-url'
      })
    ).toBe(false)
  })

  it('超长 provider（>64）被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:test-model', {
        ...validPayload,
        provider: 'x'.repeat(65)
      })
    ).toBe(false)
  })

  it('超长 model（>128）被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:test-model', {
        ...validPayload,
        model: 'x'.repeat(129)
      })
    ).toBe(false)
  })

  it('timeoutMs 超范围被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:test-model', {
        ...validPayload,
        timeoutMs: 500 // < 1000
      })
    ).toBe(false)
  })

  it('多余字段被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:test-model', {
        ...validPayload,
        injection: 'bad'
      })
    ).toBe(false)
  })
})

describe('P1-11 ConfigResetRequest validator', () => {
  it('合法 payload 通过', () => {
    expect(
      validateIpcPayload('companion:config:reset-domain', {
        domain: 'model',
        confirm: true
      })
    ).toBe(true)
  })

  it('五个域都通过', () => {
    for (const domain of ['model', 'tts', 'memory', 'ui', 'security'] as const) {
      expect(validateIpcPayload('companion:config:reset-domain', { domain, confirm: true })).toBe(
        true
      )
    }
  })

  it('非法 domain 被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:reset-domain', {
        domain: 'injection',
        confirm: true
      })
    ).toBe(false)
  })

  it('confirm 不为 true 被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:reset-domain', {
        domain: 'model',
        confirm: false
      })
    ).toBe(false)
  })

  it('多余字段被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:reset-domain', {
        domain: 'model',
        confirm: true,
        extra: 'bad'
      })
    ).toBe(false)
  })
})

describe('P1-11 ConfigUpdateRequest validator', () => {
  it('合法 payload（含 model 域）通过', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: {
          model: {
            provider: 'deepseek',
            baseUrl: 'https://api.deepseek.com/v1',
            apiKey: 'sk-1234567890abcdef'
          }
        }
      })
    ).toBe(true)
  })

  it('合法 payload（含多个域）通过', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: {
          model: { temperature: 0.8 },
          ui: { theme: 'dark', fontScale: 1.2 },
          security: { allowHttpLocalhostInDev: false }
        }
      })
    ).toBe(true)
  })

  it('空 domains 通过', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: {}
      })
    ).toBe(true)
  })

  it('expectedSchemaVersion 非整数被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1.5,
        domains: {}
      })
    ).toBe(false)
  })

  it('domains 中多余域字段被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: {
          injection: { foo: 'bar' }
        }
      })
    ).toBe(false)
  })

  it('model 域有多余字段被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: {
          model: { injection: 'bad' }
        }
      })
    ).toBe(false)
  })

  it('model.temperature 超范围被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: {
          model: { temperature: 5 } // > 2
        }
      })
    ).toBe(false)
  })

  it('model.protocol 非法值被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: {
          model: { protocol: 'injection' }
        }
      })
    ).toBe(false)
  })

  it('tts.sampleRate 非法值被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: {
          tts: { sampleRate: 9999 }
        }
      })
    ).toBe(false)
  })

  it('ui.theme 非法值被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: {
          ui: { theme: 'purple' }
        }
      })
    ).toBe(false)
  })

  it('security.diagnostics.logLevel 非法值被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: {
          security: {
            diagnostics: { logLevel: 'trace' }
          }
        }
      })
    ).toBe(false)
  })

  it('memory.dmae.maxScore 不为 100 被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: {
          memory: {
            dmae: { maxScore: 99 }
          }
        }
      })
    ).toBe(false)
  })

  it('compatOverrides 合法值通过', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: {
          model: {
            compatOverrides: {
              thinkingFormat: 'thinking_type',
              supportsToolCalls: true,
              supportsVision: false,
              maxTokensField: 'max_completion_tokens'
            }
          }
        }
      })
    ).toBe(true)
  })

  it('compatOverrides 非法值被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: {
          model: {
            compatOverrides: {
              thinkingFormat: 'invalid_format'
            }
          }
        }
      })
    ).toBe(false)
  })

  it('数组伪装 domains 被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: ['model', 'tts']
      })
    ).toBe(false)
  })

  it('NaN 作为 expectedSchemaVersion 被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: NaN,
        domains: {}
      })
    ).toBe(false)
  })
})

// === event 通道 validator ===

describe('P1-11 event validator', () => {
  describe('ChatStreamEvent', () => {
    it('started 事件通过', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'started',
          requestId: 'req_abc',
          sessionId: 'sess_01JG',
          assistantMessageId: 'msg_xyz',
          sequence: 0
        })
      ).toBe(true)
    })

    it('chunk 事件通过', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'chunk',
          requestId: 'req_abc',
          sequence: 1,
          delta: 'Hello'
        })
      ).toBe(true)
    })

    it('completed 事件（含 usage）通过', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'completed',
          requestId: 'req_abc',
          sequence: 5,
          usage: { inputTokens: 100, outputTokens: 50 }
        })
      ).toBe(true)
    })

    it('completed 事件（不含 usage）通过', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'completed',
          requestId: 'req_abc',
          sequence: 5
        })
      ).toBe(true)
    })

    it('failed 事件通过', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'failed',
          requestId: 'req_abc',
          sequence: 3,
          error: {
            code: 'LLM_AUTH',
            message: '认证失败',
            retryable: false
          }
        })
      ).toBe(true)
    })

    it('cancelled 事件通过', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'cancelled',
          requestId: 'req_abc',
          sequence: 2
        })
      ).toBe(true)
    })

    it('started 事件 sequence 不为 0 被拒绝', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'started',
          requestId: 'req_abc',
          sessionId: 'sess_01JG',
          assistantMessageId: 'msg_xyz',
          sequence: 1
        })
      ).toBe(false)
    })

    it('未知 type 被拒绝', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'injection',
          requestId: 'req_abc'
        })
      ).toBe(false)
    })

    it('多余字段被拒绝', () => {
      expect(
        validateEventPayload('companion:event:chat-stream', {
          type: 'chunk',
          requestId: 'req_abc',
          sequence: 1,
          delta: 'Hi',
          extra: 'bad'
        })
      ).toBe(false)
    })
  })

  describe('app-error event', () => {
    it('合法 PublicAppError 通过', () => {
      expect(
        validateEventPayload('companion:event:app-error', {
          code: 'LLM_AUTH',
          message: '认证失败',
          severity: 'error',
          retryable: false
        })
      ).toBe(true)
    })

    it('非法 severity 被拒绝', () => {
      expect(
        validateEventPayload('companion:event:app-error', {
          code: 'LLM_AUTH',
          message: '认证失败',
          severity: 'critical',
          retryable: false
        })
      ).toBe(false)
    })

    it('多余字段被拒绝', () => {
      expect(
        validateEventPayload('companion:event:app-error', {
          code: 'LLM_AUTH',
          message: '认证失败',
          severity: 'error',
          retryable: false,
          stack: 'sensitive stack trace'
        })
      ).toBe(false)
    })
  })

  describe('window-state event', () => {
    it('合法 payload 通过', () => {
      expect(validateEventPayload('companion:event:window-state', { maximized: true })).toBe(true)
    })

    it('maximized 非布尔被拒绝', () => {
      expect(validateEventPayload('companion:event:window-state', { maximized: 'yes' })).toBe(false)
    })
  })
})

// === S-004 #7：isTrustedSender ===

describe('P1-11 isTrustedSender', () => {
  const config: IpcGuardConfig = {
    trustedOrigins: new Set([
      'http://localhost:5173', // dev server
      'file://' // 打包后本地文件
    ]),
    trustedWebContentsIds: new Set([1, 2])
  }

  it('受信任 origin + 受信任 id 通过', () => {
    expect(isTrustedSender({ url: 'http://localhost:5173/', webContentsId: 1 }, config)).toBe(true)
  })

  it('非受信 origin 被拒绝', () => {
    expect(isTrustedSender({ url: 'http://evil.com/', webContentsId: 1 }, config)).toBe(false)
  })

  it('非受信 webContents.id 被拒绝', () => {
    expect(isTrustedSender({ url: 'http://localhost:5173/', webContentsId: 999 }, config)).toBe(
      false
    )
  })

  it('origin 受信但 id 不受信被拒绝（不能只比 URL）', () => {
    // S-003 §3.6：不能只比 URL
    expect(isTrustedSender({ url: 'http://localhost:5173/', webContentsId: 999 }, config)).toBe(
      false
    )
  })

  it('id 受信但 origin 不受信被拒绝', () => {
    expect(isTrustedSender({ url: 'http://evil.com/', webContentsId: 1 }, config)).toBe(false)
  })

  it('file:// 协议受信任', () => {
    expect(isTrustedSender({ url: 'file:///C:/app/index.html', webContentsId: 1 }, config)).toBe(
      true
    )
  })

  it('file:// 未在 trustedOrigins 中被拒绝', () => {
    const configNoFile: IpcGuardConfig = {
      trustedOrigins: new Set(['http://localhost:5173']),
      trustedWebContentsIds: new Set([1])
    }
    expect(
      isTrustedSender({ url: 'file:///C:/app/index.html', webContentsId: 1 }, configNoFile)
    ).toBe(false)
  })

  it('空 URL 被拒绝', () => {
    expect(isTrustedSender({ url: '', webContentsId: 1 }, config)).toBe(false)
  })

  it('无效 URL 被拒绝', () => {
    expect(isTrustedSender({ url: 'not-a-url', webContentsId: 1 }, config)).toBe(false)
  })

  it('空 trustedWebContentsIds 拒绝一切', () => {
    const emptyConfig: IpcGuardConfig = {
      trustedOrigins: new Set(['http://localhost:5173']),
      trustedWebContentsIds: new Set()
    }
    expect(isTrustedSender({ url: 'http://localhost:5173/', webContentsId: 1 }, emptyConfig)).toBe(
      false
    )
  })

  it('空 trustedOrigins 拒绝一切', () => {
    const emptyConfig: IpcGuardConfig = {
      trustedOrigins: new Set<string>(),
      trustedWebContentsIds: new Set([1])
    }
    expect(isTrustedSender({ url: 'http://localhost:5173/', webContentsId: 1 }, emptyConfig)).toBe(
      false
    )
  })
})

describe('P1-11 ConfigUpdateRequest security.diagnostics/privacy 验证', () => {
  it('security.diagnostics 合法通过', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: {
          security: { diagnostics: { logLevel: 'debug', retentionDays: 14, maxTotalMb: 100 } }
        }
      })
    ).toBe(true)
  })

  it('security.privacy 合法通过', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: {
          security: { privacy: { includeCrashDumpsInExport: false, monthlyGcDigest: true } }
        }
      })
    ).toBe(true)
  })

  it('security.diagnostics.retentionDays 超范围被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { security: { diagnostics: { retentionDays: 999 } } }
      })
    ).toBe(false)
  })

  it('security.diagnostics.logLevel 非法值被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { security: { diagnostics: { logLevel: 'trace' } } }
      })
    ).toBe(false)
  })

  it('security.privacy.monthlyGcDigest 非布尔被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { security: { privacy: { monthlyGcDigest: 'yes' } } }
      })
    ).toBe(false)
  })

  it('security.diagnostics 有多余字段被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { security: { diagnostics: { injection: 'bad' } } }
      })
    ).toBe(false)
  })

  it('ui.window 子对象合法通过', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { ui: { window: { width: 1024, height: 768, maximized: true } } }
      })
    ).toBe(true)
  })

  it('ui.chat 子对象合法通过', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { ui: { chat: { sendOnEnter: true, showTimestamps: false } } }
      })
    ).toBe(true)
  })

  it('ui.live2d 子对象合法通过', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { ui: { live2d: { enabled: false, zoom: 1.5, alwaysOnTop: true } } }
      })
    ).toBe(true)
  })

  it('ui.window.width 超范围被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { ui: { window: { width: 100 } } }
      })
    ).toBe(false)
  })

  it('ui.locale 非法值被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { ui: { locale: 'ja-JP' } }
      })
    ).toBe(false)
  })

  it('ui.theme 非法值被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { ui: { theme: 'solarized' } }
      })
    ).toBe(false)
  })

  it('ui.reduceMotion 非布尔被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { ui: { reduceMotion: 'yes' } }
      })
    ).toBe(false)
  })
})

describe('P1-11 ConfigUpdateRequest 子对象非法值拒绝（100% branch 补全）', () => {
  // 辅助：验证某个域的某个字段传非法值时被拒绝
  function reject(
    domain: 'model' | 'tts' | 'memory' | 'ui' | 'security',
    patch: Record<string, unknown>
  ): void {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { [domain]: patch } as never
      })
    ).toBe(false)
  }

  // === compatOverrides 子对象 ===
  it('compatOverrides.thinkingFormat 非法值被拒绝', () => {
    reject('model', { compatOverrides: { thinkingFormat: 'bad' } })
  })
  it('compatOverrides.supportsToolCalls 非布尔被拒绝', () => {
    reject('model', { compatOverrides: { supportsToolCalls: 'yes' } })
  })
  it('compatOverrides.supportsVision 非布尔被拒绝', () => {
    reject('model', { compatOverrides: { supportsVision: 'yes' } })
  })
  it('compatOverrides.maxTokensField 非法值被拒绝', () => {
    reject('model', { compatOverrides: { maxTokensField: 'bad' } })
  })
  it('compatOverrides 多余字段被拒绝', () => {
    reject('model', { compatOverrides: { injection: 'bad' } })
  })

  // === model 域 ===
  it('model.protocol 非法值被拒绝', () => {
    reject('model', { protocol: 'gemini' })
  })
  it('model.provider 空字符串被拒绝', () => {
    reject('model', { provider: '' })
  })
  it('model.baseUrl 非法 URL 被拒绝', () => {
    reject('model', { baseUrl: 'not-a-url' })
  })
  it('model.temperature 超范围被拒绝', () => {
    reject('model', { temperature: 5 })
  })
  it('model.topP 超范围被拒绝', () => {
    reject('model', { topP: 5 })
  })
  it('model.maxTokens 超范围被拒绝', () => {
    reject('model', { maxTokens: 10 })
  })
  it('model.timeoutMs 超范围被拒绝', () => {
    reject('model', { timeoutMs: 100 })
  })
  it('model.reasoningEffort 非法值被拒绝', () => {
    reject('model', { reasoningEffort: 'extreme' })
  })
  it('model.model 非字符串被拒绝', () => {
    reject('model', { model: 123 })
  })
  it('model.displayName 非字符串被拒绝', () => {
    reject('model', { displayName: 123 })
  })

  // === tts 域 ===
  it('tts.enabled 非布尔被拒绝', () => {
    reject('tts', { enabled: 'yes' })
  })
  it('tts.speed 超范围被拒绝', () => {
    reject('tts', { speed: 5 })
  })
  it('tts.pitch 超范围被拒绝', () => {
    reject('tts', { pitch: 100 })
  })
  it('tts.volume 超范围被拒绝', () => {
    reject('tts', { volume: 5 })
  })
  it('tts.sampleRate 非法值被拒绝', () => {
    reject('tts', { sampleRate: 8000 })
  })
  it('tts.cacheEnabled 非布尔被拒绝', () => {
    reject('tts', { cacheEnabled: 'yes' })
  })
  it('tts.earlyPlaybackEnabled 非布尔被拒绝', () => {
    reject('tts', { earlyPlaybackEnabled: 'yes' })
  })
  it('tts.provider 空字符串被拒绝', () => {
    reject('tts', { provider: '' })
  })
  it('tts.voiceId 非字符串被拒绝', () => {
    reject('tts', { voiceId: 123 })
  })
  it('tts.apiKey 非字符串被拒绝', () => {
    reject('tts', { apiKey: 123 })
  })
  it('tts 合法值通过', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { tts: { enabled: true, provider: 'edge', sampleRate: 24000 } }
      })
    ).toBe(true)
  })

  // === memory.dmae 子对象 ===
  it('memory.dmae.maxScore 非 100 被拒绝', () => {
    reject('memory', { dmae: { maxScore: 99 } })
  })
  it('memory.dmae.enabled 非布尔被拒绝', () => {
    reject('memory', { dmae: { enabled: 'yes' } })
  })
  it('memory.dmae.promptThreshold 超范围被拒绝', () => {
    reject('memory', { dmae: { promptThreshold: 200 } })
  })
  it('memory.dmae.userRewardBase 超范围被拒绝', () => {
    reject('memory', { dmae: { userRewardBase: 100 } })
  })
  it('memory.dmae.wakeGamma 超范围被拒绝', () => {
    reject('memory', { dmae: { wakeGamma: 5 } })
  })
  it('memory.dmae.modelRewardBase 超范围被拒绝', () => {
    reject('memory', { dmae: { modelRewardBase: 100 } })
  })
  it('memory.dmae.wakeLambda 超范围被拒绝', () => {
    reject('memory', { dmae: { wakeLambda: 5 } })
  })
  it('memory.dmae.decayAlpha 超范围被拒绝', () => {
    reject('memory', { dmae: { decayAlpha: 5 } })
  })
  it('memory.dmae.decayBeta 超范围被拒绝', () => {
    reject('memory', { dmae: { decayBeta: 5 } })
  })

  // === memory 域 ===
  it('memory.enabled 非布尔被拒绝', () => {
    reject('memory', { enabled: 'yes' })
  })
  it('memory.embeddingDimension 超范围被拒绝', () => {
    reject('memory', { embeddingDimension: 10 })
  })
  it('memory.maxActive 超范围被拒绝', () => {
    reject('memory', { maxActive: 0 })
  })
  it('memory.minRetrievalScore 超范围被拒绝', () => {
    reject('memory', { minRetrievalScore: 5 })
  })
  it('memory.embeddingProvider 非字符串被拒绝', () => {
    reject('memory', { embeddingProvider: 123 })
  })
  it('memory.embeddingModel 非字符串被拒绝', () => {
    reject('memory', { embeddingModel: 123 })
  })
  it('memory 合法值通过', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { memory: { enabled: false, embeddingDimension: 1024, maxActive: 15 } }
      })
    ).toBe(true)
  })

  // === ui.window 子对象 ===
  it('ui.window.height 超范围被拒绝', () => {
    reject('ui', { window: { height: 100 } })
  })
  it('ui.window.maximized 非布尔被拒绝', () => {
    reject('ui', { window: { maximized: 'yes' } })
  })
  it('ui.window.x 非整数被拒绝', () => {
    reject('ui', { window: { x: 1.5 } })
  })
  it('ui.window.y 非整数被拒绝', () => {
    reject('ui', { window: { y: 2.5 } })
  })
  it('ui.window.x/y 合法整数通过', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { ui: { window: { x: 100, y: 200 } } }
      })
    ).toBe(true)
  })

  // === ui.chat 子对象 ===
  it('ui.chat.sendOnEnter 非布尔被拒绝', () => {
    reject('ui', { chat: { sendOnEnter: 'yes' } })
  })
  it('ui.chat.showTimestamps 非布尔被拒绝', () => {
    reject('ui', { chat: { showTimestamps: 'yes' } })
  })

  // === ui.live2d 子对象 ===
  it('ui.live2d.enabled 非布尔被拒绝', () => {
    reject('ui', { live2d: { enabled: 'yes' } })
  })
  it('ui.live2d.zoom 超范围被拒绝', () => {
    reject('ui', { live2d: { zoom: 10 } })
  })
  it('ui.live2d.alwaysOnTop 非布尔被拒绝', () => {
    reject('ui', { live2d: { alwaysOnTop: 'yes' } })
  })
  it('ui 有多余字段被拒绝', () => {
    reject('ui', { injection: 'bad' })
  })

  // === security 域 ===
  it('security 有多余字段被拒绝', () => {
    reject('security', { injection: 'bad' })
  })
  it('security.allowHttpLocalhostInDev 非布尔被拒绝', () => {
    reject('security', { allowHttpLocalhostInDev: 'yes' })
  })

  // === ConfigUpdateRequest 顶层结构 ===
  it('ConfigUpdateRequest 非对象被拒绝', () => {
    expect(validateIpcPayload('companion:config:update', 'not-an-object')).toBe(false)
  })
  it('ConfigUpdateRequest 有多余字段被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: {},
        injection: 'bad'
      })
    ).toBe(false)
  })
})
