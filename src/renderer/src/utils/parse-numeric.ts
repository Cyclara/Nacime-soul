// src/renderer/src/utils/parse-numeric.ts
// M-29：数值输入解析——空/NaN 返回 undefined（调用方据此跳过写入草稿）。
// 旧实现在各设置组件直接 `Number(input.value)`，清空输入框时 Number('')===0，
// 会把草稿静默写成 0，可能触发校验失败或保存了错误的静默值。

/** 解析数值输入；空串或 NaN 返回 undefined（表示"本次不写入"）。 */
export function parseNumericInput(value: string): number | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const num = Number(trimmed)
  return Number.isNaN(num) ? undefined : num
}
