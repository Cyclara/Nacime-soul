// src/preload/live2d-stage.ts
// P3A-05：Live2D stage 专用最小 preload。
//
// 与 chat preload 物理分离：不暴露 companion / 原始 ipcRenderer / 通用 invoke。stage 仅能
// ready、报告元数据状态、订阅 main 下发的枚举 stage 命令。

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { IpcResult, IpcInvokeMap, Unsubscribe } from '@shared/ipc/contracts'
import type {
  Live2dStageBootstrap,
  Live2dStageCommand,
  Live2dStageReadyRequest,
  Live2dStageReport
} from '@shared/live2d/stage-types'

export interface Live2dStageApi {
  ready(input: Live2dStageReadyRequest): Promise<IpcResult<Live2dStageBootstrap>>
  reportState(input: Live2dStageReport): Promise<IpcResult<void>>
  onCommand(callback: (command: Live2dStageCommand) => void): Unsubscribe
}

function isOffsetPercent(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= -100 && value <= 100
}

/** 与 shared validator 同界：≤64 条、单条 1..64 字符。 */
function isExpressionNameList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every((name) => typeof name === 'string' && name.length >= 1 && name.length <= 64)
  )
}

function isStageCommand(value: unknown): value is Live2dStageCommand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const command = value as Record<string, unknown>
  switch (command['type']) {
    case 'load-model':
      return Object.keys(command).every((key) => key === 'type' || key === 'modelUrl' || key === 'expressionNames') && typeof command['modelUrl'] === 'string' && command['modelUrl'].length > 0 && command['modelUrl'].length <= 2048 && (command['expressionNames'] === undefined || isExpressionNameList(command['expressionNames']))
    case 'set-emotion':
      return Object.keys(command).every((key) => key === 'type' || key === 'emotion') && ['neutral', 'smile', 'happy', 'surprised', 'sad', 'angry', 'shy', 'confused'].includes(String(command['emotion']))
    case 'set-zoom':
      return Object.keys(command).every((key) => key === 'type' || key === 'zoom') && typeof command['zoom'] === 'number' && Number.isFinite(command['zoom']) && command['zoom'] >= 0.25 && command['zoom'] <= 3
    case 'set-offset':
      return Object.keys(command).every((key) => key === 'type' || key === 'offsetX' || key === 'offsetY') && isOffsetPercent(command['offsetX']) && isOffsetPercent(command['offsetY'])
    case 'resize':
      return Object.keys(command).every((key) => key === 'type' || key === 'width' || key === 'height') && typeof command['width'] === 'number' && Number.isFinite(command['width']) && command['width'] >= 1 && command['width'] <= 8192 && typeof command['height'] === 'number' && Number.isFinite(command['height']) && command['height'] >= 1 && command['height'] <= 8192
    case 'pause':
    case 'resume':
    case 'dispose':
      return Object.keys(command).length === 1
    default:
      return false
  }
}

function invokeStage<K extends 'companion:stage:ready' | 'companion:stage:report-state'>(
  channel: K,
  payload: IpcInvokeMap[K]['req']
): Promise<IpcResult<IpcInvokeMap[K]['res']>> {
  return ipcRenderer.invoke(channel, payload) as Promise<IpcResult<IpcInvokeMap[K]['res']>>
}

export const live2dStageApi: Live2dStageApi = Object.freeze({
  ready(input) {
    return invokeStage('companion:stage:ready', input)
  },
  reportState(input) {
    return invokeStage('companion:stage:report-state', input)
  },
  onCommand(callback) {
    const listener = (_event: IpcRendererEvent, command: unknown): void => {
      if (isStageCommand(command)) callback(command)
    }
    ipcRenderer.on('companion:event:stage-command', listener)
    return () => ipcRenderer.removeListener('companion:event:stage-command', listener)
  }
})

contextBridge.exposeInMainWorld('live2dStage', live2dStageApi)
