// src/main/voice/tts/segmenter.test.ts
// P3B-07 / F5-007-1：分句提交策略合同（ETTS-S01~S12 + §3.3 示例表逐行）。
// 跨 delta 累计正确性由调用方（controller）保证 pending 是累计文本；
// 这里以「单次传入累计后的 pending」直接驱动状态机。

import { describe, expect, it } from 'vitest'
import { scanSegments, type SegmenterConfig } from './segmenter'
import { graphemeCount, isGraphemeSegmenterAvailable, speechUnits } from './segmenter-unicode'

const CONFIG: SegmenterConfig = {
  firstMinUnits: 12,
  nextMinUnits: 8,
  targetMaxGraphemes: 120,
  hardMaxGraphemes: 200
}

/** 边界位置测试用：门槛设 0 隔离提交策略，只验证切点正确（§3.3 示例表语义）。 */
const LOOSE: SegmenterConfig = {
  firstMinUnits: 0,
  nextMinUnits: 0,
  targetMaxGraphemes: 120,
  hardMaxGraphemes: 200
}

function firstSegment(
  pending: string,
  opts?: { isFirst?: boolean; hold?: boolean; config?: SegmenterConfig }
): string | null {
  const result = scanSegments({
    pending,
    config: opts?.config ?? CONFIG,
    isFirstSegment: opts?.isFirst ?? true,
    holdExpired: opts?.hold ?? false
  })
  return result.segments.length > 0 ? result.segments[0]!.text : null
}

describe('P3B-07 segmenter-unicode：权重与 grapheme 完整性', () => {
  it('speechUnits：CJK 记 1、拉丁/数字记 0.35、标点空白记 0', () => {
    expect(speechUnits('今天辛苦啦，我们慢慢来。')).toBe(10) // 10 个汉字
    expect(speechUnits('hello world!')).toBeCloseTo(10 * 0.35, 5)
    expect(speechUnits('123')).toBeCloseTo(3 * 0.35, 5)
    expect(speechUnits('，。！？ \n``')).toBe(0)
  })

  it('graphemeCount：ZWJ emoji / 旗帜 / 肤色修饰 / 组合附加符不拆开', () => {
    expect(isGraphemeSegmenterAvailable()).toBe(true)
    // 家庭 emoji（多人 + ZWJ 序列）是 1 个 grapheme，UTF-16 是 11 code unit
    expect(graphemeCount('👩‍👩‍👧‍👦')).toBe(1)
    // 旗帜（两个 regional indicator）
    expect(graphemeCount('🇨🇳')).toBe(1)
    // 肤色修饰符
    expect(graphemeCount('👍🏽')).toBe(1)
    // 组合附加符
    expect(graphemeCount('é')).toBe(1)
    expect(graphemeCount('中文abc')).toBe(5)
  })
})

