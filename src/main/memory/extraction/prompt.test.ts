// src/main/memory/extraction/prompt.test.ts
// 提取 prompt 语义锚点回归（2026-08-20 事件）：
//   forbiddenOverclaims 字段对模型长期零语义（schema 无 description、prompt 无说明），
//   DeepSeek 将其误解为预防性「不得推断清单」逢项必填，触发 Judge 无条件拒（3/3 全灭）。
//   修复 = 在模型唯二可见的位置（system prompt 正文 + schema description）写清
//   「自报夸大、列出即弃用、忠于证据必须留空」。以下锚点防未来 prompt 漂移把语义改丢。
import { describe, it, expect } from 'vitest'
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionMessages } from './prompt'
import { CANDIDATE_ITEM_SCHEMA } from './candidate'

describe('提取 prompt 的 forbiddenOverclaims 语义锚点（2026-08-20 修复）', () => {
  it('system prompt 含自报弃用语义：列出即丢弃、忠于证据留空、不得预防性填写', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('forbiddenOverclaims')
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('自报')
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('丢弃')
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('留空')
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('不得推断清单')
  })

  it('schema description 同样写明自报弃用语义（schema 会逐字嵌进 prompt）', () => {
    const desc = CANDIDATE_ITEM_SCHEMA.properties.forbiddenOverclaims.description
    expect(desc).toBeTruthy()
    expect(desc).toContain('丢弃')
    expect(desc).toContain('空数组')
    expect(desc).toContain('不得推断清单')
  })

  it('buildExtractionMessages 产出的 system 内容确实内嵌了该 description', () => {
    const messages = buildExtractionMessages('msg_test', '内容')
    const system = messages.find((m) => m.role === 'system')
    expect(system).toBeTruthy()
    expect(system?.content).toContain(
      CANDIDATE_ITEM_SCHEMA.properties.forbiddenOverclaims.description
    )
  })
})
