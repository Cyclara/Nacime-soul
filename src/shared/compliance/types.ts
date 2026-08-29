// src/shared/compliance/types.ts
// 合规审查共享类型（F5-001）
// C0-1：先落 ComplianceGateScope 单真源——gate / config / 公开快照三处共引，
//       不得只定义在 main-only 模块（S-005-补充 §1.2）。
// C1 P3C1-02：扩充违规类型体系 + DecisionRecord 反事实字段组（开工裁定 1.4/1.5）。
//   本文件只放类型；影子策略常量集按裁定 1.5 落 rules.ts 侧（带版本号、不碰 config）。

/**
 * 门控作用范围。
 * - first-segment：只对第一个语义段做阻断判定；放行后全速直通，后续段只 flag。
 * - all-segments：每段都判定；非首段的 block 自动降级为 flag（不可撤回原则）。诊断用。
 * - observe：只做匹配与记录，从不干预输出（裁定 1.1：releaseText 逐字直通、零持留）。
 * - off：完全关闭，运行时等价 gate.enabled=false（裁定 1.8）。
 */
export type ComplianceGateScope = 'first-segment' | 'all-segments' | 'observe' | 'off'

/**
 * 违规类型（F5-001 §3.2，七类）。
 * 文本层不互斥：一条回复可同时命中多类（反方 §3.2 边界矩阵 B01/B16/B22），
 * 统计分三层——rule hit / violation instance / affected turn，禁止相加（反方 §2.3）。
 */
export type ComplianceViolationType =
  /** 角色把当前这次存在描述为模型/程序/被系统指令控制，或泄漏真实提示边界。 */
  | 'meta-reference'
  /** 把双方关系框成服务窗口的固定开场/收尾/客服措辞。 */
  | 'assistant-persona'
  /** 以模板化能力/责任免责代替回应。真诚劝就医等安全建议不属此类（F5-001 §3.2）。 */
  | 'disclaimer'
  /** 用户未要求结构化交付时，以标题/清单/多段说理压过对话。 */
  | 'lecturing'
  /** 无输入/工具/已知事实依据，却声称确定知道用户事实、环境或未来。仅离线 LLM 可判。 */
  | 'omniscience'
  /** 没有承接用户当前意图，也没有显式转场理由。仅离线 LLM 可判。 */
  | 'topic-jump'
  /** 自称、对用户的称呼、语气与人设或近几轮显著不一致。 */
  | 'persona-drift'

/**
 * 违规严重度。语义与 F5-011 的 LogLevel **不是**一回事，不要混用。
 * - critical：用户一眼能看出"这不是她在说话"。允许（但不必然）在线阻断。
 * - warning：有经验的用户能察觉别扭。永不在线阻断，进指标与趋势。
 * - info：仅统计意义，单次出现无需关注。
 */
export type ComplianceSeverity = 'critical' | 'warning' | 'info'

/**
 * 检测手段。'hybrid' 只出现在类型级描述里；
 * 具体某条 violation 的 detectionMethod 只会是 'regex' 或 'llm'。
 */
export type ComplianceDetectionMethod = 'regex' | 'llm' | 'hybrid'

/**
 * 命中位置。**只存偏移量，不存正文**——正文不得离开进程内存进入日志/IPC/指标（§3.9）。
 * 一律为 assistant 原始**全文**的绝对 UTF-16 坐标（裁定 1.11 S-C14），
 * 禁止存 segment 局部偏移（后段 local start=0 会误触全文 prefix strip）。
 */
export interface ComplianceSpan {
  /** 相对于本轮 assistant 全文的起始字符索引（UTF-16 code unit，与 String.prototype.slice 一致）。 */
  readonly start: number
  /** 命中片段长度（字符数）。 */
  readonly length: number
}

/**
 * 一条违规发现。gate 与 auditor 共用这个结构，靠 detectionMethod 区分来源。
 * （gate 侧产出见 P3C1-03；auditor 侧见 P3C1-06。）
 */
export interface ComplianceViolation {
  readonly type: ComplianceViolationType
  readonly severity: ComplianceSeverity
  /**
   * 置信度 [0,1]。
   * - regex：规则的**出厂静态值**，含义是"这条规则命中时确实是违规的先验概率"。
   * - llm：审查器返回值。
   * 两种来源不在同一尺度上，不要做算术比较。
   */
  readonly confidence: number
  readonly detectionMethod: Exclude<ComplianceDetectionMethod, 'hybrid'>
  /** 正则来源时必填，LLM 来源时为 undefined。 */
  readonly ruleId?: string
  /** 正则来源时必填；LLM 来源时可选（模型不一定能给出准确偏移）。 */
  readonly span?: ComplianceSpan
}

/**
 * 规则命中后的动作。
 * - block：中止本次生成并重生成。**只在首段且 attempt===0 时真正生效**，其余场合自动降级为 flag。
 * - strip：静默剥离。仅当命中片段位于文本最开头（全文 start===0，允许前导空白）
 *   且剥离后剩余非空时生效；否则降级为 flag。**禁止句中替换。**
 *   裁定 1.1 勘误：observe / attempt 1 / 熔断强制 observe 下 strip 一律降级为 flag。
 * - flag：只记录，不干预。
 */
export type ComplianceRuleAction = 'block' | 'strip' | 'flag'

/**
 * 影子策略下「不可介入」的原因枚举（开工裁定 1.5 #2，八值）。
 * flush 两值语义（裁定 1.2 澄清）：命中的模式在时限门/长度门放行前尚未完整命中、
 * 跨放行点才完成的情形；门触发时已完整命中者照常可拦（wouldBlock=true，不取这两个值）。
 */
