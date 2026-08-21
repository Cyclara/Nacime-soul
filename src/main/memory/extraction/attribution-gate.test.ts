// src/main/memory/extraction/attribution-gate.test.ts
// M-42：L0 归属语义门。依据 docs/reviews/2026-08-13-全仓审查与修复清单.md M-42 验收：
//   - 双模型批量判定（一次 API 调用、temperature=0、小预算）
//   - 语义门故障注入（超时/malformed -> 返回 null -> 调用方回退正则路径）
//   - 配置面独立归因门模型解析（默认回退提取同款）
import { describe, it, expect } from 'vitest'
import { AppError } from '@shared/errors'
import { testNoopLogger } from '../../../../tests/helpers/test-db'
import {
  ATTRIBUTION_MAX_OUTPUT_TOKENS,
  ATTRIBUTION_TIMEOUT_MS,
  createAttributionGate,
  parseAttributionVerdicts,
  resolveAttributionGateTarget,
  type AttributionGateItem
} from './attribution-gate'
import { createFauxExtractionProvider, type ExtractionProvider } from './provider'

const ITEMS: AttributionGateItem[] = [
  {
    candidateId: 't1:0',
    field: 'preferredName',
    content: '伙伴',
    quotes: ['以后你可以称我为伙伴']
  },
  {
    candidateId: 't1:1',
    field: 'dislikes',
    content: '对现在的教学方式感到失望',
    quotes: ['我对现在的教学方式挺失望的']
  }
]

const VALID_RESPONSE = JSON.stringify({
  schemaVersion: 1,
  verdicts: [
    { id: 't1:0', userSelfStatement: true, assistantDirected: false },
    { id: 't1:1', userSelfStatement: true, assistantDirected: false }
  ]
})

describe('M-42 parseAttributionVerdicts（严格解析，不符即 null）', () => {
  const ids = ['t1:0', 't1:1']

  it('合法响应 -> Map（两个布尔原样保留）', () => {
    const out = parseAttributionVerdicts(VALID_RESPONSE, ids)
    expect(out).not.toBeNull()
    expect(out!.size).toBe(2)
    expect(out!.get('t1:0')).toEqual({ userSelfStatement: true, assistantDirected: false })
  })

  it('malformed JSON -> null', () => {
    expect(parseAttributionVerdicts('{not json', ids)).toBeNull()
    expect(parseAttributionVerdicts('', ids)).toBeNull()
  })

  it('顶层非对象 / schemaVersion 不符 / verdicts 非数组 -> null', () => {
    expect(parseAttributionVerdicts('[]', ids)).toBeNull()
    expect(
      parseAttributionVerdicts(JSON.stringify({ schemaVersion: 2, verdicts: [] }), ids)
    ).toBeNull()
    expect(
      parseAttributionVerdicts(JSON.stringify({ schemaVersion: 1, verdicts: {} }), ids)
    ).toBeNull()
  })

  it('verdicts 数量与期望不一致（少/多）-> null（不逐项救）', () => {
    const fewer = JSON.stringify({
      schemaVersion: 1,
      verdicts: [{ id: 't1:0', userSelfStatement: true, assistantDirected: false }]
    })
    expect(parseAttributionVerdicts(fewer, ids)).toBeNull()
    const more = JSON.stringify({
      schemaVersion: 1,
      verdicts: [
        { id: 't1:0', userSelfStatement: true, assistantDirected: false },
        { id: 't1:1', userSelfStatement: true, assistantDirected: false },
        { id: 't1:2', userSelfStatement: true, assistantDirected: false }
      ]
    })
    expect(parseAttributionVerdicts(more, ['t1:0', 't1:1', 't1:2'])).not.toBeNull()
    expect(parseAttributionVerdicts(more, ids)).toBeNull()
  })

  it('未知 id / 重复 id / 非布尔字段 / 非对象条目 -> null', () => {
    const mk = (verdicts: unknown[]): string => JSON.stringify({ schemaVersion: 1, verdicts })
    const v0 = { id: 't1:0', userSelfStatement: true, assistantDirected: false }
    const v1 = { id: 't1:1', userSelfStatement: true, assistantDirected: false }
    expect(parseAttributionVerdicts(mk([v0, { ...v1, id: 'other:9' }]), ids)).toBeNull()
    expect(parseAttributionVerdicts(mk([v0, { ...v1, id: 't1:0' }]), ids)).toBeNull()
    expect(parseAttributionVerdicts(mk([v0, { ...v1, userSelfStatement: 'true' }]), ids)).toBeNull()
    expect(parseAttributionVerdicts(mk([v0, 'nope']), ids)).toBeNull()
  })
})

