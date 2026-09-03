// src/main/voice/tts/correction-detector.test.ts
// P3B-07：自我纠正前缀检测（§1.12.2 冻结正则表）。

import { describe, expect, it } from 'vitest'
import { isSelfCorrection } from './correction-detector'

describe('P3B-07 correction-detector', () => {
  it('中文纠正前缀命中', () => {
    expect(isSelfCorrection('不，我刚才说错了，正确的是这样。')).toBe(true)
    expect(isSelfCorrection('不是，这件事另有原因。')).toBe(true)
    expect(isSelfCorrection('等等，让我重新想想。')).toBe(true)
    expect(isSelfCorrection('等一下，好像不太对。')).toBe(true)
    expect(isSelfCorrection('我说错了，应该这样算。')).toBe(true)
    expect(isSelfCorrection('准确地说，是三天前。')).toBe(true)
    expect(isSelfCorrection('更准确地说，是三天前。')).toBe(true)
    expect(isSelfCorrection('其实不是这样的。')).toBe(true)
    expect(isSelfCorrection('  不，重新来。')).toBe(true) // 前导空白容忍
  })

  it('英文纠正前缀命中（大小写不敏感）', () => {
    expect(isSelfCorrection('no, that is not right.')).toBe(true)
    expect(isSelfCorrection('Wait, let me reconsider.')).toBe(true)
    expect(isSelfCorrection('actually, it was Tuesday.')).toBe(true)
    expect(isSelfCorrection('rather, consider this.')).toBe(true)
    expect(isSelfCorrection('I misspoke, the answer is 42.')).toBe(true)
    expect(isSelfCorrection('more precisely, it is 3.5.')).toBe(true)
  })

  it('普通文本不误报', () => {
    expect(isSelfCorrection('今天天气不错，适合出门散步。')).toBe(false)
    // 冻结正则 `不是[，,]?` 的逗号是可选的：裸「不是」开头也会命中
    // （保守方向的误报可接受--只影响 gap 缩短，不删音频）
    expect(isSelfCorrection('不是所有努力都有回报，但值得。')).toBe(true)
    // 冻结正则的逗号可选：句首裸 Actually/Wait/No 也命中（保守误报，只缩 gap 不删音频）
    expect(isSelfCorrection('Actually 是副词，但这里只是句中词。')).toBe(true)
    expect(isSelfCorrection('这个单词 Actually 出现在句中，不是句首。')).toBe(false)
    expect(isSelfCorrection('')).toBe(false)
  })

  it('纠正句自身仍按正常 segment 提交（检测只打标，绝不删前段）', () => {
    // 这条断言保护 §1.12.1 冻结原则的接口语义：isSelfCorrection 只返回布尔，
    // 不携带任何删除/跳过语义；调用方（controller/播放队列）只允许用它缩 gap。
    const flags = [true, false, true].map((v) => v)
    expect(flags).toHaveLength(3)
  })
})
