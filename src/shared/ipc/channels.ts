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
  // ── 验收反馈⑦：选择模式批量按轮删除 + 清空会话（additive 新增）──
  'companion:chat:delete-selected',
  'companion:chat:clear-session',
  // ── P2-44：聊天记录全文搜索（FTS5，additive 新增）──
  'companion:chat:search',
  // ── P3C1-07：合规用户反馈（F5-001 §3.7，additive 新增；幂等写入 compliance_feedback）──
  'companion:chat:feedback',
  // ── P3C1-08：合规调试快照（F5-001 §3.10，additive 新增；仅调试面板用，聚合量无正文）──
  'companion:compliance:get-snapshot',
  // ── P3A-05/06：仅 Live2D stage capability 可调用（不向 chat preload 暴露）──
  'companion:stage:ready',
  'companion:stage:report-state',
  // ── P3A-23：chat renderer Live2D management ──
  'companion:live2d:get-state',
  'companion:live2d:choose-import-source',
  'companion:live2d:select-model',
  'companion:live2d:set-visible',
  'companion:live2d:reset-window-placement',
  // P3A-25：取景实时预览。只驱动 stage 视觉，不写 config；保存/放弃时由 main 归位。
  'companion:live2d:preview-framing',
  'companion:live2d:retry-load',
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
  // ── P3G-04：回收站（GC soft_deleted 的唯一公开管理面）──
  'companion:memory:list-recycle-bin',
  'companion:memory:restore-from-recycle-bin',
  'companion:memory:empty-recycle-bin',
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
  'companion:dmae:mute-anomaly',
  // ── M-50：自动更新检测（2026-08-24 用户需求，additive 新增）──
  'companion:app:check-for-updates',
  'companion:app:get-update-status',
  'companion:app:quit-and-install'
] as const

/** Phase 1 + Phase 2 的 main->renderer event 通道 */
export const IPC_EVENT_CHANNELS = [
  'companion:event:chat-stream',
  'companion:event:app-error',
  'companion:event:window-state',
  // ── Phase 2：记忆/成长跨进程同步唯一通知源（S-003-补充 §3.2）──
  'companion:event:memory-updated',
  // ── M-50：更新状态推送（main 侧 Updater 状态机 → renderer toast）──
  'companion:event:update-status',
  // ── P3A-05/06：main → stage；只承载枚举命令，不接受任意 JSON 指令 ──
  'companion:event:stage-command',
  // ── P3A-23：main → chat renderer Live2D projection ──
  'companion:event:live2d-state'
] as const

export type IpcInvokeChannel = (typeof IPC_INVOKE_CHANNELS)[number]
export type IpcEventChannel = (typeof IPC_EVENT_CHANNELS)[number]
