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
import { CONFIG_DOMAINS } from '@shared/config/types'
import type { ConfigDomain } from '@shared/config/types'
import { DEFAULT_CONFIG_V1 } from '../config/defaults'

// === S-004 #5：每个 invoke channel 都存在 validator ===

describe('P1-11 IPC_VALIDATORS 全覆盖', () => {
  it('IPC_INVOKE_CHANNELS 的每个通道都在 IPC_VALIDATORS 中有 validator', () => {
    for (const channel of IPC_INVOKE_CHANNELS) {
      expect(IPC_VALIDATORS[channel]).toBeDefined()
      expect(typeof IPC_VALIDATORS[channel]).toBe('function')
    }
  })

  it('IPC_VALIDATORS 的 key 数量与 IPC_INVOKE_CHANNELS 一致（P3A-25 取景预览通道后 = 60）', () => {
    expect(Object.keys(IPC_VALIDATORS)).toHaveLength(60)
    expect(IPC_INVOKE_CHANNELS).toHaveLength(60)
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
    'companion:debug:open-log-folder',
    // Phase 2 undefined 通道
    'companion:memory:get-overview',
    'companion:memory:get-l0',
    'companion:memory:get-dmae-snapshot',
    'companion:growth:get-profile',
    // M-50：自动更新（undefined 载荷）
    'companion:app:check-for-updates',
    'companion:app:get-update-status',
    'companion:app:quit-and-install'
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

describe('验收反馈⑥ ChatDeleteTurnRequest validator', () => {
  it('合法 payload 通过', () => {
    expect(
      validateIpcPayload('companion:chat:delete-turn', {
        sessionId: 'sess_01JG',
        messageId: 'msg_abc123'
      })
    ).toBe(true)
  })

  it('缺字段 / 多余字段 / 非字符串被拒绝', () => {
    expect(validateIpcPayload('companion:chat:delete-turn', { sessionId: 'sess_01JG' })).toBe(false)
    expect(
      validateIpcPayload('companion:chat:delete-turn', {
        sessionId: 'sess_01JG',
        messageId: 'msg_abc',
        turnId: 't1'
      })
    ).toBe(false)
    expect(
      validateIpcPayload('companion:chat:delete-turn', { sessionId: 'sess_01JG', messageId: 42 })
    ).toBe(false)
  })
})

describe('验收反馈⑥c ChatDeleteMessageRequest validator', () => {
  it('合法 payload 通过', () => {
    expect(
      validateIpcPayload('companion:chat:delete-message', {
        sessionId: 'sess_01JG',
        messageId: 'msg_abc123'
      })
    ).toBe(true)
  })

  it('缺字段 / 多余字段被拒绝', () => {
    expect(validateIpcPayload('companion:chat:delete-message', { sessionId: 'sess_01JG' })).toBe(
      false
    )
    expect(
      validateIpcPayload('companion:chat:delete-message', {
        sessionId: 'sess_01JG',
        messageId: 'msg_abc',
        scope: 'message'
      })
    ).toBe(false)
  })
})

describe('验收反馈⑦ ChatDeleteSelectedRequest / ChatClearSessionRequest validator', () => {
  it('delete-selected 合法 payload 通过', () => {
    expect(
      validateIpcPayload('companion:chat:delete-selected', {
        sessionId: 'sess_01JG',
        messageIds: ['msg_a', 'msg_b']
      })
    ).toBe(true)
  })

  it('delete-selected：空数组 / 超上限 / 非 id 元素 / 多余字段被拒绝', () => {
    expect(
      validateIpcPayload('companion:chat:delete-selected', {
        sessionId: 'sess_01JG',
        messageIds: []
      })
    ).toBe(false)
    expect(
      validateIpcPayload('companion:chat:delete-selected', {
        sessionId: 'sess_01JG',
        messageIds: Array.from({ length: 501 }, (_, i) => `msg_${i}`)
      })
    ).toBe(false)
    expect(
      validateIpcPayload('companion:chat:delete-selected', {
        sessionId: 'sess_01JG',
        messageIds: ['msg_a', 42]
      })
    ).toBe(false)
    expect(
      validateIpcPayload('companion:chat:delete-selected', {
        sessionId: 'sess_01JG',
        messageIds: ['msg_a'],
        turnId: 't1'
      })
    ).toBe(false)
  })

  it('clear-session 合法 payload 通过；缺字段/多余字段被拒绝', () => {
    expect(validateIpcPayload('companion:chat:clear-session', { sessionId: 'sess_01JG' })).toBe(
      true
    )
    expect(validateIpcPayload('companion:chat:clear-session', {})).toBe(false)
    expect(
      validateIpcPayload('companion:chat:clear-session', {
        sessionId: 'sess_01JG',
        keepPinned: true
      })
    ).toBe(false)
  })

  it('P2-44 search：合法 payload 通过；空 query/超长/坏 limit/多余字段被拒绝', () => {
    expect(validateIpcPayload('companion:chat:search', { query: '天气' })).toBe(true)
    expect(validateIpcPayload('companion:chat:search', { query: 'code', limit: 20 })).toBe(true)
    // query 边界
    expect(validateIpcPayload('companion:chat:search', { query: '' })).toBe(false)
    expect(validateIpcPayload('companion:chat:search', { query: 'x'.repeat(129) })).toBe(false)
    expect(validateIpcPayload('companion:chat:search', { query: 'x'.repeat(128) })).toBe(true)
    expect(validateIpcPayload('companion:chat:search', { query: 42 })).toBe(false)
    // limit 边界
    expect(validateIpcPayload('companion:chat:search', { query: 'a', limit: 0 })).toBe(false)
    expect(validateIpcPayload('companion:chat:search', { query: 'a', limit: 101 })).toBe(false)
    expect(validateIpcPayload('companion:chat:search', { query: 'a', limit: 1.5 })).toBe(false)
    expect(validateIpcPayload('companion:chat:search', { query: 'a', limit: '50' })).toBe(false)
    // 多余字段
    expect(validateIpcPayload('companion:chat:search', { query: 'a', sessionId: 's-1' })).toBe(
      false
    )
  })
})

describe('P3C1-07 ChatFeedbackRequest validator', () => {
  const valid = {
    sessionId: 'sess_01JG',
    turnId: 'turn-1',
    messageId: 'msg-a1',
    kind: 'dislike'
  }

  it('合法 dislike / out-of-character payload 通过', () => {
    expect(validateIpcPayload('companion:chat:feedback', valid)).toBe(true)
    expect(
      validateIpcPayload('companion:chat:feedback', { ...valid, kind: 'out-of-character' })
    ).toBe(true)
  })

  it('非法 kind 被拒绝（白名单外字符串/数字/缺失）', () => {
    expect(validateIpcPayload('companion:chat:feedback', { ...valid, kind: 'like' })).toBe(false)
    expect(validateIpcPayload('companion:chat:feedback', { ...valid, kind: 42 })).toBe(false)
    expect(
      validateIpcPayload('companion:chat:feedback', {
        sessionId: 'sess_01JG',
        turnId: 'turn-1',
        messageId: 'msg-a1'
      })
    ).toBe(false)
  })

  it('缺字段 / 多余字段被拒绝', () => {
    expect(
      validateIpcPayload('companion:chat:feedback', {
        turnId: 'turn-1',
        messageId: 'msg-a1',
        kind: 'dislike'
      })
    ).toBe(false)
    expect(
      validateIpcPayload('companion:chat:feedback', { ...valid, reason: '太长' })
    ).toBe(false)
  })

  it('坏 id（空串/数字/非法字符/超长）与非对象被拒绝', () => {
    expect(validateIpcPayload('companion:chat:feedback', { ...valid, sessionId: '' })).toBe(false)
    expect(validateIpcPayload('companion:chat:feedback', { ...valid, turnId: 7 })).toBe(false)
    expect(validateIpcPayload('companion:chat:feedback', { ...valid, messageId: 'msg a' })).toBe(
      false
    )
    expect(
      validateIpcPayload('companion:chat:feedback', {
        ...valid,
        messageId: `msg_${'x'.repeat(200)}`
      })
    ).toBe(false)
    expect(validateIpcPayload('companion:chat:feedback', null)).toBe(false)
    expect(validateIpcPayload('companion:chat:feedback', [valid])).toBe(false)
    expect(validateIpcPayload('companion:chat:feedback', 'dislike')).toBe(false)
  })
})

describe('P3C1-08 ComplianceSnapshot IPC validator', () => {
  it('companion:compliance:get-snapshot 只接受 undefined（无载荷）', () => {
    expect(validateIpcPayload('companion:compliance:get-snapshot', undefined)).toBe(true)
    expect(validateIpcPayload('companion:compliance:get-snapshot', null)).toBe(false)
    expect(validateIpcPayload('companion:compliance:get-snapshot', {})).toBe(false)
    expect(validateIpcPayload('companion:compliance:get-snapshot', 'snapshot')).toBe(false)
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

  it('全部域都通过（域列表由 CONFIG_DOMAINS 派生，开工裁定 §2.2）', () => {
    for (const domain of CONFIG_DOMAINS) {
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

  it('全量六域默认配置 payload 通过（防配置/schema/validator 三方漂移——M-42 attributionGate 漏加曾致全部设置保存被拒）', () => {
    // 复刻 renderer configStore.save() 的载荷构造：全部域全量深拷贝
    // （PublicModelConfig 扩展字段已在 renderer 侧删除，DEFAULT_CONFIG_V1 本就不含；
    //   域列表由 CONFIG_DOMAINS 派生，新增域自动纳入本测试——开工裁定 §2.2）
    const plain = JSON.parse(JSON.stringify(DEFAULT_CONFIG_V1)) as Record<
      string,
      Record<string, unknown>
    >
    const domains = Object.fromEntries(CONFIG_DOMAINS.map((d) => [d, { ...plain[d] }]))
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains
      })
    ).toBe(true)
  })

  it('memory.attributionGate 形状非法被拒绝', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: {
          memory: { attributionGate: { provider: 42, model: 'x', baseUrl: '' } }
        }
      })
    ).toBe(false)
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: {
          memory: { attributionGate: { provider: '', model: '', baseUrl: '', extra: 1 } }
        }
      })
    ).toBe(false)
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

  it('ui.theme 新注册主题 light2/dark2 放行（注册表驱动）', () => {
    for (const theme of ['light2', 'dark2']) {
      expect(
        validateIpcPayload('companion:config:update', {
          expectedSchemaVersion: 1,
          domains: {
            ui: { theme }
          }
        })
      ).toBe(true)
    }
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

describe('P3G recycle-bin validators', () => {
  it('accepts bounded paging and confirmed destructive empty, rejects malformed input', () => {
    expect(validateIpcPayload('companion:memory:list-recycle-bin', { limit: 50, offset: 0 })).toBe(true)
    expect(validateIpcPayload('companion:memory:list-recycle-bin', { limit: 201, offset: 0 })).toBe(false)
    expect(validateIpcPayload('companion:memory:restore-from-recycle-bin', { memoryId: 'l2_1710000000000_a1' })).toBe(true)
    expect(validateIpcPayload('companion:memory:empty-recycle-bin', { confirm: true })).toBe(true)
    expect(validateIpcPayload('companion:memory:empty-recycle-bin', { confirm: false })).toBe(false)
  })
})

describe('P3X-03 DMAE panel pagination validator', () => {
  it('接受空载荷与有界 stable cursor，拒绝超限/畸形 cursor', () => {
    expect(validateIpcPayload('companion:dmae:get-panel', undefined)).toBe(true)
    expect(validateIpcPayload('companion:dmae:get-panel', {
      eligibleLimit: 100,
      eligibleCursor: { turn: 10, activation: 50, memoryId: 'l2_1700000000000_abc' }
    })).toBe(true)
    expect(validateIpcPayload('companion:dmae:get-panel', { eligibleLimit: 201 })).toBe(false)
    expect(validateIpcPayload('companion:dmae:get-panel', {
      eligibleCursor: { turn: -1, activation: 50, memoryId: 'l2_1700000000000_abc' }
    })).toBe(false)
    expect(validateIpcPayload('companion:dmae:get-panel', { unexpected: true })).toBe(false)
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
  function reject(domain: ConfigDomain, patch: Record<string, unknown>): void {
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

  // === P2-31.5A：四字段 IPC validator（S-005-补充 §1.7 / §3.3）===

  // CFG-DMAE-05（IPC 部分）：windows R14 / R06.days -> IPC validator 拒绝
  it('CFG-DMAE-05: anomaly.windows R14 -> IPC 拒绝', () => {
    reject('memory', {
      dmae: { anomaly: { windows: { R14: { days: 3 } } } }
    })
  })
  it('CFG-DMAE-05: anomaly.windows R06.days -> IPC 拒绝（R06 不支持 days）', () => {
    reject('memory', {
      dmae: { anomaly: { windows: { R06: { days: 3 } } } }
    })
  })
  it('CFG-DMAE-05: anomaly.windows R10.days 合法 -> IPC 接受', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: {
          memory: { dmae: { anomaly: { windows: { R10: { days: 5 } } } } }
        }
      })
    ).toBe(true)
  })
  it('CFG-DMAE-05: anomaly.muted.R07 合法 -> IPC 接受', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: {
          memory: { dmae: { anomaly: { muted: { R07: 9999999999 } } } }
        }
      })
    ).toBe(true)
  })
  it('CFG-DMAE-05: anomaly.muted.R14 -> IPC 拒绝（未知规则 ID）', () => {
    reject('memory', {
      dmae: { anomaly: { muted: { R14: 100 } } }
    })
  })

  // CFG-DMAE-06（IPC 部分）：historySampleEveryTurns 边界
  it('CFG-DMAE-06: historySampleEveryTurns=10 -> IPC 接受', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { memory: { dmae: { historySampleEveryTurns: 10 } } }
      })
    ).toBe(true)
  })
  it('CFG-DMAE-06: historySampleEveryTurns=0 -> IPC 拒绝', () => {
    reject('memory', { dmae: { historySampleEveryTurns: 0 } })
  })
  it('CFG-DMAE-06: historySampleEveryTurns=11 -> IPC 拒绝', () => {
    reject('memory', { dmae: { historySampleEveryTurns: 11 } })
  })

  // CFG-DMAE-08（IPC 部分）：第 51 个预设、重复 id、builtin:true -> IPC 拒绝
  it('CFG-DMAE-08: presets 含 builtin:true -> IPC 拒绝', () => {
    reject('memory', {
      dmae: {
        presets: [
          {
            id: 'preset.user.test',
            name: 't',
            description: '',
            baseline: 'default',
            overrides: {},
            builtin: true,
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }
    })
  })
  it('CFG-DMAE-08: presets 重复 id -> IPC 拒绝', () => {
    reject('memory', {
      dmae: {
        presets: [
          {
            id: 'preset.user.dup',
            name: 'a',
            description: '',
            baseline: 'default',
            overrides: {},
            builtin: false,
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'preset.user.dup',
            name: 'b',
            description: '',
            baseline: 'default',
            overrides: {},
            builtin: false,
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }
    })
  })
  it('CFG-DMAE-08: preset id 不匹配命名空间 -> IPC 拒绝', () => {
    reject('memory', {
      dmae: {
        presets: [
          {
            id: 'bad-id',
            name: 't',
            description: '',
            baseline: 'default',
            overrides: {},
            builtin: false,
            createdAt: 1,
            updatedAt: 1
          }
        ]
      }
    })
  })
  it('CFG-DMAE-08: preset updatedAt < createdAt -> IPC 拒绝', () => {
    reject('memory', {
      dmae: {
        presets: [
          {
            id: 'preset.user.test',
            name: 't',
            description: '',
            baseline: 'default',
            overrides: {},
            builtin: false,
            createdAt: 100,
            updatedAt: 50
          }
        ]
      }
    })
  })
  it('CFG-DMAE-08: presets 空数组合法 -> IPC 接受', () => {
    expect(
      validateIpcPayload('companion:config:update', {
        expectedSchemaVersion: 1,
        domains: { memory: { dmae: { presets: [] } } }
      })
    ).toBe(true)
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
  it('ui.live2d 取景偏移接受 -100..100，越界被拒绝', () => {
    expect(validateIpcPayload('companion:config:update', {
      expectedSchemaVersion: 1,
      domains: { ui: { live2d: { offsetX: -100, offsetY: 100 } } }
    })).toBe(true)
    reject('ui', { live2d: { offsetX: -101 } })
    reject('ui', { live2d: { offsetY: 100.5 } })
  })
  it('ui.live2d.selectedModelId 只接受短 ID，不接受绝对路径', () => {
    expect(validateIpcPayload('companion:config:update', {
      expectedSchemaVersion: 1,
      domains: { ui: { live2d: { selectedModelId: 'mao' } } }
    })).toBe(true)
    reject('ui', { live2d: { selectedModelId: 'C:\\secret.model3.json' } })
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

// === P3A-05: Live2D stage invoke validator ===

describe('P3A-05 Live2D stage invoke validator', () => {
  it('stage:ready 只接受 stageInstanceId', () => {
    expect(validateIpcPayload('companion:stage:ready', { stageInstanceId: 'stage-1' })).toBe(true)
    expect(validateIpcPayload('companion:stage:ready', { stageInstanceId: 'stage-1', extra: true })).toBe(false)
    expect(validateIpcPayload('companion:stage:ready', { stageInstanceId: '' })).toBe(false)
  })

  it('stage:report-state 接受固定状态和有界数值，拒绝正文/多余字段', () => {
    expect(
      validateIpcPayload('companion:stage:report-state', {
        stageInstanceId: 'stage-1',
        status: 'ready',
        fps: 60,
        modelLoadMs: 120
      })
    ).toBe(true)
    expect(
      validateIpcPayload('companion:stage:report-state', {
        stageInstanceId: 'stage-1',
        status: 'error',
        errorCode: 'L2D_MODEL_LOAD',
        detail: 'untrusted free text'
      })
    ).toBe(false)
    expect(
      validateIpcPayload('companion:stage:report-state', {
        stageInstanceId: 'stage-1',
        status: 'unknown'
      })
    ).toBe(false)
  })

  it('stage-command event 是穷举载荷，任意命令、越界尺寸与缩放均被拒绝', () => {
    expect(validateEventPayload('companion:event:stage-command', { type: 'pause' })).toBe(true)
    expect(validateEventPayload('companion:event:stage-command', { type: 'set-zoom', zoom: 1.5 })).toBe(true)
    expect(
      validateEventPayload('companion:event:stage-command', { type: 'resize', width: 640, height: 480 })
    ).toBe(true)
    expect(
      validateEventPayload('companion:event:stage-command', { type: 'set-offset', offsetX: -100, offsetY: 50 })
    ).toBe(true)
    expect(validateEventPayload('companion:event:stage-command', { type: 'shell', command: 'x' })).toBe(false)
    expect(validateEventPayload('companion:event:stage-command', { type: 'set-zoom', zoom: 3.01 })).toBe(false)
    expect(
      validateEventPayload('companion:event:stage-command', { type: 'set-offset', offsetX: -100.5, offsetY: 0 })
    ).toBe(false)
    expect(
      validateEventPayload('companion:event:stage-command', { type: 'set-offset', offsetX: 0 })
    ).toBe(false)
    expect(
      validateEventPayload('companion:event:stage-command', { type: 'resize', width: 99999, height: 1 })
    ).toBe(false)
    // load-model 的 expressionNames 是可选增量（2026-08-29）：名单来自模型作者，数量与
    // 单条长度都必须有界，且不接受非字符串成员。
    const url = 'nacime-live2d://model/mao/Mao.model3.json'
    expect(validateEventPayload('companion:event:stage-command', { type: 'load-model', modelUrl: url })).toBe(true)
    expect(
      validateEventPayload('companion:event:stage-command', { type: 'load-model', modelUrl: url, expressionNames: [] })
    ).toBe(true)
    expect(
      validateEventPayload('companion:event:stage-command', { type: 'load-model', modelUrl: url, expressionNames: ['exp_01', 'exp_02'] })
    ).toBe(true)
    expect(
      validateEventPayload('companion:event:stage-command', { type: 'load-model', modelUrl: url, expressionNames: Array.from({ length: 65 }, (_, i) => `exp_${i}`) })
    ).toBe(false)
    expect(
      validateEventPayload('companion:event:stage-command', { type: 'load-model', modelUrl: url, expressionNames: ['a'.repeat(65)] })
    ).toBe(false)
    expect(
      validateEventPayload('companion:event:stage-command', { type: 'load-model', modelUrl: url, expressionNames: [''] })
    ).toBe(false)
    expect(
      validateEventPayload('companion:event:stage-command', { type: 'load-model', modelUrl: url, expressionNames: [1] })
    ).toBe(false)
    expect(
      validateEventPayload('companion:event:stage-command', { type: 'load-model', modelUrl: url, expressionNames: 'exp_01' })
    ).toBe(false)
    expect(
      validateEventPayload('companion:event:stage-command', { type: 'load-model', modelUrl: url, extra: 1 })
    ).toBe(false)
  })

  it('preview-framing 只接受合同内构图或 null，拒绝多余键与越界值', () => {
    expect(validateIpcPayload('companion:live2d:preview-framing', { framing: null })).toBe(true)
    expect(
      validateIpcPayload('companion:live2d:preview-framing', {
        framing: { zoom: 0.5, offsetX: -100, offsetY: 100 }
      })
    ).toBe(true)
    expect(
      validateIpcPayload('companion:live2d:preview-framing', {
        framing: { zoom: 3.5, offsetX: 0, offsetY: 0 }
      })
    ).toBe(false)
    expect(
      validateIpcPayload('companion:live2d:preview-framing', {
        framing: { zoom: 1, offsetX: 0, offsetY: 101 }
      })
    ).toBe(false)
    expect(
      validateIpcPayload('companion:live2d:preview-framing', { framing: { zoom: 1, offsetX: 0 } })
    ).toBe(false)
    expect(
      validateIpcPayload('companion:live2d:preview-framing', {
        framing: { zoom: 1, offsetX: 0, offsetY: 0, modelPath: 'C:/secret' }
      })
    ).toBe(false)
    expect(validateIpcPayload('companion:live2d:preview-framing', undefined)).toBe(false)
  })

  it('live2d-state event 验证完整 DTO，并拒绝 runtime rationale/content 注入', () => {
    const valid = {
      models: [], selectedModelId: null, loadedModelId: null,
      window: { visible: false, alwaysOnTop: true, zoom: 1, offsetX: 0, offsetY: 0, stageStatus: 'closed' },
      loading: false, lastError: null, revision: 1, lastEventSequence: 2, sequence: 2
    }
    expect(validateEventPayload('companion:event:live2d-state', valid)).toBe(true)
    expect(validateEventPayload('companion:event:live2d-state', {
      ...valid, window: { ...valid.window, offsetY: 101 }
    })).toBe(false)
    expect(validateEventPayload('companion:event:live2d-state', { ...valid, rationale: 'secret' })).toBe(false)
    expect(validateEventPayload('companion:event:live2d-state', {
      ...valid, lastError: { code: 'MODEL_JSON_INVALID', retryable: true, suggestedAction: 'retry', rationale: 'secret' }
    })).toBe(false)
  })
})

// === P2-29: memory + growth validator（12 invoke + 1 event）===

describe('P2-29 memory/growth invoke validator', () => {
  // memory:list-l2
  it('list-l2 合法通过', () => {
    expect(
      validateIpcPayload('companion:memory:list-l2', {
        state: 'active',
        search: '咖啡',
        limit: 50,
        offset: 0
      })
    ).toBe(true)
    expect(validateIpcPayload('companion:memory:list-l2', { limit: 1, offset: 0 })).toBe(true)
  })
  it('list-l2 非法 state/limit/offset 被拒绝', () => {
    expect(
      validateIpcPayload('companion:memory:list-l2', { state: 'purged', limit: 50, offset: 0 })
    ).toBe(false)
    expect(validateIpcPayload('companion:memory:list-l2', { limit: 0, offset: 0 })).toBe(false)
    expect(validateIpcPayload('companion:memory:list-l2', { limit: 201, offset: 0 })).toBe(false)
    expect(validateIpcPayload('companion:memory:list-l2', { limit: 50, offset: -1 })).toBe(false)
    expect(validateIpcPayload('companion:memory:list-l2', { limit: 50, offset: 0, extra: 1 })).toBe(
      false
    )
  })

  // memory:get-detail
  it('get-detail 合法 memoryId 通过', () => {
    expect(
      validateIpcPayload('companion:memory:get-detail', { memoryId: 'l2_1700000000000_abc123' })
    ).toBe(true)
  })
  it('get-detail 非法 memoryId 被拒绝', () => {
    expect(validateIpcPayload('companion:memory:get-detail', { memoryId: 'bad_id' })).toBe(false)
    expect(validateIpcPayload('companion:memory:get-detail', { memoryId: 'l2_abc' })).toBe(false)
    expect(validateIpcPayload('companion:memory:get-detail', { id: 'l2_1_a' })).toBe(false)
  })

  // memory:set-pinned
  it('set-pinned 合法通过', () => {
    expect(
      validateIpcPayload('companion:memory:set-pinned', { memoryId: 'l2_1_a', pinned: true })
    ).toBe(true)
    expect(
      validateIpcPayload('companion:memory:set-pinned', { memoryId: 'l2_1_a', pinned: false })
    ).toBe(true)
  })
  it('set-pinned 非法 pinned 被拒绝', () => {
    expect(
      validateIpcPayload('companion:memory:set-pinned', { memoryId: 'l2_1_a', pinned: 'yes' })
    ).toBe(false)
  })

  // memory:soft-delete
  it('soft-delete confirm 必须为字面量 true', () => {
    expect(
      validateIpcPayload('companion:memory:soft-delete', { memoryId: 'l2_1_a', confirm: true })
    ).toBe(true)
    expect(
      validateIpcPayload('companion:memory:soft-delete', { memoryId: 'l2_1_a', confirm: false })
    ).toBe(false)
    expect(validateIpcPayload('companion:memory:soft-delete', { memoryId: 'l2_1_a' })).toBe(false)
  })

  // memory:restore
  it('restore 合法通过', () => {
    expect(validateIpcPayload('companion:memory:restore', { memoryId: 'l2_1_a' })).toBe(true)
  })

  // M-44 memory:update-content
  it('update-content：合法通过；空串/超长/多字段拒绝', () => {
    expect(
      validateIpcPayload('companion:memory:update-content', {
        memoryId: 'l2_1_a',
        content: '改过的内容'
      })
    ).toBe(true)
    // 空串拒绝（trim 后为空由 handler 再判；validator 先挡真空串）
    expect(
      validateIpcPayload('companion:memory:update-content', { memoryId: 'l2_1_a', content: '' })
    ).toBe(false)
    // 501 字符超长（上限与提取管线 judge L2=500 一致）
    expect(
      validateIpcPayload('companion:memory:update-content', {
        memoryId: 'l2_1_a',
        content: 'x'.repeat(501)
      })
    ).toBe(false)
    expect(
      validateIpcPayload('companion:memory:update-content', {
        memoryId: 'l2_1_a',
        content: 'x'.repeat(500)
      })
    ).toBe(true)
    // 多余字段拒绝
    expect(
      validateIpcPayload('companion:memory:update-content', {
        memoryId: 'l2_1_a',
        content: 'x',
        extra: 1
      })
    ).toBe(false)
    // 非字符串 content 拒绝
    expect(
      validateIpcPayload('companion:memory:update-content', { memoryId: 'l2_1_a', content: 42 })
    ).toBe(false)
  })

  // M-44 memory:set-l0-field
  it('set-l0-field：白名单字段通过；未知字段/超长/多字段拒绝', () => {
    expect(
      validateIpcPayload('companion:memory:set-l0-field', { field: 'occupation', value: '工程师' })
    ).toBe(true)
    // 空串合法（= 清空字段）
    expect(validateIpcPayload('companion:memory:set-l0-field', { field: 'likes', value: '' })).toBe(
      true
    )
    // 蛇形字段名（白名单成员）
    expect(
      validateIpcPayload('companion:memory:set-l0-field', {
        field: 'relationship_status',
        value: '单身'
      })
    ).toBe(true)
    // 非白名单字段拒绝（防任意键注入 L0）
    expect(
      validateIpcPayload('companion:memory:set-l0-field', { field: 'password', value: 'x' })
    ).toBe(false)
    expect(
      validateIpcPayload('companion:memory:set-l0-field', { field: 'Occupation', value: 'x' })
    ).toBe(false)
    // 121 字符超长（上限与提取管线 judge L0=120 一致）
    expect(
      validateIpcPayload('companion:memory:set-l0-field', {
        field: 'likes',
        value: 'x'.repeat(121)
      })
    ).toBe(false)
    expect(
      validateIpcPayload('companion:memory:set-l0-field', {
        field: 'likes',
        value: 'x'.repeat(120)
      })
    ).toBe(true)
    // 多余字段拒绝
    expect(
      validateIpcPayload('companion:memory:set-l0-field', { field: 'likes', value: 'x', extra: 1 })
    ).toBe(false)
  })

  // memory:get-dmae-history
  it('get-dmae-history days 必须为 7|30|90', () => {
    expect(
      validateIpcPayload('companion:memory:get-dmae-history', { memoryId: 'l2_1_a', days: 7 })
    ).toBe(true)
    expect(
      validateIpcPayload('companion:memory:get-dmae-history', { memoryId: 'l2_1_a', days: 30 })
    ).toBe(true)
    expect(
      validateIpcPayload('companion:memory:get-dmae-history', { memoryId: 'l2_1_a', days: 90 })
    ).toBe(true)
    expect(
      validateIpcPayload('companion:memory:get-dmae-history', { memoryId: 'l2_1_a', days: 14 })
    ).toBe(false)
    expect(
      validateIpcPayload('companion:memory:get-dmae-history', { memoryId: 'bad', days: 7 })
    ).toBe(false)
  })

  // growth:get-timeline
  it('get-timeline limit 1..100', () => {
    expect(validateIpcPayload('companion:growth:get-timeline', { limit: 10 })).toBe(true)
    expect(validateIpcPayload('companion:growth:get-timeline', { limit: 0 })).toBe(false)
    expect(validateIpcPayload('companion:growth:get-timeline', { limit: 101 })).toBe(false)
    expect(validateIpcPayload('companion:growth:get-timeline', { limit: 10.5 })).toBe(false)
  })

  // growth:get-trend
  it('get-trend metric 白名单 + days picklist', () => {
    expect(
      validateIpcPayload('companion:growth:get-trend', { metric: 'understanding', days: 7 })
    ).toBe(true)
    expect(
      validateIpcPayload('companion:growth:get-trend', { metric: 'l0FillRate', days: 30 })
    ).toBe(true)
    expect(validateIpcPayload('companion:growth:get-trend', { metric: 'l2Total', days: 90 })).toBe(
      true
    )
    expect(validateIpcPayload('companion:growth:get-trend', { metric: 'bad', days: 7 })).toBe(false)
    expect(
      validateIpcPayload('companion:growth:get-trend', { metric: 'understanding', days: 14 })
    ).toBe(false)
  })

  // undefined 通道（Phase 2 新增 4 个）
  it('get-overview/get-l0/get-dmae-snapshot/get-profile 只收 undefined', () => {
    expect(validateIpcPayload('companion:memory:get-overview', undefined)).toBe(true)
    expect(validateIpcPayload('companion:memory:get-overview', { extra: 1 })).toBe(false)
    expect(validateIpcPayload('companion:memory:get-l0', undefined)).toBe(true)
    expect(validateIpcPayload('companion:memory:get-dmae-snapshot', undefined)).toBe(true)
    expect(validateIpcPayload('companion:growth:get-profile', undefined)).toBe(true)
  })
})

describe('P2-29 memory-updated event validator', () => {
  it('合法 MemoryUpdatedEvent 通过', () => {
    expect(
      validateEventPayload('companion:event:memory-updated', {
        revision: 5,
        hint: 'l2',
        ts: 1700000000000
      })
    ).toBe(true)
    expect(
      validateEventPayload('companion:event:memory-updated', { revision: 0, hint: 'bulk', ts: 0 })
    ).toBe(true)
  })
  it('非法 hint 被拒绝', () => {
    expect(
      validateEventPayload('companion:event:memory-updated', {
        revision: 1,
        hint: 'unknown',
        ts: 0
      })
    ).toBe(false)
  })
  it('revision 非整数/负数被拒绝', () => {
    expect(
      validateEventPayload('companion:event:memory-updated', { revision: -1, hint: 'l2', ts: 0 })
    ).toBe(false)
    expect(
      validateEventPayload('companion:event:memory-updated', { revision: 1.5, hint: 'l2', ts: 0 })
    ).toBe(false)
  })
  it('多余字段被拒绝', () => {
    expect(
      validateEventPayload('companion:event:memory-updated', {
        revision: 1,
        hint: 'l2',
        ts: 0,
        extra: 1
      })
    ).toBe(false)
  })
})
