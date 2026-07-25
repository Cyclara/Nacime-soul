// src/main/security/unicode.test.ts
// P1-09 验收测试：Unicode 安全清理
// 依据：S-001 P1-09 验收标准

import { describe, it, expect } from 'vitest'
import { sanitizeUnicode, sanitizeUnicodeDeep } from './unicode'

describe('P1-09 sanitizeUnicode 基础', () => {
  it('普通中文文本语义不变（NFKC 转全角标点为半角）', () => {
    // NFKC 将全角逗号（U+FF0C）→ 半角逗号（U+002C）、全角感叹号（U+FF01）→ 半角
    const result = sanitizeUnicode('你好，世界！这是一个测试。')
    expect(result).toBe('你好,世界!这是一个测试。')
  })

  it('普通英文文本不变', () => {
    const input = 'Hello, world! This is a test.'
    expect(sanitizeUnicode(input)).toBe(input)
  })

  it('中英混排文本语义不变（NFKC 转全角标点为半角）', () => {
    const result = sanitizeUnicode('Hello 你好！This is 测试 text.')
    expect(result).toBe('Hello 你好!This is 测试 text.')
  })

  it('emoji 保留（含 ZWJ 序列）', () => {
    const family = '👨‍👩‍👧‍👦' // ZWJ 连接的 emoji 序列
    expect(sanitizeUnicode(family)).toBe(family)
    expect(sanitizeUnicode('😀🎉❤️')).toBe('😀🎉❤️')
  })

  it('数字和标点不变', () => {
    const input = '12345 !@#$%^&*()_+-=[]{}|;:\'",.<>?/'
    expect(sanitizeUnicode(input)).toBe(input)
  })

  it('空字符串不变', () => {
    expect(sanitizeUnicode('')).toBe('')
  })

  it('换行和制表符保留', () => {
    const input = 'line1\nline2\tindented'
    expect(sanitizeUnicode(input)).toBe(input)
  })
})

describe('P1-09 零宽字符删除（HackerOne 型）', () => {
  it('零宽空格 U+200B 被删除', () => {
    const input = 'hello​world'
    expect(sanitizeUnicode(input)).toBe('helloworld')
    // 确认原始输入含零宽空格
    expect(input.length).toBe(11)
    expect(sanitizeUnicode(input).length).toBe(10)
  })

  it('多个零宽字符散布在文本中均被删除', () => {
    const input = '​前​后​'
    expect(sanitizeUnicode(input)).toBe('前后')
  })

  it('词连接符 U+2060 被删除', () => {
    const input = 'var⁠name'
    expect(sanitizeUnicode(input)).toBe('varname')
  })

  it('BOM U+FEFF 在文本中间被删除', () => {
    const input = 'hello﻿world'
    expect(sanitizeUnicode(input)).toBe('helloworld')
  })

  it('软连字符 U+00AD 被删除', () => {
    const input = 'hy­phen'
    expect(sanitizeUnicode(input)).toBe('hyphen')
  })

  it('行分隔符 U+2028 和段分隔符 U+2029 被删除', () => {
    const input = 'a b c'
    expect(sanitizeUnicode(input)).toBe('abc')
  })

  it('蒙古语元音分隔符 U+180E 被删除', () => {
    const input = 'a᠎b'
    expect(sanitizeUnicode(input)).toBe('ab')
  })

  it('组合字素连接符 U+034F 被删除', () => {
    const input = 'a͏b'
    expect(sanitizeUnicode(input)).toBe('ab')
  })

  it('阿拉伯字母标记 U+061C 被删除', () => {
    const input = 'a؜b'
    expect(sanitizeUnicode(input)).toBe('ab')
  })

  it('韩文填充 U+115F U+1160 被删除', () => {
    expect(sanitizeUnicode('aᅟb')).toBe('ab')
    expect(sanitizeUnicode('aᅠb')).toBe('ab')
  })

  it('高棉语元音 U+17B4 U+17B5 被删除', () => {
    expect(sanitizeUnicode('a឴b')).toBe('ab')
    expect(sanitizeUnicode('a឵b')).toBe('ab')
  })

  it('对象替换字符 U+FFFC 被删除', () => {
    const input = 'a￼b'
    expect(sanitizeUnicode(input)).toBe('ab')
  })
})