describe('P3B-07 segmenter：§3.3 示例表逐行', () => {
  it('多 delta 拼成一句：累计文本恰在完整句处提交（S01）', () => {
    // delta1 = '今天辛苦啦，' delta2 = '我们慢慢来。后面还有内容。' -> 累计后
    const pending = '今天辛苦啦，我们慢慢来。后面还有内容。'
    const result = scanSegments({
      pending,
      config: CONFIG,
      isFirstSegment: true,
      holdExpired: false
    })
    // 首段必须等到句号（10 字 < firstMinUnits=12，逗号处不提交）
    expect(result.segments.length).toBeGreaterThanOrEqual(1)
    expect(result.segments[0]!.text).toBe('今天辛苦啦，我们慢慢来。')
  })

  it('首句单位不足：第一个边界太短时继续找下一个边界，不永久放弃（S02）', () => {
    const pending = '好。后面我再慢慢说。'
    // '好。' 只有 1 单位（<12）；必须扫到 '好。后面我再慢慢说。'（8+1=9... 仍不足 12）
    // -> 整体不提交，继续等更多文本
    const result = scanSegments({
      pending,
      config: CONFIG,
      isFirstSegment: true,
      holdExpired: false
    })
    expect(result.segments).toEqual([])
    // 文本足够长之后：'好。后面我再慢慢说一下吧。' = 11 <12 -> 还要更多
    const longer = '好。后面我再慢慢说一下吧，这样可以了吧。'
    const r2 = scanSegments({
      pending: longer,
      config: CONFIG,
      isFirstSegment: true,
      holdExpired: false
    })
    expect(r2.segments[0]!.text).toBe('好。后面我再慢慢说一下吧，这样可以了吧。')
  })

  it('引号内句号不切，闭引号后的句号一起包含（S05）', () => {
    const pending = '她说“别急。我还在这里”。然后笑了。'
    const seg = firstSegment(pending)
    expect(seg).toBe('她说“别急。我还在这里”。')
  })

  it('括号内句号保护：闭括号后才完整提交（S05）', () => {
    const pending = '（我想先说一件事。但还没想好）好吧。'
    const seg = firstSegment(pending)
    expect(seg).toBe('（我想先说一件事。但还没想好）好吧。')
  })

  it('版本号 / 小数 / URL 的点不切（S07，LOOSE 门槛隔离切点）', () => {
    expect(firstSegment('版本是 v1.2.3。下一步…', { config: LOOSE })).toBe('版本是 v1.2.3。')
    expect(firstSegment('价格是 3.14 元，大概就这样了。', { config: LOOSE })).toBe(
      '价格是 3.14 元，大概就这样了。'
    )
    expect(firstSegment('看 example.com/path。好了。', { config: LOOSE })).toBe(
      '看 example.com/path。'
    )
  })

  it('inline code 内的点不切（S06，LOOSE 门槛隔离切点）', () => {
    expect(firstSegment('`foo.bar()` 不是一句话。下一句。', { config: LOOSE })).toBe(
      '`foo.bar()` 不是一句话。'
    )
  })

  it('短省略号不单独早播；…… 完成后可提交（S04）', () => {
    // '嗯……我想想。' -> 嗯(1)+我想想(3)+省略号后整句 5 字 <12，不提交
    expect(firstSegment('嗯……我想想。')).toBeNull()
    // 更长文本中省略号是强边界的一部分
    expect(firstSegment('嗯……我想想好了，我们现在开始吧。')).toBe(
      '嗯……我想想好了，我们现在开始吧。'
    )
  })

  it('单个 … 跨 delta 不切：`等等…` + `…不对` 拼成 …… 后才算完成（S04）', () => {
    // 累计到 '等等…' 时：单省略号不是边界
    expect(firstSegment('等等…我刚才说错了一些东西。')).toBe('等等…我刚才说错了一些东西。')
    // 完整 …… 是省略号边界
    const pending = '等等……我刚才说错了一些东西，真的不对。'
    const seg = firstSegment(pending)
    expect(seg).toBe('等等……我刚才说错了一些东西，真的不对。')
  })

  it('冒号结尾不提交：`第一点：` 明显还要列内容（S10）', () => {
    expect(firstSegment('第一点：')).toBeNull()
    expect(
      scanSegments({ pending: '第一点：', config: CONFIG, isFirstSegment: true, holdExpired: true })
        .segments
    ).toEqual([])
  })

  it('连接词结尾不提交：`我本来想说，但是。` 继续等（S10）', () => {
    expect(firstSegment('我本来想说，但是。')).toBeNull()
    // 补全后整句可提交
    expect(firstSegment('我本来想说，但是话到嘴边又咽了回去。')).toBe(
      '我本来想说，但是话到嘴边又咽了回去。'
    )
  })

  it('英文句末句号成立：小写后跟句点+空格+大写（S03/S07，LOOSE）', () => {
    expect(firstSegment('This is a good example. Next sentence here.', { config: LOOSE })).toBe(
      'This is a good example. ' // 句点后的空格被尾吸收并入本段
    )
    // 缩写后接小写不切
    const abbr = 'Use e.g. this pattern in the sentence ending now. Fine.'
    expect(firstSegment(abbr, { config: LOOSE })).toBe(
      'Use e.g. this pattern in the sentence ending now. ' // 尾吸收吃掉句点后空格
    )
  })

  it('首段门槛：累计 units >= 12 才允许首次提交；每段自身 >= 8（真实门槛）', () => {
    // 累计 16 单位 -> 首段在最早安全强边界提交（§3.3 例 1 的精确语义）
    expect(firstSegment('今天辛苦啦，我们慢慢来。后面还有内容。')).toBe('今天辛苦啦，我们慢慢来。')
    // 累计 8 单位不足 12 -> 不提交（§3.3 例 2）
    expect(firstSegment('好。后面我再慢慢说。')).toBeNull()
    // 英文累计 11.55 < 12 -> 不提交；句子加长后提交
    expect(firstSegment('This is a good example. Next sentence here.')).toBeNull()
    expect(firstSegment('This is a pretty good example sentence. Next one follows here.')).toBe(
      'This is a pretty good example sentence. '
    )
  })

  it('换行是强边界（非代码块内）', () => {
    const pending = '第一段说完了，内容足够长了。\n第二段的内容还在路上。'
    expect(firstSegment(pending)).toBe('第一段说完了，内容足够长了。')
  })

  it('代码围栏整体不切，到围栏闭合后提交（S06）', () => {
    const code = '```ts\nconst a = 1.2.3\nfoo.bar()\n```\n解释一下这段代码的含义。'
    // 围栏闭合后：'```ts...```' 围栏本身不是 segment（无标点边界），
    // 直到围栏后的正文句号
    const result = scanSegments({
      pending: code,
      config: CONFIG,
      isFirstSegment: true,
      holdExpired: false
    })
    // 围栏内容无边界 -> 无提交（或把围栏+正文作为一段等到句号）
    if (result.segments.length > 0) {
      expect(result.segments[0]!.text).toContain('解释一下这段代码的含义。')
    } else {
      // 围栏 + 正文都未达边界：接受（等更多文本）
      expect(result.reason).toBe('need-more-text')
    }
  })
})

