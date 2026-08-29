// src/renderer/src/live2d/stage-bootstrap.test.ts
// P3A-06：stage entry 只使用最小 stage API，不 bootstrap chat/Pinia/router。

import { describe, expect, it, vi } from 'vitest'
import { startLive2dStage, type StageBootstrapApi } from './stage-bootstrap'

function successApi(): StageBootstrapApi {
  return {
    ready: vi.fn(async () => ({
      ok: true as const,
      data: { stageInstanceId: 'stage-1', status: 'loading-model' as const, initialModelUrl: null, cubismCoreUrl: null, zoom: 1, offsetX: 0, offsetY: 0 }
    })),
    reportState: vi.fn(async () => ({ ok: true as const, data: undefined })),
    onCommand: vi.fn(() => () => {})
  }
}

describe('P3A-06 stage bootstrap', () => {
  it('仅通过 stage preload 完成 ready/report/command 订阅，不触发聊天 bootstrap', async () => {
    const api = successApi()
    const handle = await startLive2dStage(api, { createStageInstanceId: () => 'stage-1' })

    expect(handle.stageInstanceId).toBe('stage-1')
    expect(api.ready).toHaveBeenCalledWith({ stageInstanceId: 'stage-1' })
    expect(api.reportState).toHaveBeenCalledWith({ stageInstanceId: 'stage-1', status: 'loading-model' })
    expect(api.onCommand).toHaveBeenCalledTimes(1)
  })

  it('main 拒绝 bootstrap 时只报告安全错误状态，不向 renderer 抛出', async () => {
    const api: StageBootstrapApi = {
      ready: async () => ({
        ok: false,
        error: { code: 'IPC_UNAUTHORIZED', message: '拒绝', retryable: false }
      }),
      reportState: vi.fn(async () => ({ ok: true as const, data: undefined })),
      onCommand: vi.fn(() => () => {})
    }

    await expect(startLive2dStage(api, { createStageInstanceId: () => 'stage-denied' })).resolves.toMatchObject({
      stageInstanceId: 'stage-denied'
    })
    expect(api.reportState).toHaveBeenCalledWith({
      stageInstanceId: 'stage-denied',
      status: 'error',
      errorCode: 'IPC_UNAUTHORIZED'
    })
    expect(api.onCommand).not.toHaveBeenCalled()
  })
})
