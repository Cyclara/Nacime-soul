// 时间前缀：给发给 provider 的 user 消息加 `[YYYY-MM-DD HH:MM] ` 时间锚。
// 依据：2026-08-21 用户反馈"她不知道我电脑上的时间"，做法参考
// 项目参考/airi packages/core-agent/src/messages/datetime-prefix.ts。
//
// 设计要点（与 airi 一致）：
//   - 只在消息装配时附加，不落库、不在 UI 显示——DB 与界面保持干净。
//   - 历史轮与当前轮同一形状：当"当前"轮下次变成"历史"轮时前缀缓存（KV cache）不失效。
//   - 不给 assistant 消息加——airi 实测过：模型会把时间前缀模仿进自己的回复里。
//   - 用本机时区（getHours 等本地方法）：她的"现在"就是用户电脑上的现在。

function pad(value: number): string {
  return value.toString().padStart(2, '0')
}

/**
 * 把时间戳格式化为 `[YYYY-MM-DD HH:MM] `（含尾随空格）。
 *
 * Before: createdAt = 1787295451601
 * After:  "[2026-08-21 17:57] "
 */
export function formatTimePrefix(createdAt: number): string {
  const d = new Date(createdAt)
  return (
    `[${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}] `
  )
}
