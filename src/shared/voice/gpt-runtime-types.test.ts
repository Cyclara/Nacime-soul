// src/shared/voice/gpt-runtime-types.test.ts
// P3V-16：GPT runtime DTO 与守卫合同。
// 纪律焦点：变体闭集、投影不含路径、请求不接受多余字段。

import { describe, expect, it } from 'vitest'
import {
  gptRuntimeAssetId,
  isGptRuntimeInstalledInfo,
  isGptRuntimeOverview,
  isGptRuntimeVariantId,
  isGptRuntimeVariantOption,
  isGptRuntimeVariantRequest,
  type GptRuntimeOverview
} from './gpt-runtime-types'

function overview(patch: Partial<GptRuntimeOverview> = {}): GptRuntimeOverview {
  return {
    source: { mode: 'auto', active: true, voiceConfigured: true, restartRequired: false },
    voices: [
      {
        id: 'gpt-sovits:abc123',
        displayName: '测试音色（v2Pro）',
        version: 'v2Pro',
        promptLang: 'zh',
        defaultTextLang: 'zh',
        state: 'ready',
        source: 'discovered',
        current: true
      }
    ],
    installed: null,
    externalDetected: false,
    variants: [
      {
        variant: 'standard',
        displayName: 'GPT-SoVITS v2Pro 标准版',
        downloadBytes: 8_185_086_602,
        recommended: false
      },
      {
        variant: 'rtx50',
        displayName: 'GPT-SoVITS v2Pro RTX 50 系版',
        downloadBytes: 8_835_144_925,
        recommended: true
      }
    ],
    download: null,
    minFreeBytes: 21_474_836_480,
    freeBytes: 123_456_789,
    rootState: 'ok',
    ...patch
  }
}

describe('P3V-16 GPT runtime 变体闭集', () => {
  it('只认 standard / rtx50', () => {
    expect(isGptRuntimeVariantId('standard')).toBe(true)
    expect(isGptRuntimeVariantId('rtx50')).toBe(true)
    expect(isGptRuntimeVariantId('rtx40')).toBe(false)
    expect(isGptRuntimeVariantId('')).toBe(false)
    expect(isGptRuntimeVariantId(null)).toBe(false)
  })

  it('请求只接受单键 variant（多余字段拒绝）', () => {
    expect(isGptRuntimeVariantRequest({ variant: 'standard' })).toBe(true)
    expect(isGptRuntimeVariantRequest({ variant: 'standard', rootDir: 'D:/x' })).toBe(false)
    expect(isGptRuntimeVariantRequest({})).toBe(false)
    expect(isGptRuntimeVariantRequest(null)).toBe(false)
    expect(isGptRuntimeVariantRequest('standard')).toBe(false)
  })

  it('assetId 与 main 侧下载器约定一致', () => {
    expect(gptRuntimeAssetId('standard')).toBe('gpt-runtime-standard')
    expect(gptRuntimeAssetId('rtx50')).toBe('gpt-runtime-rtx50')
  })
})

describe('P3V-16 变体选项与已安装投影', () => {
  it('合法选项通过；负字节/空名/未知变体拒绝', () => {
    expect(
      isGptRuntimeVariantOption({
        variant: 'standard',
        displayName: '标准版',
        downloadBytes: 1,
        recommended: false
      })
    ).toBe(true)
    expect(
      isGptRuntimeVariantOption({
        variant: 'standard',
        displayName: '',
        downloadBytes: 1,
        recommended: false
      })
    ).toBe(false)
    expect(
      isGptRuntimeVariantOption({
        variant: 'standard',
        displayName: '标准版',
        downloadBytes: -1,
        recommended: false
      })
    ).toBe(false)
    expect(
      isGptRuntimeVariantOption({
        variant: 'cuda13',
        displayName: '标准版',
        downloadBytes: 1,
        recommended: false
      })
    ).toBe(false)
  })

  it('已安装投影拒绝多余字段——rootDir 是 main 内视图，不能漏进 DTO', () => {
    expect(
      isGptRuntimeInstalledInfo({ variant: 'standard', displayName: '标准版', installedAt: 1 })
    ).toBe(true)
    expect(
      isGptRuntimeInstalledInfo({
        variant: 'standard',
        displayName: '标准版',
        installedAt: 1,
        rootDir: 'D:/assets/gpt-runtime/gpt-sovits'
      })
    ).toBe(false)
  })
})

describe('P3V-16 overview 守卫', () => {
  it('完整投影通过', () => {
    expect(isGptRuntimeOverview(overview())).toBe(true)
    expect(
      isGptRuntimeOverview(
        overview({
          installed: {
            variant: 'rtx50',
            displayName: 'RTX 50 系版',
            installedAt: 1_756_000_000_000
          },
          externalDetected: true,
          download: {
            assetId: 'gpt-runtime-rtx50',
            state: 'downloading',
            receivedBytes: 10,
            totalBytes: 8_835_144_925,
            currentFile: 'GPT-SoVITS-v2pro-20250604-nvidia50.7z',
            phase: 'receiving',
            resumable: true
          },
          rootState: 'missing',
          freeBytes: 0
        })
      )
    ).toBe(true)
  })

  it('空变体表 / 未知根状态 / 多余字段 / 带路径的下载项拒绝', () => {
    expect(isGptRuntimeOverview(overview({ variants: [] }))).toBe(false)
    expect(isGptRuntimeOverview({ ...overview(), rootState: 'gone' })).toBe(false)
    expect(isGptRuntimeOverview({ ...overview(), installRoot: 'D:/x' })).toBe(false)
    expect(
      isGptRuntimeOverview({
        ...overview(),
        download: {
          assetId: 'gpt-runtime-standard',
          state: 'downloading',
          receivedBytes: 0,
          totalBytes: 1,
          // currentFile 必须是 basename：带分隔符的路径要被拒
          currentFile: 'D:/assets/GPT-SoVITS-v2pro-20250604.7z'
        }
      })
    ).toBe(false)
  })
})
