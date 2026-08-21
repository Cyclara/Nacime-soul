// src/renderer/src/utils/time-divider.ts
// QQ/微信式时间分隔条（验收反馈④b）：
// - 首条消息前必显示；与上一条间隔 > 5 分钟时再显示一条
// - 标签随"现在"流逝自动老化（组件持 ticking now，标签随时间推移换说法）：
//     今天        → HH:mm
//     昨天        → 昨天 HH:mm
//     前天        → 前天 HH:mm
//     今年更早    → M月D日（不再带时分）
//     跨年        → YYYY年M月D日 HH:mm
// 全部用本地时区日历日计算（与她感知时间的 datetime-prefix 同一套本地时间观）。

/** 两条消息间隔超过该值则插入分隔条（QQ/微信同为 5 分钟） */
export const DIVIDER_GAP_MS = 5 * 60 * 1000

const DAY_MS = 24 * 60 * 60 * 1000

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

/** 本地时区当日 0 点的时间戳 */
function startOfDay(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** 是否在该消息前插入时间分隔条。prevCreatedAt 为 null 表示这是首条消息。 */
export function shouldShowDivider(prevCreatedAt: number | null, createdAt: number): boolean {
  if (prevCreatedAt === null) return true
  return createdAt - prevCreatedAt > DIVIDER_GAP_MS
}

/**
 * 分隔条标签。now 由调用方传入（组件侧为 ticking ref），
 * 同一条消息的标签会随 now 推移从「HH:mm」老化为「昨天 HH:mm」等。
 */
export function formatDividerLabel(createdAt: number, now: number): string {
  const d = new Date(createdAt)
  const hhmm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  // 日历日差：昨天 23:59 与今天 00:01 只差 2 分钟，但跨了一天，应显示「昨天」
  const dayDiff = Math.round((startOfDay(now) - startOfDay(createdAt)) / DAY_MS)

  if (dayDiff <= 0) return hhmm // 今天（<=0 兜底时钟回拨/未来时间戳）
  if (dayDiff === 1) return `昨天 ${hhmm}`
  if (dayDiff === 2) return `前天 ${hhmm}`
  if (d.getFullYear() === new Date(now).getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日`
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`
}
