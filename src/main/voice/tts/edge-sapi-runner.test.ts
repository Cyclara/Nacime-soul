// src/main/voice/tts/edge-sapi-runner.test.ts
// P3B-03：SAPI PowerShell 命令构造合同。只测纯函数 buildSapiEncodedCommand；
// 真实 spawn 不进单测（S-004：测试不真发声；链路验证留给 e2e/真机）。
//
// 核心安全性质：用户文本永不进命令行（只经临时文件），脚本经 -EncodedCommand
// base64(utf16le) 传递，单引号字面量只承载 uuid 路径与白名单 voice 名。

import { describe, expect, it } from 'vitest'
import { buildSapiEncodedCommand } from './edge-sapi-runner'

function decodeScript(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

describe('P3B-03 buildSapiEncodedCommand', () => {
  const base = {
    wavPath: 'C:\\Users\\dev\\AppData\\Local\\Temp\\nacime-tts-abc\\x.wav',
    textPath: 'C:\\Users\\dev\\AppData\\Local\\Temp\\nacime-tts-abc\\x.txt',
    rate: 5
  }

  it('编码为 base64(utf16le)，脚本含 SAPI 装配/Rate/WAV 输出/UTF8 读文本/退出码', () => {
    const script = decodeScript(
      buildSapiEncodedCommand({ ...base, voice: 'Microsoft Huihui Desktop' })
    )
    expect(script).toContain('Add-Type -AssemblyName System.Speech')
    expect(script).toContain("try { $s.SelectVoice('Microsoft Huihui Desktop') } catch { }")
    expect(script).toContain(`$s.Rate = 5`)
    expect(script).toContain(`$s.SetOutputToWaveFile('${base.wavPath}')`)
    expect(script).toContain(
      `[System.IO.File]::ReadAllText('${base.textPath}', [System.Text.Encoding]::UTF8)`
    )
    expect(script).toContain('$s.Speak($t)')
    expect(script).toContain('exit 0')
  })

  it('voice 为 null 时完全不出现 SelectVoice（回退系统默认）', () => {
    const script = decodeScript(buildSapiEncodedCommand({ ...base, voice: null }))
    expect(script).not.toContain('SelectVoice')
    expect(script).toContain('$s.Rate =')
  })

  it('负 rate 原样嵌入（SAPI Rate 合法域 -10..10 由调用方保证）', () => {
    const script = decodeScript(buildSapiEncodedCommand({ ...base, voice: null, rate: -10 }))
    expect(script).toContain('$s.Rate = -10')
  })

  it('编码产物是合法 base64 且不含裸换行（命令行单参数约束）', () => {
    const encoded = buildSapiEncodedCommand({ ...base, voice: null })
    expect(encoded).not.toMatch(/\s/)
    expect(() => Buffer.from(encoded, 'base64')).not.toThrow()
  })
})