describe('P1-09 双向覆盖字符删除', () => {
  it('LRE U+202A 被删除', () => {
    const input = '‪hello'
    expect(sanitizeUnicode(input)).toBe('hello')
  })

  it('RLE U+202B 被删除', () => {
    const input = '‫hello'
    expect(sanitizeUnicode(input)).toBe('hello')
  })

  it('PDF U+202C 被删除', () => {
    const input = 'hello‬'
    expect(sanitizeUnicode(input)).toBe('hello')
  })

  it('LRO U+202D 被删除', () => {
    const input = '‭hello'
    expect(sanitizeUnicode(input)).toBe('hello')
  })

  it('RLO U+202E 被删除（经典 Trojan Source 攻击）', () => {
    // RLO 可让 "exe.c" 显示为 "c.exe" 的镜像
    const input = '‮exe.c'
    expect(sanitizeUnicode(input)).toBe('exe.c')
  })

  it('LRI U+2066 被删除', () => {
    const input = '⁦hello'
    expect(sanitizeUnicode(input)).toBe('hello')
  })

  it('RLI U+2067 被删除', () => {
    const input = '⁧hello'
    expect(sanitizeUnicode(input)).toBe('hello')
  })

  it('FSI U+2068 被删除', () => {
    const input = '⁨hello'
    expect(sanitizeUnicode(input)).toBe('hello')
  })

  it('PDI U+2069 被删除', () => {
    const input = 'hello⁩'
    expect(sanitizeUnicode(input)).toBe('hello')
  })

  it('Trojan Source 完整攻击字符串被清洗', () => {
    // CVE-2021-42574: 双向覆盖字符可让代码审查时看到错误的代码语义
    const input = 'admin‮⁦//⁩⁦login⁩'
    const result = sanitizeUnicode(input)
    expect(result).not.toContain('‮')
    expect(result).not.toContain('⁦')
    expect(result).not.toContain('⁩')
    expect(result).toBe('admin//login')
  })
})

describe('P1-09 行间注释和标签字符删除', () => {
  it('行间注释锚 U+FFF9 被删除', () => {
    expect(sanitizeUnicode('a￹b')).toBe('ab')
  })

  it('行间注释分隔符 U+FFFA 被删除', () => {
    expect(sanitizeUnicode('a￺b')).toBe('ab')
  })

  it('行间注释终止符 U+FFFB 被删除', () => {
    expect(sanitizeUnicode('a￻b')).toBe('ab')
  })

  it('标签字符 U+E0001 被删除', () => {
    const input = 'a\u{E0001}b'
    expect(sanitizeUnicode(input)).toBe('ab')
  })

  it('标签空格 U+E0020 被删除', () => {
    const input = 'a\u{E0020}b'
    expect(sanitizeUnicode(input)).toBe('ab')
  })

  it('标签取消 U+E007F 被删除', () => {
    const input = 'a\u{E007F}b'
    expect(sanitizeUnicode(input)).toBe('ab')
  })
})

describe('P1-09 不可见运算符删除', () => {
  it('U+2061 被删除', () => {
    expect(sanitizeUnicode('a⁡b')).toBe('ab')
  })

  it('U+2062 被删除', () => {
    expect(sanitizeUnicode('a⁢b')).toBe('ab')
  })

  it('U+2063 被删除', () => {
    expect(sanitizeUnicode('a⁣b')).toBe('ab')
  })

  it('U+2064 被删除', () => {
    expect(sanitizeUnicode('a⁤b')).toBe('ab')
  })
})