describe('P3B-07 segmenter：软边界与 hard-limit', () => {
  it('hold 超时后软边界可提交；未超时不提交（S08）', () => {
    // 构造只有逗号边界的 pending：前半够长、后半悬空，句号尚未出现
    const softOnly = '这里有一段很长的没有句号结尾的话，后面还在继续说着别的东西呢'
    expect(firstSegment(softOnly)).toBeNull() // hold 未到
    const held = scanSegments({
      pending: softOnly,
      config: CONFIG,
      isFirstSegment: true,
      holdExpired: true
    })
    // hold 到 + 首段需 >= 60% target（120*0.6=72 grapheme）；27 个字不足 -> 仍不切
    expect(held.segments).toEqual([])
    expect(held.reason).toBe('need-more-text')
  })

  it('首段软切需 hold + pending >= 60% target；切在 target 内最右侧软边界（S08）', () => {
    // 逗号在 grapheme 102（<= target 120），总量 130+ >= 60% target（72）
    const text = `${'软边界测试文字'.repeat(17)}，后面还有一段没有结束的内容继续说着呢`
    expect(graphemeCount(text)).toBeGreaterThan(72)
    const held = scanSegments({
      pending: text,
      config: CONFIG,
      isFirstSegment: true,
      holdExpired: true
    })
    expect(held.segments.length).toBe(1)
    expect(held.segments[0]!.boundary).toBe('soft-timeout')
    expect(held.segments[0]!.text.endsWith('，')).toBe(true)
    expect(graphemeCount(held.segments[0]!.text)).toBeLessThanOrEqual(120)
  })

  it('hard-limit：无标点长文本在 [target, hard] 找最近安全点，grapheme 完整（S09）', () => {
    const words: string[] = []
    for (let i = 0; i < 50; i++) words.push('无标点长文本')
    const pending = words.join('') // 300 grapheme，无任何标点
    const result = scanSegments({
      pending,
      config: CONFIG,
      isFirstSegment: true,
      holdExpired: false
    })
    expect(result.segments.length).toBe(1)
    const seg = result.segments[0]!
    expect(seg.boundary).toBe('hard-limit')
    // 切点在 [targetMax, hardMax] = [120, 200] grapheme
    const segGraphemes = graphemeCount(seg.text)
    expect(segGraphemes).toBeGreaterThanOrEqual(120)
    expect(segGraphemes).toBeLessThanOrEqual(200)
    // 剩余部分不含半截 grapheme：endOffset 按字素边界
    expect(pending.startsWith(seg.text)).toBe(true)
  })

  it('hard-limit 切点不拆 ZWJ emoji / 旗帜 / 肤色（S09）', () => {
    // 构造 >200 grapheme 的 emoji 流：每个 emoji 是 1 grapheme 但多 code unit
    const emoji = '👩‍👩‍👧‍👦🇨🇳👍🏽'
    const pending = emoji.repeat(80) // 240 grapheme
    const result = scanSegments({
      pending,
      config: CONFIG,
      isFirstSegment: true,
      holdExpired: false
    })
    expect(result.segments.length).toBe(1)
    const seg = result.segments[0]!
    expect(seg.boundary).toBe('hard-limit')
    // 切点必须是 6 grapheme 一组的整数倍（切在组边界附近的空白/组边界）
    const remaining = pending.slice(seg.endOffset)
    expect(
      remaining.startsWith('👩') || remaining.startsWith('🇨🇳') || remaining.startsWith('👍')
    ).toBe(true)
    // 整段 grapheme 数守恒
    expect(graphemeCount(seg.text) + graphemeCount(remaining)).toBe(graphemeCount(pending))
  })

  it('中英文标点混合：boundary 类型与 offset 正确（S03）', () => {
    const pending =
      '第一句话已经说完了。Second sentence ends right here right now. 第三句话也结束了！'
    const result = scanSegments({
      pending,
      config: CONFIG,
      isFirstSegment: true,
      holdExpired: false
    })
    expect(result.segments.map((s) => s.text)).toEqual([
      '第一句话已经说完了。',
      'Second sentence ends right here right now. ',
      '第三句话也结束了！'
    ])
    expect(result.segments.map((s) => s.boundary)).toEqual([
      'strong-punctuation',
      'strong-punctuation',
      'strong-punctuation'
    ])
    // offset 递增且拼接还原原文
    let offset = 0
    for (const seg of result.segments) {
      expect(seg.endOffset).toBeGreaterThan(offset)
      expect(pending.slice(offset, seg.endOffset)).toBe(seg.text)
      offset = seg.endOffset
    }
  })

  it('一次扫描切多个 segment：多句长回复一次提交多段（S12 邻接场景）', () => {
    const pending = '第一句话说完了今天。第二句话也说完了呢。第三句话还在继续说着呢。'
    const result = scanSegments({
      pending,
      config: CONFIG,
      isFirstSegment: true,
      holdExpired: false
    })
    expect(result.segments.length).toBe(3)
    expect(result.segments[0]!.text).toBe('第一句话说完了今天。')
  })

  it('空串 / 纯空白：不提交（S11 前置）', () => {
    expect(
      scanSegments({ pending: '', config: CONFIG, isFirstSegment: true, holdExpired: false })
        .segments
    ).toEqual([])
    expect(
      scanSegments({ pending: '   \n  ', config: CONFIG, isFirstSegment: true, holdExpired: false })
        .segments
    ).toEqual([])
  })
})
