// src/shared/ipc/channels.ts
// IPC 通道常量。命名：companion:<domain>:<verb>
// invoke 走 ipcRenderer.invoke/ipcMain.handle；event 走 webContents.send
// 依据：S-003 §3.2、§3.3

/** Phase 1 的 17 个 invoke 通道 */
export const IPC_INVOKE_CHANNELS = [
  'companion:app:get-info',
  'companion:app:open-user-data',
  'companion:window:minimize',
  'companion:window:toggle-maximize',
  'companion:window:close',
  'companion:window:get-state',
  'companion:config:get',
  'companion:config:update',
  'companion:config:test-model',
  'companion:config:reset-domain',
  'companion:chat:list',
  'companion:chat:create-session',
  'companion:chat:send',
  'companion:chat:cancel',
  'companion:chat:retry',
  'companion:debug:get-snapshot',
  'companion:debug:open-log-folder'
] as const

/** Phase 1 的 3 个 main->renderer event 通道 */
export const IPC_EVENT_CHANNELS = [
  'companion:event:chat-stream',
  'companion:event:app-error',
  'companion:event:window-state'
] as const

export type IpcInvokeChannel = (typeof IPC_INVOKE_CHANNELS)[number]
export type IpcEventChannel = (typeof IPC_EVENT_CHANNELS)[number]
