// src/shared/voice/asr-catalog.test.ts
// P3V-01：shared 展示目录——体积文案、预设、总量计算。
//
// 体积文案是用户明确要求的功能（「在语音模型后面加上下载需要多少 MB」），
// 所以这里逐个断言交接文档钉死的显示值，防止有人改成 MiB 让 357 MB 显示成 340 MB。

import { describe, expect, it } from 'vitest'
import {
  ASR_MODEL_CATALOG,
  ASR_PRESETS,
  ASR_VAD_CATALOG_ENTRY,
  asrBadgeLabel,
  asrModeLabel,
  asrResourceLevelLabel,
  findAsrModelCatalogEntry,
  findAsrPreset,
  formatAsrDownloadSize,
  formatAsrDownloadTotal,
  totalAsrDownloadBytes
} from './asr-catalog'

describe('P3V-01 展示目录：下载体积文案', () => {
  it('交接文档钉死的显示值逐一复核（十进制 MB）', () => {
    expect(formatAsrDownloadSize(643_854)).toBe('0.64 MB')
    expect(formatAsrDownloadSize(356_862_456)).toBe('357 MB')
    expect(formatAsrDownloadSize(237_202_501)).toBe('237 MB')
    expect(formatAsrDownloadSize(55_616_588)).toBe('56 MB')
    expect(formatAsrDownloadSize(661_190_513)).toBe('661 MB')
    expect(formatAsrDownloadSize(163_002_883)).toBe('163 MB')
    expect(formatAsrDownloadSize(234_051_698)).toBe('234 MB')
  })

  it('GB 级用一位小数（GPT-SoVITS 整合包 8.2 GB）', () => {
    expect(formatAsrDownloadSize(8_185_086_602)).toBe('8.2 GB')
    expect(formatAsrDownloadSize(8_835_144_925)).toBe('8.8 GB')
  })

  it('不合法输入给占位符而不是 NaN MB', () => {
    expect(formatAsrDownloadSize(Number.NaN)).toBe('—')
    expect(formatAsrDownloadSize(-1)).toBe('—')
  })

  it('每个模型都能算出非空体积文案（UI 不会出现空白尺寸）', () => {
    for (const entry of ASR_MODEL_CATALOG) {
      expect(entry.downloadBytes).toBeGreaterThan(0)
      expect(formatAsrDownloadSize(entry.downloadBytes)).not.toBe('—')
    }
  })
})

describe('P3V-01 展示目录：条目完整性', () => {
  it('6 个模型，id 互不相同', () => {
    expect(ASR_MODEL_CATALOG).toHaveLength(6)
    const ids = ASR_MODEL_CATALOG.map((entry) => entry.engineId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('每张卡片都写清了场景与限制（不许只报喜不报忧）', () => {
    for (const entry of ASR_MODEL_CATALOG) {
      expect(entry.summary.length, entry.engineId).toBeGreaterThan(0)
      expect(entry.scenario.length, entry.engineId).toBeGreaterThan(0)
      expect(entry.limitation.length, entry.engineId).toBeGreaterThan(0)
      expect(entry.languages.length, entry.engineId).toBeGreaterThan(0)
    }
  })

  it('恰有一个「推荐」徽章（两个推荐等于没推荐）', () => {
    const recommended = ASR_MODEL_CATALOG.filter((entry) => entry.badges.includes('recommended'))
    expect(recommended).toHaveLength(1)
    expect(recommended[0]?.engineId).toBe('zipformer-bilingual-zh-en')
  })

  it('三个流式模型标 streaming，三个离线标 offline', () => {
    const streaming = ASR_MODEL_CATALOG.filter((entry) => entry.mode === 'streaming')
    expect(streaming.map((entry) => entry.engineId).sort()).toEqual([
      'paraformer-bilingual-zh-en',
      'zipformer-bilingual-zh-en',
      'zipformer-streaming-zh-14m'
    ])
  })

  it('findAsrModelCatalogEntry 命中与未命中', () => {
    expect(findAsrModelCatalogEntry('parakeet-tdt-v2')?.label).toBe('Parakeet TDT v2')
    // @ts-expect-error 故意传闭集外的值：运行时必须返回 undefined 而不是抛错
    expect(findAsrModelCatalogEntry('no-such-engine')).toBeUndefined()
  })

  it('展示辅助函数覆盖全部枚举值', () => {
    expect(asrModeLabel('streaming')).toContain('流式')
    expect(asrModeLabel('offline')).toContain('离线')
    expect(asrResourceLevelLabel('light')).toBe('占用低')
    expect(asrResourceLevelLabel('medium')).toBe('占用中等')
    expect(asrResourceLevelLabel('heavy')).toBe('占用较高')
    for (const badge of ['recommended', 'light', 'dialect', 'english', 'fallback'] as const) {
      expect(asrBadgeLabel(badge).length).toBeGreaterThan(0)
    }
  })
})

describe('P3V-01 预设与总下载量', () => {
  it('标准推荐：Zipformer Bilingual 主 + SenseVoice 备', () => {
    const preset = findAsrPreset('standard')
    expect(preset?.primaryEngineId).toBe('zipformer-bilingual-zh-en')
    expect(preset?.fallbackEngineId).toBe('sherpa-sensevoice')
  })

  it('轻量模式：只装 14M 中文模型，无备用', () => {
    const preset = findAsrPreset('light')
    expect(preset?.engineIds).toEqual(['zipformer-streaming-zh-14m'])
    expect(preset?.fallbackEngineId).toBeNull()
  })

  it('自定义预设不预置模型，主备留给用户选', () => {
    const preset = findAsrPreset('custom')
    expect(preset?.engineIds).toEqual([])
    expect(preset?.primaryEngineId).toBeNull()
    expect(preset?.fallbackEngineId).toBeNull()
  })

  it('预设声明的主备模型必须在自己的下载清单里（否则选了却没下）', () => {
    for (const preset of ASR_PRESETS) {
      if (preset.primaryEngineId !== null) {
        expect(preset.engineIds, preset.id).toContain(preset.primaryEngineId)
      }
      if (preset.fallbackEngineId !== null) {
        expect(preset.engineIds, preset.id).toContain(preset.fallbackEngineId)
      }
    }
  })

  it('标准推荐总下载 ≈ 520.5 MB（含 VAD）', () => {
    const bytes = totalAsrDownloadBytes(findAsrPreset('standard')?.engineIds ?? [])
    // 356,862,456 + 163,002,883 + 643,854
    expect(bytes).toBe(520_509_193)
    expect(formatAsrDownloadSize(bytes)).toBe('521 MB')
    expect(formatAsrDownloadTotal(bytes)).toBe('520.5 MB')
  })

  it('轻量模式总下载 ≈ 56.3 MB（含 VAD）', () => {
    const bytes = totalAsrDownloadBytes(findAsrPreset('light')?.engineIds ?? [])
    // 55,616,588 + 643,854
    expect(bytes).toBe(56_260_442)
    expect(formatAsrDownloadTotal(bytes)).toBe('56.3 MB')
  })

  it('VAD 恒被计入；显式排除时才不算', () => {
    expect(totalAsrDownloadBytes([])).toBe(ASR_VAD_CATALOG_ENTRY.downloadBytes)
    expect(totalAsrDownloadBytes([], { includeVad: false })).toBe(0)
  })

  it('重复勾选同一模型不重复计费', () => {
    const once = totalAsrDownloadBytes(['parakeet-tdt-v2'])
    expect(totalAsrDownloadBytes(['parakeet-tdt-v2', 'parakeet-tdt-v2'])).toBe(once)
  })
})
