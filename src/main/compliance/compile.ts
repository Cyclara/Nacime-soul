// src/main/compliance/compile.ts
// 规则编译器（F5-001 §3.3 三条硬约束 + §5 ReDoS 防线 + CMP-S11）。
// 零依赖：不 import config / logger / 任何 IO。调用方（setup，P3C1-07/08）负责
// 把 rejected 记日志并继续以有效子集运行——「拒绝但应用可启动」（P3C1-02 验收）。
//
// 与 F5-001 §3.3「违反直接抛错」的衔接：抛错粒度是**单条规则**而非整批。
// 拒绝 = 该规则的硬失败（不降级为警告），经 rejected[] 显式上抛；整批编译永不抛出，
// 应用以其余有效规则启动。出厂规则集由 compile.test.ts 断言零拒绝（任何回归在 CI 炸响）。

import type { ComplianceRule } from './rules'

/** 编译通过的单条规则。regex 已验证无 g/y 标志——重复 test/exec 结果确定（CMP-S11）。 */
export interface CompiledComplianceRule {
  readonly rule: ComplianceRule
  readonly regex: RegExp
}

export interface ComplianceRuleRejection {
  /** 取不到合法 id 时原样保留输入值，便于定位。 */
  readonly ruleId: string
  readonly reasons: readonly string[]
}

export interface CompileComplianceRulesResult {
  readonly rules: readonly CompiledComplianceRule[]
  readonly rejected: readonly ComplianceRuleRejection[]
}

/** F5-001 §3.3 硬约束 2：id 格式。 */
export const COMPLIANCE_RULE_ID_PATTERN = /^R-[A-Z]{2}-\d{2}$/

/**
 * 编译一批规则：逐条校验，坏的进 rejected、好的进 rules，永不抛出。
 *
 * 校验项（与 F5-001 §3.3 / §5、CMP-S11 对齐）：
 * 1. id 格式合法且批内唯一（重复 id 保留首条、拒绝后续——不让后写的悄悄顶掉先写的）。
 * 2. `action === 'block'` ⟹ `severity === 'critical' && confidence >= 0.95`。
 * 3. pattern 不得带 g/y 标志（有状态 lastIndex 会让重复匹配不确定）。
 * 4. pattern 不得含「内含量词的组再被无界量词包裹」的嵌套结构（ReDoS 静态防线）。
 * examples 的 hit/miss 自校验不在此处——F5-001 §3.3 规定它在单测里跑（rules.test.ts）。
 */
export function compileComplianceRules(
  rules: readonly ComplianceRule[]
): CompileComplianceRulesResult {
  const compiled: CompiledComplianceRule[] = []
  const rejected: ComplianceRuleRejection[] = []
  const seenIds = new Set<string>()

  for (const rule of rules) {
    const reasons: string[] = []

    if (!COMPLIANCE_RULE_ID_PATTERN.test(rule.id)) {
      reasons.push(`id 格式非法（期望 ${COMPLIANCE_RULE_ID_PATTERN.source}）：${JSON.stringify(rule.id)}`)
    } else if (seenIds.has(rule.id)) {
      reasons.push(`id 重复：${rule.id}（保留首条，拒绝本条）`)
    }

    if (rule.action === 'block' && !(rule.severity === 'critical' && rule.confidence >= 0.95)) {
      reasons.push(
        `action 'block' 要求 severity 'critical' 且 confidence >= 0.95（实际 ${rule.severity}/${rule.confidence}）`
      )
    }

    if (rule.pattern.global || rule.pattern.sticky) {
      reasons.push(`pattern 带 g/y 标志（${rule.pattern.flags}），有状态 lastIndex 会破坏重复匹配确定性`)
    }

    if (hasNestedUnboundedQuantifier(rule.pattern.source)) {
      reasons.push('pattern 含嵌套无界量词（ReDoS 风险），线性时间安全校验未通过')
    }

    if (reasons.length > 0) {
      rejected.push({ ruleId: rule.id, reasons })
    } else {
      seenIds.add(rule.id)
      compiled.push({ rule, regex: rule.pattern })
    }
  }

  return { rules: compiled, rejected }
}

/**
 * ReDoS 静态扫描：检测「组内存在可变宽度量词，且该组闭包后被无界量词（* + {n,}）包裹」
 * 的结构——经典指数回溯形态，如 `(a+)+`、`(\w*)*`、`(a?)+`、`(x+){2,}`。
 *
 * 判定口径（保守，宁拒勿放——拒绝的代价只是该规则不进编译结果，应用照常启动）：
 * - 可变宽度量词：`*` `+` `?` `{n,m}`（m≠n，含开放上界）；`{n}` 定宽不算。
 * - 无界量词：`*` `+` `{n,}`（开放上界）；`?` 与 `{n,m}` 有界重复只产生多项式风险，放行。
 * - 组闭包时，「组内出现过量词」的属性向外层组传播（star height 语义）：
 *   任何**含**量词（含后代组内）的组再被无界量词包裹即检出，如 `(?:(a+)x)+`。
 * - 顶层（不在任何组内）的量词合法（star height 1）。
 *
 * 不尝试识别的残留风险（由运行时兜底，见 F5-001 §3.4）：
 * - 相邻同类量词（`\w+\w+`）与模糊分支（`(a|a)+`）——多项式级，
 *   由单次输入长度上限（segmentMaxChars）与单轮 budgetMs 防线覆盖。
 */
