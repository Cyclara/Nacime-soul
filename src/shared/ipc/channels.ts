// src/shared/ipc/channels.ts
// IPC 通道常量。命名：companion:<domain>:<verb>
// invoke 走 ipcRenderer.invoke/ipcMain.handle；event 走 webContents.send
// 依据：S-003 §3.2、§3.3、S-003-补充 §3.1（Phase 2 新增 12 invoke + 1 event）

/** Phase 1 的 18 个 invoke 通道（P2-43 插入 chat:get-last-session） */
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
  'companion:chat:get-last-session',
  'companion:chat:send',
  'companion:chat:cancel',
  'companion:chat:retry',
  // ── 验收反馈⑥：按轮删除对话（additive 新增，不动既有通道）──
  'companion:chat:delete-turn',
  // ── 验收反馈⑥c：单条删除（粒度控制，additive 新增）──
  'companion:chat:delete-message',
  'companion:debug:get-snapshot',
  'companion:debug:open-log-folder',
  // ── Phase 2：memory + growth（S-003-补充 §3.1：12 invoke）──
  'companion:memory:get-overview',
  'companion:memory:get-l0',
  'companion:memory:list-l2',
  'companion:memory:get-detail',
  'companion:memory:set-pinned',
  'companion:memory:soft-delete',
  'companion:memory:restore',
  // ── M-44：记忆编辑（L2 内容 + L0 字段；additive 新增，不动既有通道）──
  'companion:memory:update-content',
  'companion:memory:set-l0-field',
  'companion:memory:get-dmae-snapshot',
  'companion:memory:get-dmae-history',
  'companion:growth:get-profile',
  'companion:growth:get-timeline',
  'companion:growth:get-trend',
  // ── Phase 2 P2-32：DMAE 面板（F5-002 §3.7：get-panel/get-trend/explain）──
  'companion:dmae:get-panel',
  'companion:dmae:get-trend',
  'companion:dmae:explain',
  // ── Phase 2 P2-34：DMAE 基准体检（F5-002 §3.6）──
  'companion:dmae:run-benchmark',
  'companion:dmae:record-qualitative',
  // ── M-26：DMAE 异常静音（F5-002 §3.7 第 6 通道，S-005-补充 §1.7）──
  'companion:dmae:mute-anomaly'
] as const

/** Phase 1 + Phase 2 的 main->renderer event 通道 */
export const IPC_EVENT_CHANNELS = [
  'companion:event:chat-stream',
  'companion:event:app-error',
  'companion:event:window-state',
  // ── Phase 2：记忆/成长跨进程同步唯一通知源（S-003-补充 §3.2）──
  'companion:event:memory-updated'
] as const

export type IpcInvokeChannel = (typeof IPC_INVOKE_CHANNELS)[number]
export type IpcEventChannel = (typeof IPC_EVENT_CHANNELS)[number]
