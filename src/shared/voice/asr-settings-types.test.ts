// src/shared/voice/asr-settings-types.test.ts
// P3B-14：ASR 设置 DTO 校验器测试。

import { describe, expect, it } from 'vitest'
import {
  isAsrEngineId,
  isAsrEngineOverview,
  isAsrEngineRequest,
  isAsrOverview,
  isAsrSelectEngineRequest
} from './asr-settings-types'

describe('P3B-14 isAsrEngineId / 请求校验', () => {
  it('闭集通过；云引擎/未知 id 拒绝（无云 ASR 选项）', () => {
    expect(isAsrEngineId('sherpa-sensevoice')).toBe(true)
    expect(isAsrEngineId('funasr-paraformer')).toBe(true)
    // P3V-01 扩容的四个新成员
    expect(isAsrEngineId('zipformer-bilingual-zh-en')).toBe(true)
    expect(isAsrEngineId('paraformer-bilingual-zh-en')).toBe(true)
    expect(isAsrEngineId('zipformer-streaming-zh-14m')).toBe(true)
    expect(isAsrEngineId('parakeet-tdt-v2')).toBe(true)
    expect(isAsrEngineId('groq-whisper')).toBe(false)
    expect(isAsrEngineId('')).toBe(false)
    expect(isAsrEngineId(1)).toBe(false)
  })

  it('引擎请求：合法通过；多余字段/缺字段/错类型拒绝', () => {
    expect(isAsrEngineRequest({ engineId: 'sherpa-sensevoice' })).toBe(true)
    expect(isAsrEngineRequest({ engineId: 'funasr-paraformer' })).toBe(true)
    expect(isAsrEngineRequest({ engineId: 'x', extra: 1 })).toBe(false)
    expect(isAsrEngineRequest({})).toBe(false)
    expect(isAsrEngineRequest('sherpa-sensevoice')).toBe(false)
    expect(isAsrSelectEngineRequest({ engineId: 'funasr-paraformer' })).toBe(true)
  })
})

describe('P3B-14 overview 校验（event 通道纵深防御）', () => {
  const engine = {
    engineId: 'sherpa-sensevoice',
    label: 'SenseVoice',
    localOnly: true,
    modelState: 'ready',
    downloadBytes: 163_002_883,
    selected: true,
    fallback: false
  }
  const overview = {
    selectedEngineId: 'sherpa-sensevoice',
    fallbackEngineId: null,
    engines: [engine, { ...engine, engineId: 'funasr-paraformer', selected: false }],
    vadModel: { state: 'downloading', progressRatio: 0.3 }
  }

  it('合法 overview 通过（可附安全下载细节；assetId 必须与卡片一致）', () => {
    expect(isAsrOverview(overview)).toBe(true)
    expect(isAsrEngineOverview(engine)).toBe(true)
    const withDownload = {
      ...engine,
      modelState: 'downloading',
      download: {
        assetId: 'sherpa-sensevoice',
        state: 'downloading',
        receivedBytes: 1,
        totalBytes: 10,
        currentFile: 'model.tar.bz2',
        phase: 'receiving',
        speedBytesPerSec: 5,
        resumable: false
      }
    }
    expect(isAsrEngineOverview(withDownload)).toBe(true)
    expect(
      isAsrEngineOverview({
        ...withDownload,
        download: { ...withDownload.download, assetId: 'funasr-paraformer' }
      })
    ).toBe(false)
    expect(
      isAsrEngineOverview({
        ...withDownload,
        download: { ...withDownload.download, currentFile: 'D:/secret/model.onnx' }
      })
    ).toBe(false)
  })

  it('云引擎 id / 非 true localOnly / 未知状态 / 越界进度 / 多余键拒绝', () => {
    expect(isAsrEngineOverview({ ...engine, engineId: 'cloud' })).toBe(false)
    expect(isAsrEngineOverview({ ...engine, localOnly: false })).toBe(false)
    expect(isAsrEngineOverview({ ...engine, localOnly: 'yes' })).toBe(false)
    expect(isAsrEngineOverview({ ...engine, modelState: 'broken' })).toBe(false)
    expect(isAsrEngineOverview({ ...engine, progressRatio: 1.5 })).toBe(false)
    expect(isAsrEngineOverview({ ...engine, extra: 1 })).toBe(false)
  })

  it('P3V-09：备用投影——合法备用通过；主备同体/缺 fallback 键拒绝', () => {
    const withFallback = {
      ...overview,
      fallbackEngineId: 'funasr-paraformer',
      engines: [
        engine,
        { ...engine, engineId: 'funasr-paraformer', selected: false, fallback: true }
      ]
    }
    expect(isAsrOverview(withFallback)).toBe(true)
    expect(
      isAsrEngineOverview({
        ...engine,
        engineId: 'funasr-paraformer',
        selected: false,
        fallback: true
      })
    ).toBe(true)
    // 主备同体（纵深防御；manager 侧保证不出现）
    expect(isAsrEngineOverview({ ...engine, fallback: true })).toBe(false)
    expect(isAsrOverview({ ...overview, fallbackEngineId: 'x' })).toBe(false)
    expect(isAsrOverview({ ...overview, fallbackEngineId: undefined })).toBe(false)
  })

  it('overview 结构：缺引擎/缺 vadModel/selectedEngineId 非法拒绝', () => {
    expect(isAsrOverview({ ...overview, engines: [] })).toBe(false)
    expect(isAsrOverview({ ...overview, selectedEngineId: 'x' })).toBe(false)
    expect(isAsrOverview({ ...overview, vadModel: { state: 'nope' } })).toBe(false)
    expect(isAsrOverview({ ...overview, extra: 1 })).toBe(false)
    expect(isAsrOverview(null)).toBe(false)
  })
})
