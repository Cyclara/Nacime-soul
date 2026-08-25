// src/shared/update/types.ts
// 自动更新状态类型（M-50）
// 依据：2026-08-24 用户需求「自动检测更新并弹出提示」，参考 stablyai/orca 的
// updater 状态机（idle/checking/available/downloading/downloaded/not-available/error）裁剪而来。
//
// 语义：
//   - main 侧的 Updater 是唯一状态源；renderer 通过 companion:event:update-status
//     事件 + companion:app:get-update-status 拉取（启动补水）保持一致
//   - userInitiated 标记本次检查是否由用户在设置页手动触发：
//     后台周期检查的 not-available/error 不打扰用户（只记日志），
//     手动检查的这两个状态才会在 UI 上给出反馈
//   - downloaded 是唯一能触发「立即更新」动作的状态

export type UpdateStatus =
  | { state: 'idle' }
  | { state: 'checking'; userInitiated: boolean }
  | { state: 'available'; version: string }
  | { state: 'not-available'; userInitiated: boolean }
  | { state: 'downloading'; version: string; percent: number }
  | { state: 'downloaded'; version: string }
  | { state: 'error'; message: string; userInitiated: boolean }

export type UpdateStateName = UpdateStatus['state']
