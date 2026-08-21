// tests/evals/types.ts
// P2-44: Golden Eval v1 fixture schema（S-004-补充 §3.2 实例化）。
//
// 与文档的关系：
//   - 结构性断言（expected/forbidden）由代码 100% 判定，进 CI。
//   - 语义 rubric 只落报告（tests/evals/reports/v1-latest.json）供人工评分，不门禁 CI。
//   - PS 类的 assistantOutputExample 是可选 provenance 字段（S-004-补充 §3.2 第 3 条）：
//     表达"该样本不得出现在角色回复"，不是 expected output。F5-001 C1 源码落地后，
//     运行器应改为直接从 COMPLIANCE_RULES.examples.hit 生成/核验；当前先校验坐标格式 + 快照非空。
//
// evidence.messageId 约定：fixture 写 `"current-user"`，harness 驱动轮次时替换为实际 userMessageId。

export type GoldenCategory =
  | 'fact-extraction'
  | 'boundaries'
  | 'preference-change'
  | 'user-correction'
  | 'retrieval'
  | 'injection-defense'
  | 'persona-consistency'
  | 'long-context'
  | 'memory-transparency'
  | 'attribution-gate'

export type GoldenTargetLayer = 'l0' | 'l1' | 'l2'
export type GoldenCertainty = 'explicit' | 'inferred' | 'uncertain'
export type GoldenAttribution = 'user_explicit' | 'assistant_inferred' | 'mixed'
export type GoldenMemoryType = 'one_off' | 'situational' | 'stable'
export type GoldenImportance = 'low' | 'medium' | 'high'

/** setup.l2 预置记忆条目 */
export interface GoldenSetupL2 {
  content: string
  /** 检索别名 token（RT 类控制确定性召回；运行器并入 embed 文本） */
  keywords?: string[]
  importance?: number
  source?: 'creator' | 'user_explicit' | 'inferred'
}

/** 每例初始记忆状态（可空） */
export interface GoldenSetup {
  /** field -> 具体值或 null（"未知"）。null 时用 clearField */
  l0?: Record<string, string | null>
  l2?: GoldenSetupL2[]
}

/** 候选脚本里的 evidence 引用（messageId 固定 'current-user'） */
export interface GoldenEvidenceScript {
  messageId: 'current-user'
  role: 'user'
  /** 必须是该轮 user text 的连续子串（judge 会子串校验） */
  quote: string
}

/** 该轮模型应提取的候选（Faux provider 响应脚本） */
export interface GoldenCandidateScript {
  targetLayer: GoldenTargetLayer
  /** 仅 targetLayer='l0' 必填 */
  field?: string
  content: string
  confidence: number
  certainty: GoldenCertainty
  attribution: GoldenAttribution
  evidence: GoldenEvidenceScript[]
  /** 仅 targetLayer='l2' 必填 */
  memoryType?: GoldenMemoryType
  /** 仅 L2 使用 */
  importance?: GoldenImportance
  /** 非空时 judge 无条件拒绝 */
  forbiddenOverclaims?: string[]
}

/** M-42：归因门语义判定脚本（对单条候选的 step 6 预标注结论） */
export interface GoldenAttributionVerdict {
  userSelfStatement: boolean
  assistantDirected: boolean
}

/** 一轮对话（user/assistant 交替）。user 轮可带候选脚本；assistant 轮仅上下文 */
export interface GoldenTurn {
  role: 'user' | 'assistant'
  text: string
  candidates?: GoldenCandidateScript[]
  /**
   * M-42：归因门脚本，与 candidates 数组索引对齐（attribution[i] 标注 candidates[i]）；
   * 数组项为 null 表示该候选无预标注（如 L1/L2 候选——语义门只判定 L0）。
   * 整个字段缺省 = 本轮回退正则表（fail-closed 路径，75 例旧用例的默认行为）。
   */
  attribution?: (GoldenAttributionVerdict | null)[]
  /**
   * UC 类纠正轮：先 seedReference 模拟上一轮 turn.end 的 l2.referenced fan-out。
   * 元素为 `$written:N`（第 N 次写入的 L2 memoryId，0-based）或 `$l2:<content子串>`。
   */
  reference?: string[]
  /** UC 类：本轮走 chat.message 语义（reference-tracker 纠正判定），不驱动记忆提取 */
  correctionCheck?: boolean
  /** MT 类：本 user 轮驱动后，按 content 子串软删 L2（模拟用户删除记忆） */
  softDelete?: string
}