describe('M-42 createAttributionGate', () => {
  it('合法响应 -> 返回 Map；请求画像 temperature=0/小预算/短超时，候选打包进 user 数据块', async () => {
    const faux = createFauxExtractionProvider()
    faux.setResponses([VALID_RESPONSE])
    const gate = createAttributionGate({ provider: faux, logger: testNoopLogger })

    const out = await gate.judgeL0Batch(ITEMS)
    expect(out).not.toBeNull()
    expect(out!.get('t1:0')?.userSelfStatement).toBe(true)

    expect(faux.calls()).toHaveLength(1)
    const req = faux.calls()[0]
    expect(req.temperature).toBe(0)
    expect(req.maxOutputTokens).toBe(ATTRIBUTION_MAX_OUTPUT_TOKENS)
    expect(req.timeoutMs).toBe(ATTRIBUTION_TIMEOUT_MS)
    expect(req.messages[0].role).toBe('system')
    // 一次调用打包全部候选（id/field/content/quotes 都在数据块里）
    expect(req.messages).toHaveLength(2)
    expect(req.messages[1].content).toContain('t1:0')
    expect(req.messages[1].content).toContain('t1:1')
    expect(req.messages[1].content).toContain('preferredName')
  })

  it('空 items -> 空 Map 且不发 API 调用', async () => {
    const faux = createFauxExtractionProvider()
    const gate = createAttributionGate({ provider: faux, logger: testNoopLogger })
    const out = await gate.judgeL0Batch([])
    expect(out).not.toBeNull()
    expect(out!.size).toBe(0)
    expect(faux.calls()).toHaveLength(0)
  })

  it('故障注入：provider 抛错（超时/网络）-> null 且不 rethrow（fail-closed）', async () => {
    const throwing: ExtractionProvider = {
      complete: async () => {
        throw new AppError({
          code: 'LLM_SERVER',
          userMessage: 'timeout',
          severity: 'error',
          retryable: true
        })
      }
    }
    const gate = createAttributionGate({ provider: throwing, logger: testNoopLogger })
    await expect(gate.judgeL0Batch(ITEMS)).resolves.toBeNull()

    const plainThrow: ExtractionProvider = {
      complete: async () => {
        throw new Error('boom')
      }
    }
    const gate2 = createAttributionGate({ provider: plainThrow, logger: testNoopLogger })
    await expect(gate2.judgeL0Batch(ITEMS)).resolves.toBeNull()
  })

  it('故障注入：malformed 响应（缺 id/非布尔/坏 JSON）-> null（回退正则路径）', async () => {
    const faux = createFauxExtractionProvider()
    faux.setResponses([
      '{"schemaVersion":1,"verdicts":[{"id":"t1:0","userSelfStatement":"yes","assistantDirected":false},{"id":"t1:1","userSelfStatement":true,"assistantDirected":false}]}',
      'not json at all',
      JSON.stringify({
        schemaVersion: 1,
        verdicts: [{ id: 't1:0', userSelfStatement: true, assistantDirected: false }]
      })
    ])
    const gate = createAttributionGate({ provider: faux, logger: testNoopLogger })
    await expect(gate.judgeL0Batch(ITEMS)).resolves.toBeNull()
    await expect(gate.judgeL0Batch(ITEMS)).resolves.toBeNull()
    await expect(gate.judgeL0Batch(ITEMS)).resolves.toBeNull()
  })
})

describe('M-42 resolveAttributionGateTarget（配置面：默认回退提取同款）', () => {
  const chat = { provider: 'deepseek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' }

  it('全空配置 -> 回退 chat 模型三件套，reuseExtraction=true', () => {
    const out = resolveAttributionGateTarget(
      { attributionGate: { provider: '', model: '', baseUrl: '' } },
      chat
    )
    expect(out).toEqual({ ...chat, reuseExtraction: true })
  })

  it('只配 model -> provider/baseUrl 回退 chat，reuseExtraction=false', () => {
    const out = resolveAttributionGateTarget(
      { attributionGate: { provider: '', model: 'qwen-turbo', baseUrl: '' } },
      chat
    )
    expect(out.provider).toBe('deepseek')
    expect(out.model).toBe('qwen-turbo')
    expect(out.baseUrl).toBe('https://api.deepseek.com')
    expect(out.reuseExtraction).toBe(false)
  })

  it('全量独立配置 -> 全部自定义，reuseExtraction=false', () => {
    const custom = {
      provider: 'qwen',
      model: 'qwen-turbo',
      baseUrl: 'https://dashscope.example.com'
    }
    const out = resolveAttributionGateTarget({ attributionGate: custom }, chat)
    expect(out).toEqual({ ...custom, reuseExtraction: false })
  })

  it('三件套与 chat 完全一致（显式填写）-> reuseExtraction=true', () => {
    const out = resolveAttributionGateTarget({ attributionGate: { ...chat } }, chat)
    expect(out.reuseExtraction).toBe(true)
  })
})
