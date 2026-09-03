// src/shared/voice/asset-root-types.test.ts
// P3V-03：资源根目录/下载状态 DTO 校验器测试（event 通道纵深防御用）。

import { describe, expect, it } from 'vitest'
import {
  isAssetDownloadStatus,
  isAssetRootChangeResult,
  isAssetRootStatus
} from './asset-root-types'
import { isAsrSetFallbackEngineRequest } from './asr-settings-types'

describe('P3V-03 AssetRootStatus / AssetRootChangeResult 校验', () => {
  const status = {
    isDefault: true,
    freeBytes: 123_456_789,
    totalRequiredBytes: 520_509_193,
    state: 'ok'
  }

  it('合法状态通过；三态都接受', () => {
    expect(isAssetRootStatus(status)).toBe(true)
    expect(isAssetRootStatus({ ...status, state: 'missing', freeBytes: 0 })).toBe(true)
    expect(isAssetRootStatus({ ...status, state: 'unwritable', freeBytes: 0 })).toBe(true)
  })

  it('未知状态/负数字节/非布尔/多余键/路径字段拒绝', () => {
    expect(isAssetRootStatus({ ...status, state: 'nope' })).toBe(false)
    expect(isAssetRootStatus({ ...status, freeBytes: -1 })).toBe(false)
    expect(isAssetRootStatus({ ...status, freeBytes: 1.5 })).toBe(false)
    expect(isAssetRootStatus({ ...status, isDefault: 'yes' })).toBe(false)
    expect(isAssetRootStatus({ ...status, extra: 1 })).toBe(false)
    // 路径字段是红线：出现即拒绝（DTO 永远不携带绝对路径）
    expect(isAssetRootStatus({ ...status, path: 'D:/assets' })).toBe(false)
    expect(isAssetRootStatus(null)).toBe(false)
  })

  it('变更结果：合法通过；缺字段/类型错拒绝', () => {
    const change = { status, changed: true, restartRequired: true }
    expect(isAssetRootChangeResult(change)).toBe(true)
    expect(isAssetRootChangeResult({ ...change, changed: false })).toBe(true)
    expect(isAssetRootChangeResult({ ...change, restartRequired: 'yes' })).toBe(false)
    expect(isAssetRootChangeResult({ status, changed: true })).toBe(false)
    expect(isAssetRootChangeResult({ ...change, status: { ...status, state: 'x' } })).toBe(false)
  })
})

describe('P3V-03 AssetDownloadStatus 校验', () => {
  const download = {
    assetId: 'gpt-runtime-standard',
    state: 'downloading',
    receivedBytes: 1_000,
    totalBytes: 8_185_086_602,
    currentFile: 'encoder.int8.onnx',
    phase: 'receiving',
    speedBytesPerSec: 12_345_678,
    resumable: true
  }

  it('合法通过（含 error/cancelled 终态与省略可选字段）', () => {
    expect(isAssetDownloadStatus(download)).toBe(true)
    expect(
      isAssetDownloadStatus({
        assetId: 'voice-pack-1',
        state: 'idle',
        receivedBytes: 0,
        totalBytes: 100
      })
    ).toBe(true)
    expect(
      isAssetDownloadStatus({
        assetId: 'gpt-runtime-standard',
        state: 'error',
        receivedBytes: 5,
        totalBytes: 10,
        errorCode: 'hash-mismatch'
      })
    ).toBe(true)
    expect(
      isAssetDownloadStatus({
        assetId: 'gpt-runtime-standard',
        state: 'cancelled',
        receivedBytes: 5,
        totalBytes: 10,
        errorCode: 'cancelled'
      })
    ).toBe(true)
  })

  it('未知状态/错误码、越界 id、负数、多余键拒绝', () => {
    expect(isAssetDownloadStatus({ ...download, state: 'paused-x' })).toBe(false)
    expect(isAssetDownloadStatus({ ...download, state: 'error', errorCode: 'nope' })).toBe(false)
    expect(isAssetDownloadStatus({ ...download, assetId: '' })).toBe(false)
    expect(isAssetDownloadStatus({ ...download, assetId: 'x'.repeat(65) })).toBe(false)
    expect(isAssetDownloadStatus({ ...download, receivedBytes: -1 })).toBe(false)
    expect(isAssetDownloadStatus({ ...download, receivedBytes: download.totalBytes + 1 })).toBe(
      false
    )
    expect(isAssetDownloadStatus({ ...download, speedBytesPerSec: -5 })).toBe(false)
    expect(isAssetDownloadStatus({ ...download, phase: 'unzipping-secret-path' })).toBe(false)
    expect(isAssetDownloadStatus({ ...download, resumable: 'yes' })).toBe(false)
    // currentFile 只能是上游 basename，绝不能夹带本机路径。
    expect(isAssetDownloadStatus({ ...download, currentFile: 'D:/assets/model.onnx' })).toBe(false)
    expect(isAssetDownloadStatus({ ...download, currentFile: '..\\model.onnx' })).toBe(false)
    expect(isAssetDownloadStatus({ ...download, extra: 1 })).toBe(false)
    expect(isAssetDownloadStatus(null)).toBe(false)
  })
})

describe('P3V-09 AsrSetFallbackEngineRequest 校验', () => {
  it('引擎 id 与 null（清除）通过；多余字段/未知 id 拒绝', () => {
    expect(isAsrSetFallbackEngineRequest({ engineId: 'sherpa-sensevoice' })).toBe(true)
    expect(isAsrSetFallbackEngineRequest({ engineId: null })).toBe(true)
    expect(isAsrSetFallbackEngineRequest({ engineId: 'groq-whisper' })).toBe(false)
    expect(isAsrSetFallbackEngineRequest({ engineId: null, extra: 1 })).toBe(false)
    expect(isAsrSetFallbackEngineRequest({})).toBe(false)
    expect(isAsrSetFallbackEngineRequest('sherpa-sensevoice')).toBe(false)
  })
})