export function hasNestedUnboundedQuantifier(source: string): boolean {
  interface GroupFrame {
    hasVariableQuantifier: boolean
  }
  const stack: GroupFrame[] = []
  /** 刚闭合的组（供紧随其后的量词判定归属）；出现任何其他 token 即清空。 */
  let lastClosedGroup: GroupFrame | null = null

  const n = source.length
  let i = 0
  while (i < n) {
    const ch = source[i]

    // 转义：跳过下一个字符
    if (ch === '\\') {
      i += 2
      lastClosedGroup = null
      continue
    }

    // 字符类：整体跳过（含 [\]...] 与 []...] 首字符字面量情形）
    if (ch === '[') {
      i++
      if (source[i] === '^') i++
      if (source[i] === ']') i++
      while (i < n && source[i] !== ']') {
        if (source[i] === '\\') i++
        i++
      }
      i++ // 跳过 ']'
      lastClosedGroup = null
      continue
    }

    // 组开始：统一压栈（捕获/非捕获/前瞻/后顾/命名组/内联标志组同等对待）
    if (ch === '(') {
      stack.push({ hasVariableQuantifier: false })
      lastClosedGroup = null
      i++
      if (source[i] === '?') {
        i++
        if (source[i] === '<') {
          i++
          if (source[i] === '=' || source[i] === '!') {
            i++ // (?<= / (?<!
          } else {
            while (i < n && source[i] !== '>') i++ // (?<name>
            i++
          }
        } else {
          while (i < n && /[a-z]/i.test(source[i])) i++ // ES2025 内联标志 (?ims:
          if (source[i] === ':' || source[i] === '=' || source[i] === '!') i++
        }
      }
      continue
    }

    // 组结束：含量词的组向外层传播（star height 语义），并记录闭包组供量词判定
    if (ch === ')') {
      const closed = stack.pop() ?? null
      if (closed !== null && closed.hasVariableQuantifier && stack.length > 0) {
        stack[stack.length - 1].hasVariableQuantifier = true
      }
      lastClosedGroup = closed
      i++
      continue
    }

    // 量词
    if (ch === '*' || ch === '+' || ch === '?') {
      if (applyQuantifier(stack, lastClosedGroup, /* variable */ true, /* unbounded */ ch !== '?')) {
        return true
      }
      lastClosedGroup = null
      i++
      if (source[i] === '?') i++ // lazy 后缀
      continue
    }
    if (ch === '{') {
      const m = /^\{(\d+)(?:,(\d*))?\}/.exec(source.slice(i))
      if (m !== null) {
        const min = Number(m[1])
        const openEnded = m[0].includes(',') && m[2] === ''
        const boundedMax = m[2] !== undefined && m[2] !== '' ? Number(m[2]) : null
        const variable = openEnded || boundedMax === null ? m[0].includes(',') : boundedMax > min
        const unbounded = openEnded
        if (applyQuantifier(stack, lastClosedGroup, variable, unbounded)) {
          return true
        }
        lastClosedGroup = null
        i += m[0].length
        if (source[i] === '?') i++ // lazy 后缀
        continue
      }
      // 非法 `{` 按字面量处理（Annex B）
      lastClosedGroup = null
      i++
      continue
    }

    // 其他 token（字面量、^ $ | 等）
    lastClosedGroup = null
    i++
  }
  return false

  /**
   * 登记一次量词。返回 true = 检出嵌套无界量词。
   * - 量词作用于刚闭合的组：组内已有可变宽度量词且本次为无界量词 → 嵌套，检出。
   * - 否则：可变宽度量词标记到当前最内层组（顶层无组则忽略）。
   */
  function applyQuantifier(
    frames: GroupFrame[],
    closedGroup: GroupFrame | null,
    variable: boolean,
    unbounded: boolean
  ): boolean {
    if (closedGroup !== null) {
      if (unbounded && closedGroup.hasVariableQuantifier) return true
      // 量词作用于组本身；其「可变宽度」属性向更外层传播（如 (?:（好）?x)+ 的外组）
      if (variable && frames.length > 0) frames[frames.length - 1].hasVariableQuantifier = true
      return false
    }
    if (variable && frames.length > 0) frames[frames.length - 1].hasVariableQuantifier = true
    return false
  }
}