export type BlockIneligibleReason =
  /** 规则在影子策略中的目标动作不是 block（非候选）。 */
  | 'action-not-candidate'
  /** 当前 scope 为 observe，结构上不拦截。 */
  | 'observe'
  /** 命中发生在首段放行之后。 */
  | 'after-first-segment'
  /** 命中时该片段之前的文本已经放行（不可撤回原则）。 */
  | 'already-released'
  /** 时限门（maxHoldMs）触发放行时模式尚未完整命中。 */
  | 'deadline-flush'
  /** 长度门（segmentMaxChars）触发放行时模式尚未完整命中。 */
  | 'length-flush'
  /** 熔断打开，强制 observe。 */
  | 'circuit-open'
  /** attempt 1（重生成轮）恒 observe，不拦截。 */
  | 'retry-attempt'

/**
 * 逐命中决策记录（开工裁定 1.4）：每次规则命中一条，per attempt。
 * **不含任何回复正文**——只有 id / 偏移 / 枚举 / 时序计数（§3.11 红线）。
 * gate 内部累积，`takeRecords()` 单次移交、取后清空、幂等（P3C1-03/04 落地）；
 * ChatService 流结束后取走，经 `TurnEndData.complianceRecords`（上限 64）到
 * TURN_END 审计 hook 批写 `compliance_samples`（P3C1-05 三表迁移）。
 */
export interface ComplianceDecisionRecord {
  /** 候选生成标识（一轮一次生成尝试一个；C1 无真 block 时与 turn 一一对应）。 */
  readonly candidateId: string
  readonly turnId: string
  readonly attemptIndex: 0 | 1
  readonly segmentIndex: number
  readonly ruleId: string
  /** assistant 原始全文绝对 UTF-16 偏移（裁定 1.11 S-C14）。 */
  readonly span: ComplianceSpan
  readonly confidence: number
  /** 规则出厂声明动作。 */
  readonly declaredAction: ComplianceRuleAction
  /** 实际执行动作（C1 observe 下恒 'flag'；C2 起记录真实降级）。 */
  readonly effectiveAction: ComplianceRuleAction
  /** 影子策略（SHADOW_POLICY_VERSION 对应版本）下的目标动作——反事实，不代表应升级。 */
  readonly counterfactualAction: ComplianceRuleAction
  /** 若采用影子首段策略，本次命中是否可在首段介入（拦截机会估计，不回答重生成质量）。 */
  readonly wouldBlockUnderFirstSegmentPolicy: boolean
  /** wouldBlock=false 时的原因。 */
  readonly blockIneligibleReason?: BlockIneligibleReason
  /** 命中发生前已放行的字符数（UTF-16）。 */
  readonly releasedCharsBefore: number
  /** 影子策略版本（写入 compliance_samples.shadow_policy_version，防中途调参后新旧数据混算）。 */
  readonly shadowPolicyVersion: string
}

// === 用户反向信号（F5-001 §3.7；P3C1-07 落地）===

/**
 * 用户对某条回复的负面反馈。
 * 红线（§3.7 + 开工裁定 1.7）：反馈只作**复核优先级**信号，**不是**合规违规的因果标签——
 * 不得直接驱动规则权重/动作的任何自动调整；规则 action 变更必须过 §4 人工判据。
 */
export type ComplianceFeedbackKind =
  /** 泛化的"这条不好"。用户不需要说明原因。 */
  | 'dislike'
  /** 用户明确指出"这不像她"。**方向与 dislike 不同**——这是支持违规存在的证据（漏报线索），
   *  裁定 1.7 #1：统计 dislikeOnHitTurns 时必须排除本值；#2：恒不阻止规则升级。 */
  | 'out-of-character'

/** IPC: 'companion:chat:feedback' 请求。 */
export interface ChatFeedbackRequest {
  readonly sessionId: string
  readonly turnId: string
  readonly messageId: string
  readonly kind: ComplianceFeedbackKind
}

/** IPC: 'companion:chat:feedback' 响应。幂等——重复上报同样返回 ok（只计一次）。 */
export interface ChatFeedbackResponse {
  readonly ok: true
}

/**
 * IPC: 'companion:compliance:get-snapshot' 响应（F5-001 §3.10，P3C1-08 落地）。
 * 调试面板快照。**只含聚合量，不含任何正文**——模型生成的 rationale 即使声称不摘抄
 * 原文也不可信，故不得进入快照、IPC、日志或数据库。派生率均标注为近似值
 * （分母不是真值，只能看趋势）。无 event 通道（审查不可见原则）。
 */
export interface ComplianceSnapshot {
  readonly gateEnabled: boolean
  readonly gateScope: ComplianceGateScope
  /** 每条规则的命中计数，按 ruleId。含被禁用的（计数为 0）。 */
  readonly ruleHits: Readonly<Record<string, number>>
  /** 编译期被拒的规则。 */
  readonly rejectedRules: readonly { readonly id: string; readonly reason: string }[]
  /**
   * 最近 50 条违规（环形缓冲）。只含本地/规则层可验证的分类元数据；
   * **不得含 rationale**--它是模型控制的自由文本，可能违背 prompt 摘录回复。
   */
  readonly recentViolations: readonly {
    readonly turnId: string
    readonly type: ComplianceViolationType
    readonly severity: ComplianceSeverity
    readonly detectionMethod: 'regex' | 'llm'
    readonly ruleId?: string
  }[]
  /** 派生率，均标注为近似值。null = 无数据（如 C1 observe 无 blocks）。 */
  readonly approxFalsePositiveRate: number | null
  readonly approxEscapeRate: number | null
}
