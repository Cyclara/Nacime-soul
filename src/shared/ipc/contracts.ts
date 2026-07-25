// src/shared/ipc/contracts.ts
// IPC 统一类型：IpcResult、Contract Map、Validator、AppInfo
// 依据：S-003 §3.1、§3.4

import type { IpcError, PublicAppError } from '../errors'
import type { IpcEventChannel, IpcInvokeChannel } from './channels'
import type {
  ConfigResetRequest,
  ConfigUpdateRequest,
  ConnectionTestResult,
  ModelConnectionTestRequest,
  PublicConfigSnapshot
} from '../config/types'
import type {
  ChatCancelRequest,
  ChatHistorySnapshot,
  ChatListRequest,
  ChatRetryRequest,
  ChatSendAck,
  ChatSendRequest,
  ChatStreamEvent
} from '../chat/types'
import type { DebugSnapshot } from '../observability/types'

// === 统一结果信封 ===

export type Unsubscribe = () => void

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: IpcError }

// === App info ===

export interface AppInfo {
  version: string
  platform: string
  arch: string
}

// === Contract Map。依据 S-003 §3.4 ===

export interface IpcInvokeMap {
  'companion:app:get-info': { req: undefined; res: AppInfo }
  'companion:app:open-user-data': { req: undefined; res: void }
  'companion:window:minimize': { req: undefined; res: void }
  'companion:window:toggle-maximize': { req: undefined; res: { maximized: boolean } }
  'companion:window:close': { req: undefined; res: void }
  'companion:window:get-state': { req: undefined; res: { maximized: boolean } }
  'companion:config:get': { req: undefined; res: PublicConfigSnapshot }
  'companion:config:update': { req: ConfigUpdateRequest; res: PublicConfigSnapshot }
  'companion:config:test-model': { req: ModelConnectionTestRequest; res: ConnectionTestResult }
  'companion:config:reset-domain': { req: ConfigResetRequest; res: PublicConfigSnapshot }
  'companion:chat:list': { req: ChatListRequest; res: ChatHistorySnapshot }
  'companion:chat:create-session': { req: undefined; res: { sessionId: string } }
  'companion:chat:send': { req: ChatSendRequest; res: ChatSendAck }
  'companion:chat:cancel': { req: ChatCancelRequest; res: void }
  'companion:chat:retry': { req: ChatRetryRequest; res: { requestId: string } }
  'companion:debug:get-snapshot': { req: undefined; res: DebugSnapshot }
  'companion:debug:open-log-folder': { req: undefined; res: void }
}

export interface IpcEventMap {
  'companion:event:chat-stream': ChatStreamEvent
  'companion:event:app-error': PublicAppError
  'companion:event:window-state': { maximized: boolean }
}

// re-export 通道类型，供外部使用
export type { IpcEventChannel, IpcInvokeChannel }

// === Validator ===

export type Validator<T> = (value: unknown) => value is T