describe('P1-09 NFKC 归一化', () => {
  it('全角英文字母转半角', () => {
    // U+FF21 = Ａ (fullwidth A)
    expect(sanitizeUnicode('ＡＢＣ')).toBe('ABC')
  })

  it('全角数字转半角', () => {
    expect(sanitizeUnicode('０１２')).toBe('012')
  })

  it('合字分解', () => {
    // U+FB00 = ﬀ (ff ligature) → ff
    const result = sanitizeUnicode('ﬀ')
    expect(result).toBe('ff')
  })

  it('上标数字转普通', () => {
    // U+00B2 = ² → 2
    expect(sanitizeUnicode('²')).toBe('2')
  })

  it('圈数字转普通', () => {
    // U+2460 = ① → 1
    expect(sanitizeUnicode('①')).toBe('1')
  })

  it('中文全角标点部分被 NFKC 转半角', () => {
    // 「（U+300C）和」（U+300D）不在 NFKC 转换范围，保留
    // ：（U+FF1A）→ :（半角冒号）、。（U+3002）保留
    const result = sanitizeUnicode('「你好」：测试。')
    expect(result).toContain('「')
    expect(result).toContain('」')
    expect(result).toBe('「你好」:测试。')
  })
})

describe('P1-09 合法字符保留', () => {
  it('ZWJ U+200D 保留（emoji 需要）', () => {
    const input = '‍'
    expect(sanitizeUnicode(input)).toBe(input)
  })

  it('ZWNJ U+200C 保留（波斯语需要）', () => {
    const input = '‌'
    expect(sanitizeUnicode(input)).toBe(input)
  })

  it('组合变音符号保留', () => {
    // é = e + combining acute accent (U+0301)
    const input = 'é'
    expect(sanitizeUnicode(input)).toBe('é') // NFKC 会合并为预组合字符
  })

  it('变体选择器保留', () => {
    // VS16 (U+FE0F) emoji 变体选择器
    const input = '️'
    expect(sanitizeUnicode(input)).toBe(input)
  })

  it('CJK 汉字全部保留', () => {
    const input = '中文测试繁體漢字日本語한국어'
    expect(sanitizeUnicode(input)).toBe(input)
  })

  it('日文假名保留', () => {
    const input = 'ひらがなカタカナ'
    expect(sanitizeUnicode(input)).toBe(input)
  })
})

describe('P1-09 sanitizeUnicodeDeep 递归清理', () => {
  it('递归清理对象中的字符串', () => {
    const input = {
      name: 'hello​world',
      nested: {
        value: '‮attack'
      },
      count: 42
    }
    const result = sanitizeUnicodeDeep(input)
    expect(result.name).toBe('helloworld')
    expect(result.nested.value).toBe('attack')
    expect(result.count).toBe(42)
  })

  it('递归清理数组', () => {
    const input = ['​zero', 'normal‮attack']
    const result = sanitizeUnicodeDeep(input)
    expect(result).toEqual(['zero', 'normalattack'])
  })

  it('混合嵌套类型', () => {
    const input = {
      messages: [
        { role: 'user', content: '‮hello​world' },
        { role: 'assistant', content: 'normal reply' }
      ],
      metadata: null
    }
    const result = sanitizeUnicodeDeep(input)
    expect(result.messages[0].content).toBe('helloworld')
    expect(result.messages[1].content).toBe('normal reply')
    expect(result.metadata).toBeNull()
  })

  it('原始对象不被修改', () => {
    const input = { text: '​hello' }
    const result = sanitizeUnicodeDeep(input)
    expect(result.text).toBe('hello')
    expect(input.text).toBe('​hello') // 原始对象不变
  })

  it('非字符串值原样返回', () => {
    expect(sanitizeUnicodeDeep(42)).toBe(42)
    expect(sanitizeUnicodeDeep(true)).toBe(true)
    expect(sanitizeUnicodeDeep(null)).toBeNull()
    expect(sanitizeUnicodeDeep(undefined)).toBeUndefined()
    expect(sanitizeUnicodeDeep(BigInt(42))).toBe(BigInt(42))
  })
})
