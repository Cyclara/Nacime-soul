// src/shared/global.d.ts
// window.companion 全局类型声明
// 依据：S-002 §3.5、S-003 §3.7

import type { AppInfo, IpcResult, Unsubscribe } from './ipc/contracts'
import type { PublicAppError } from './errors'
import type {
  ChatCancelRequest,
  ChatHistorySnapshot,
  ChatListRequest,
  ChatSendAck,
  ChatSendRequest,
  ChatStreamEvent
} from './chat/types'
import type {
  ConfigResetRequest,
  ConfigUpdateRequest,
  ConnectionTestResult,
  ModelConnectionTestRequest,
  PublicConfigSnapshot
} from './config/types'
import type { DebugSnapshot } from './observability/types'

/** preload 暴露的 typed API。依据 S-003 §3.7 */
export interface CompanionApi {
  app: {
    getInfo(): Promise<IpcResult<AppInfo>>
    openUserData(): Promise<IpcResult<void>>
    onError(cb: (e: PublicAppError) => void): Unsubscribe
  }
  window: {
    minimize(): Promise<IpcResult<void>>
    toggleMaximize(): Promise<IpcResult<{ maximized: boolean }>>
    close(): Promise<IpcResult<void>>
    getState(): Promise<IpcResult<{ maximized: boolean }>>
    onState(cb: (state: { maximized: boolean }) => void): Unsubscribe
  }
  config: {
    get(): Promise<IpcResult<PublicConfigSnapshot>>
    update(patch: ConfigUpdateRequest): Promise<IpcResult<PublicConfigSnapshot>>
    testModel(input: ModelConnectionTestRequest): Promise<IpcResult<ConnectionTestResult>>
    resetDomain(input: ConfigResetRequest): Promise<IpcResult<PublicConfigSnapshot>>
  }
  chat: {
    list(input: ChatListRequest): Promise<IpcResult<ChatHistorySnapshot>>
    createSession(): Promise<IpcResult<{ sessionId: string }>>
    send(input: ChatSendRequest): Promise<IpcResult<ChatSendAck>>
    cancel(input: ChatCancelRequest): Promise<IpcResult<void>>
    retry(input: {
      sessionId: string
      messageId: string
    }): Promise<IpcResult<{ requestId: string }>>
    onStream(cb: (event: ChatStreamEvent) => void): Unsubscribe
  }
  debug: {
    getSnapshot(): Promise<IpcResult<DebugSnapshot>>
    openLogFolder(): Promise<IpcResult<void>>
  }
}

declare global {
  interface Window {
    companion: Readonly<CompanionApi>
  }
}
