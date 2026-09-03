// src/main/voice/tts/correction-detector.ts
// P3B-07 / F5-007-1：自我纠正检测（§1.12.2）。
//
// 只做确定性、低成本的趋势信号：segment 文本命中已知纠正前缀时标记
// correctionRole='self-correction'，播放侧把与上一段的 gap 压到 0-80ms。
// 冻结原则（§1.12.1）：已 committed/已播放的段永不删除、永不跳过--
// 自我纠正不是撤回协议，声音必须与屏幕上的两句都一致。

/** §1.12.2 原文正则表（2026-08-23 冻结；改表 = 改合同）。 */
export const SELF_CORRECTION_PREFIXES: readonly RegExp[] = [
  /^\s*(?:不[，,]|不是[，,]?|等等[，,。]?|等一下[，,。]?|我说错了[，,。]?|准确地说[，,]?|更准确地说[，,]?|其实不是)/,
  // 英文分隔符集合是 `,`、em-dash（U+2014）与 `-`（§1.12.2 原文 `[,—-]`）；2026-09-02
  // 核对发现此前转写丢了 em-dash 变成 `[,--]`，`no—wait` 一类漏检，按原文修正。
  /^\s*(?:no[,—-]|wait[,—-]?|actually[,—-]?|rather[,—-]?|I misspoke[,—-]?|more precisely[,—-]?)/i
]

/** segment 是否以自我纠正前缀开头。纯函数；正则表冻结不改语义。 */
export function isSelfCorrection(segmentText: string): boolean {
  return SELF_CORRECTION_PREFIXES.some((pattern) => pattern.test(segmentText))
}
