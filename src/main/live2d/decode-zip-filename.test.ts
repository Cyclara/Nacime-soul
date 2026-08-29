// src/main/live2d/decode-zip-filename.test.ts
// 对照 AIRI 更新（moeru-ai/airi#2016）发现的同类缺陷：CJK 作者导出的模型包常不设 UTF-8
// 标志位、条目名按 GBK 存储，JSZip 默认按 UTF-8 解会产乱码。

import { describe, expect, it } from 'vitest'
import { decodeZipFileName } from './decode-zip-filename'

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text)

describe('ZIP 条目名历史编码解码', () => {
  it('纯 ASCII 原样通过（两种编码结果相同，走快路）', () => {
    expect(decodeZipFileName(ascii('Mao.model3.json'))).toBe('Mao.model3.json')
    expect(decodeZipFileName(ascii('textures/texture_00.png'))).toBe('textures/texture_00.png')
    expect(decodeZipFileName(new Uint8Array())).toBe('')
  })

  it('GBK 名即使同时是合法 UTF-8 也必须按 GBK 解——这正是不能"UTF-8 优先"的原因', () => {
    // GBK 的「一」是字节 D2 BB，而这两个字节恰好也是「һ」的合法 UTF-8 编码。
    // 若按"能解通就用 UTF-8"，会静默解成错字而不是报错。
    const bytes = new Uint8Array([0xd2, 0xbb, ...ascii('.exp3.json')])
    expect(decodeZipFileName(bytes)).toBe('一.exp3.json')
    expect(new TextDecoder('utf-8').decode(bytes)).toBe('һ.exp3.json') // 反例：证明陷阱真实存在
  })

  it('多字 GBK 名与带目录的 GBK 路径都能正确还原', () => {
    expect(
      decodeZipFileName(new Uint8Array([0xb8, 0xdf, 0xb9, 0xe2, ...ascii('.exp3.json')]))
    ).toBe('高光.exp3.json')
    // 「模型/贴图.png」：GBK 下目录分隔符仍是 ASCII 的 '/'
    const path = new Uint8Array([
      0xc4,
      0xa3,
      0xd0,
      0xcd,
      0x2f,
      0xcc,
      0xf9,
      0xcd,
      0xbc,
      ...ascii('.png')
    ])
    expect(decodeZipFileName(path)).toBe('模型/贴图.png')
  })

  it('string[] 分支原样拼回（只为满足 JSZip 选项签名）', () => {
    expect(decodeZipFileName(['a', 'b', 'c'])).toBe('abc')
    expect(decodeZipFileName([])).toBe('')
  })
})
