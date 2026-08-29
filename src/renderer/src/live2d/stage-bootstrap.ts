// src/renderer/src/live2d/stage-bootstrap.ts
// P3A-06（功能层）：第二 renderer 的最小启动协议。
//
// 不 import App.vue、router、Pinia 或任何 chat/config/memory store。视觉层由当前编码工程师
// 实现，但本模块始终只证明 stage 使用最小 preload API。

import type { IpcResult, Unsubscribe } from '@shared/ipc/contracts'
import type {
  Live2dStageBootstrap,
  Live2dStageCommand,
  Live2dStageReadyRequest,
  Live2dStageReport
} from '@shared/live2d/stage-types'

export interface StageBootstrapApi {
  ready(input: Live2dStageReadyRequest): Promise<IpcResult<Live2dStageBootstrap>>
  reportState(input: Live2dStageReport): Promise<IpcResult<void>>
  onCommand(callback: (command: Live2dStageCommand) => void): Unsubscribe
}

export interface Live2dStageBootstrapOptions {
  readonly createStageInstanceId?: () => string
  readonly onBootstrap?: (bootstrap: Live2dStageBootstrap) => void | Promise<void>
  readonly onCommand?: (command: Live2dStageCommand) => void | Promise<void>
}

export interface Live2dStageBootstrapHandle {
  readonly stageInstanceId: string
  dispose(): void
}

/**
 * 启动时只报告 `loading-model`，等待 P3A-08 模型 bootstrap 才加载资源。
 * main 返回失败不抛出到 renderer 全局，改报可恢复 error；文字聊天窗口完全不受影响。
 */
export async function startLive2dStage(
  api: StageBootstrapApi,
  options: Live2dStageBootstrapOptions = {}
): Promise<Live2dStageBootstrapHandle> {
  const stageInstanceId = (options.createStageInstanceId ?? (() => crypto.randomUUID()))()
  const ready = await api.ready({ stageInstanceId })

  if (!ready.ok) {
    await api.reportState({ stageInstanceId, status: 'error', errorCode: ready.error.code })
    return { stageInstanceId, dispose() { /* noop */ } }
  }

  const report = (status: Live2dStageReport['status']): void => {
    void api.reportState({ stageInstanceId, status })
  }
  report(ready.data.status)

  let unsubscribe: Unsubscribe = () => {}
  unsubscribe = api.onCommand((command) => {
    // command 是共享联合类型，不能扩成任意 JSON；dispose 后立即释放 listener。
    void options.onCommand?.(command)
    if (command.type === 'dispose') unsubscribe()
  })
  await options.onBootstrap?.(ready.data)

  return {
    stageInstanceId,
    dispose: unsubscribe
  }
}
