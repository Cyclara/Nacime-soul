// src/renderer/src/live2d/expression/map.test.ts

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXPRESSION_ALIASES,
  aliasesForModel,
  modelIdFromStageUrl,
  resolveExpression
} from './map'

describe('P3A-20 expression map', () => {
  it('语义情绪匹配不区分大小写，至少可映射三种情绪', () => {
    expect(resolveExpression('smile', ['Normal', 'Smile']).resolved).toBe('Smile')
    expect(resolveExpression('surprised', ['surprised']).fallback).toBe(false)
    expect(resolveExpression('sad', ['Sad']).resolved).toBe('Sad')
  })

  it('缺失目标 expression 回 neutral；连 neutral 也缺失则安全空结果', () => {
    expect(resolveExpression('angry', ['normal'])).toMatchObject({
      resolved: 'normal',
      fallback: true
    })
    expect(resolveExpression('angry', [])).toMatchObject({ resolved: '', fallback: true })
  })

  // 2026-08-29：通用表原本带 exp_01..exp_08 编号猜测，与 Mao 的实际 .exp3.json 几乎全错
  // （exp_03 是纯闭眼、exp_06 是害羞、exp_08 是生气）。编号猜测已删，内置模型走显式表。
  it('通用别名表不再包含 exp_0N 编号猜测', () => {
    const all = Object.values(DEFAULT_EXPRESSION_ALIASES).flat()
    expect(all.some((name) => /^exp_\d+$/.test(name))).toBe(false)
  })

  it('Mao 的显式表按 .exp3.json 实际参数映射，而非按编号顺序', () => {
    const mao = aliasesForModel('mao')
    const names = ['exp_01', 'exp_02', 'exp_03', 'exp_04', 'exp_05', 'exp_06', 'exp_07', 'exp_08']
    expect(resolveExpression('neutral', names, mao).resolved).toBe('exp_01')
    expect(resolveExpression('smile', names, mao).resolved).toBe('exp_02') // 闭眼笑
    expect(resolveExpression('happy', names, mao).resolved).toBe('exp_04') // 睁大眼+笑眼
    expect(resolveExpression('sad', names, mao).resolved).toBe('exp_05') // 眉尾/嘴角下垂
    expect(resolveExpression('shy', names, mao).resolved).toBe('exp_06') // 脸红
    expect(resolveExpression('confused', names, mao).resolved).toBe('exp_07')
    expect(resolveExpression('angry', names, mao).resolved).toBe('exp_08') // 怒纹
    // exp_03 是纯闭眼、不是情绪，任何语义情绪都不该映射到它。
    expect(names.filter((n) => Object.values(mao).flat().includes(n))).not.toContain('exp_03')
  })

  it('内置表之外仍可用通用语义名；未知模型只走通用表', () => {
    const mao = aliasesForModel('mao')
    expect(resolveExpression('sad', ['sorrow'], mao).resolved).toBe('sorrow')
    expect(aliasesForModel('some-user-model')).toBe(DEFAULT_EXPRESSION_ALIASES)
    expect(aliasesForModel(null)).toBe(DEFAULT_EXPRESSION_ALIASES)
  })

  it('从受控 URL 取模型 id，非法 URL 返回 null', () => {
    expect(modelIdFromStageUrl('nacime-live2d://model/mao/Mao.model3.json')).toBe('mao')
    expect(
      modelIdFromStageUrl(`nacime-live2d://model/${encodeURIComponent('我的模型')}/a.model3.json`)
    ).toBe('我的模型')
    expect(modelIdFromStageUrl('nacime-live2d://runtime/cubism-core')).toBeNull()
    expect(modelIdFromStageUrl('https://example.com/a.json')).toBeNull()
  })
})