/** 结构性断言（代码 100% 判定） */
export interface GoldenExpected {
  /** 该例运行后 L0 字段被写入（valuePattern 为正则，缺省=任意值） */
  l0Writes?: Array<{ field: string; valuePattern?: string }>
  /** 该例运行后 L2 写入条数范围 */
  l2Writes?: { min?: number; max?: number }
  /** 必须出现的 judge reject reason codes（可空数组=不应有拒绝） */
  candidatesRejected?: string[]
  /** 下轮 prompt 动态层（l0/l1/l2/relationship）必须含的子串 */
  promptMustInclude?: string[]
  /** 下轮 prompt 不得含的子串 */
  promptMustExclude?: string[]
  /** F5-006 B 层：纠正轮后 l2.corrected 事件数（UC 类） */
  correctedEvents?: { min?: number; max?: number }
  /** F5-006 B 层：引用确认轮后 l2.confirmed 事件数（MT 类） */
  confirmedEvents?: { min?: number; max?: number }
}

/** 违反即 fail 的禁令 */
export interface GoldenForbidden {
  /** 不得误写的 L0 字段 */
  l0Fields?: string[]
  /** seed/identity/soul 等静态层不得被记忆变更污染 */
  seedMutation?: boolean
  /** 用户文本不得进 system/seed 层 */
  roleEscalation?: boolean
  /** PS 类：该样本不得出现在角色回复（provenance；F5-001 §3.3 examples.hit） */
  assistantOutputExample?: {
    kind: 'compliance-example-hit'
    ruleId: string
    exampleIndex: number
    contract: string
    snapshot: string
  }
}

/** 语义评分（人工/judge，不阻塞 CI） */
export interface GoldenRubric {
  dimensions: string[]
  note: string
}

export interface GoldenCase {
  suiteVersion: 'v1'
  caseId: string
  category: GoldenCategory
  setup?: GoldenSetup
  input: GoldenTurn[]
  expected: GoldenExpected
  forbidden?: GoldenForbidden
  rubric: GoldenRubric
}

/** 用例完整性校验（运行器加载时逐例执行；缺失即 fail） */
export function validateGoldenCase(raw: unknown): GoldenCase {
  if (!raw || typeof raw !== 'object') throw new Error('case is not an object')
  const c = raw as Record<string, unknown>
  if (c.suiteVersion !== 'v1') throw new Error(`suiteVersion must be 'v1'`)
  if (typeof c.caseId !== 'string' || !c.caseId) throw new Error('caseId missing')
  const category = c.category as string
  const CATEGORIES: readonly string[] = [
    'fact-extraction',
    'boundaries',
    'preference-change',
    'user-correction',
    'retrieval',
    'injection-defense',
    'persona-consistency',
    'long-context',
    'memory-transparency',
    'attribution-gate'
  ]
  if (!CATEGORIES.includes(category)) throw new Error(`unknown category: ${category}`)
  if (!Array.isArray(c.input) || c.input.length < 1)
    throw new Error('input must be non-empty array')
  for (const t of c.input as Array<Record<string, unknown>>) {
    if (t.role !== 'user' && t.role !== 'assistant') throw new Error('input turn role invalid')
    if (typeof t.text !== 'string' || !t.text) throw new Error('input turn text missing')
    // M-42：attribution 脚本与 candidates 索引对齐；逐项校验形状
    if (t.attribution !== undefined) {
      if (!Array.isArray(t.attribution)) throw new Error('turn attribution must be array')
      const candCount = Array.isArray(t.candidates) ? t.candidates.length : 0
      if (t.attribution.length !== candCount) {
        throw new Error('turn attribution length must equal candidates length')
      }
      for (const v of t.attribution as unknown[]) {
        if (v === null) continue
        if (!v || typeof v !== 'object') throw new Error('attribution entry must be object|null')
        const b = v as Record<string, unknown>
        if (typeof b.userSelfStatement !== 'boolean' || typeof b.assistantDirected !== 'boolean') {
          throw new Error('attribution entry booleans invalid')
        }
      }
    }
  }
  if (!c.expected || typeof c.expected !== 'object') throw new Error('expected missing')
  return c as unknown as GoldenCase
}
