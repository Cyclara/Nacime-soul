// src/main/memory/dmae/engine.ts
// P2-23: DMAE 引擎/状态机。每轮 turn.end 更新全部 L2 条目 activation。
// 依据：S-Phase2 P2-23、S-004-补充 D-02/D-03、技术分析 §DMAE Worldbook 引擎。
//
// 公式语义来源：Cyrene-Agent worldbook.ts updateActivation (v4.0)。
//   silence 更新：
//     usNew = userHit ? 0 : usOld + 1
//     msNew = (userHit || modelHit) ? 0 : msOld + 1   [MS=距上次"进入上下文"的轮数]
//   activation 更新：
//     aNew = aOld + userReward + modelReward - decay
//     aNew = max(0, aNew)
//     Floor: if (userHit && aOld==Archived) aNew = max(aNew, importance)   [仅 Archived 复活]
//     aNew = clamp(aNew, 0, maxScore)
//   modelReward gating：仅 modelHit && aOld==Active 时给 Rm，且 Rm = clamp(0, rawRm, decay-ε)
//
// nacime-soul 与 Cyrene-Agent 的区别：
//   1. 无关键词匹配；userHit/modelHit 由调用方（P2-25）从检索命中/referencedMemoryIds 提供
//   2. importance 从 L2Store 读（getImportance 注入），非 entry.intrinsicValue
//   3. MAX_ACTIVE 用 config.memory.maxActive（默认 15），tiebreak 按 id 升序（D-03）
//   4. 不直接写 L2 DB；返回 transitions，调用方（P2-25）按需写 lifecycleState/archivedAt
//
// 性能：15k 条每轮全量更新是纯算术（无 IO），可接受（S-Phase2 P2-23 风险评估）。

import {
  computeUserReward,
  computeModelReward,
  computeDecay,
  deriveState,
  floorValue,
  clampActivation,
  RM_CLAMP_EPSILON,
  type DmaeParams,
  type DmaeState
} from './formulas'

/** 单条 L2 的 DMAE 运行时状态。持久化在 dmae-state.json（P2-24） */
export interface DmaeEntryState {
  activation: number
  /** 距上次用户命中的轮数（userSilence） */
  userSilence: number
  /** 距上次"进入上下文"（用户或模型命中）的轮数（modelSilence） */
  modelSilence: number
  /**
   * 是否曾经被激活过（activation > 0）。S-F04 裁定：引擎 commit 后若 aNew > 0 则原子置 true，
   * 一旦为 true 不再回落。是 firstActivation / trueFloorRevivals 的唯一真源。
   * v4 新增（004 迁移补入，初值 = activation > 0）。
   */
  everActivated: boolean
}

/** 本轮 turn 的命中输入。ID 为 L2 memoryId（不含 l2: 前缀） */
export interface DmaeTurnInput {
  /** 用户提及的记忆 ID 集合（检索命中） */
  userHitIds: ReadonlySet<string>
  /** 模型提及的记忆 ID 集合（referencedMemoryIds：进 prompt 且回复完成） */
  modelHitIds: ReadonlySet<string>
}

/** 状态迁移记录。调用方据此写 L2.lifecycleState + archivedAt */
export interface DmaeTransition {
  id: string
  from: DmaeState
  to: DmaeState
  /**
   * 建议 L2.archivedAt 的新值。
   * - to='Archived' -> number（写入当前时间戳）
   * - from='Archived' && to='Active'（Floor 复活）-> null（清空）
   * - 其他迁移 -> undefined（archivedAt 不变）
   */
  archivedAt: number | null | undefined
}

/** updateTurn 返回值 */
export interface DmaeTurnResult {
  /** 状态迁移记录（from != to 的条目）。调用方据此写 L2 DB */
  transitions: DmaeTransition[]
  /** 本轮统计（指标上报用） */
  stats: {
    userHits: number
    modelHits: number
    floorRevivals: number
    totalDecay: number
    /** 更新后各态条目数（P2-25 指标 gauges，遍历时顺便统计，0 额外开销） */
    active: number
    dormant: number
    archived: number
  }
  /**
   * P2-31.5D：引擎诊断 ABI（F5-002 §3.2/§3.7）。
   * 逐条诊断：raw/effective/gated/decay/hits/everActivatedBefore。
   * 统计：raw/effective sum、gated、trueFloorRevivals。
   *
   * 禁止在诊断层重算公式（S-F02 裁定）--rawRm 必须由引擎带出。
   * 改变 clamp 测试常数时采样结果同步，无第二份公式。
   */
  diagnostics: DmaeTurnDiagnostics
}

/**
 * P2-31.5D：单条记忆本轮诊断（供 HistoryStore 分层采样写入 dmae_samples）。
 * 只在需要采样时读取，不影响引擎主路径性能（纯算术 + Map 写入）。
 */
export interface DmaeEntryDiagnostics {
  memoryId: string
  /** 本轮用户命中 */
  userHit: boolean
  /** 本轮模型命中 */
  modelHit: boolean
  /** 模型命中但被 Active gating 拦下（aOld 不是 Active） */
  modelHitGated: boolean
  /** clamp 前的 raw Rm（仅 modelHit 且走到 clamp 时记实际值，否则 0） */
  modelRewardRaw: number
  /** clamp 后的 effective Rm */
  modelRewardEffective: number
  /** 本轮 decay */
  decay: number
  /** 本轮之前是否曾经 activation > 0（S-F04：唯一真源是状态文件 everActivated） */
  everActivatedBefore: boolean
  /** 本轮是否首次激活（!everActivatedBefore && aNew > 0） */
  firstActivation: boolean
  /** 更新前状态（P0 采样修复：history-store 靠它识别全部状态迁移） */
  stateBefore: DmaeState
  /** 更新后状态 */
  stateAfter: DmaeState
  /** 更新前 activation（explainLastTurn 权威 before 值，batch E） */
  activationBefore: number
  /** 更新前 userSilence */
  userSilenceBefore: number
  /** 更新前 modelSilence */
  modelSilenceBefore: number
  /** 更新后 activation */
  activationAfter: number
  /** 更新后 userSilence */
  userSilenceAfter: number
  /** 更新后 modelSilence */
  modelSilenceAfter: number
}

/**
 * P2-31.5D：本轮聚合诊断（供 HistoryStore 写入 dmae_turns + 面板 R08 规则用）。
 */
export interface DmaeTurnDiagnostics {
  /** 逐条诊断（按 states 遍历序） */
  entries: DmaeEntryDiagnostics[]
  /** Σ 本轮所有条目的 clamp 前 Rm（只累加真正进了 clamp 的） */
  modelRewardRawSum: number
  /** Σ 本轮所有条目的 clamp 后 Rm */
  modelRewardEffectiveSum: number
  /** 模型命中但被 Active gating 拦下的条数 */
  modelHitsGated: number
  /**
   * 剔除 firstActivation 后的真实复活数。
   * 引擎原始 floorRevivals 会把新记忆首次激活计成复活（activation=0 被 deriveState 判为 Archived）。
   * trueFloorRevivals = floorRevivals - firstActivations。R09 只用这个。
   */
  trueFloorRevivals: number
  /**
   * 本轮更新后全库 activation 的分布统计（P1 daily 聚合真源）。
   * history-store 用它填 dmae_turns.activation_sum/count/median，避免把"条目数"当"激活均值"。
   */
  activationStats: { count: number; sum: number; mean: number; median: number }
  /** 本轮从非 Archived 迁入 Archived 的条目数（dmae_daily.archivedTransitions 真源，R01 用） */
  archivedTransitions: number
}

/**
 * 从 DmaeEntryState 派生当前态。纯函数，selector/指标共用。
 */
export function deriveEntryState(st: DmaeEntryState, threshold: number): DmaeState {
  return deriveState(st.activation, threshold)
}

/**
 * 每轮 turn.end 更新全部 L2 条目的 DMAE 状态。
 *
 * 原地更新 states（mutate DmaeEntryState）；返回 transitions + stats。
 * 调用方负责持久化 states（P2-24 stateFile）+ 按 transitions 写 L2 DB（P2-25）。
 *
 * @param states 所有 L2 的 DMAE 状态（key=memoryId）。调用方确保与 L2 DB 对齐（孤儿已清理）
 * @param input 本轮命中（userHitIds=检索命中，modelHitIds=referencedMemoryIds）
 * @param params DMAE 参数（从 config.memory.dmae）
 * @param getImportance 从 L2Store 读 importance（id -> importance）。若 L2 已删应预先清理 states
 * @param now 当前时间戳（archivedAt 用）；默认 Date.now
 */
export function updateTurn(
  states: Map<string, DmaeEntryState>,
  input: DmaeTurnInput,
  params: DmaeParams,
  getImportance: (id: string) => number,
  now: () => number = Date.now
): DmaeTurnResult {
  const { userHitIds, modelHitIds } = input
  const threshold = params.promptThreshold
  const maxScore = params.maxScore

  const transitions: DmaeTransition[] = []
  let userHits = 0
  let modelHits = 0
  let floorRevivals = 0
  let totalDecay = 0
  let active = 0
  let dormant = 0
  let archived = 0

  // P2-31.5D：诊断统计
  const entryDiagnostics: DmaeEntryDiagnostics[] = []
  let modelRewardRawSum = 0
  let modelRewardEffectiveSum = 0
  let modelHitsGated = 0
  let firstActivations = 0
  // P1（2026-08-10 审计）：daily 聚合真源——逐条 activationAfter 分布 + 迁入 Archived 计数
  let archivedTransitions = 0
  const activationValues: number[] = []

  for (const [id, st] of states) {
    const usOld = st.userSilence
    const msOld = st.modelSilence
    const aOld = st.activation
    const importance = getImportance(id)
    // P2-31.5D/S-F04：everActivatedBefore 是更新前的值（唯一真源）
    const everActivatedBefore = st.everActivated

    const userHit = userHitIds.has(id)
    const modelHit = modelHitIds.has(id)
    if (userHit) userHits++
    if (modelHit) modelHits++

    // ─ silence 更新 ─
    const usNew = userHit ? 0 : usOld + 1
    // MS = 距上次"进入上下文"的轮数；userHit 或 modelHit 都重置
    const msNew = userHit || modelHit ? 0 : msOld + 1

    // ─ user reward（仅 userHit，I 不参与） ─
    const userReward = userHit ? computeUserReward(usOld, params) : 0

    // ─ decay（I 在 Resistance；importance≥10 硬豁免） ─
    const decay = computeDecay(usNew, msNew, importance, params)
    totalDecay += decay

    // ─ model reward（仅 modelHit + Active gating + Rm<D clamp） ─
    let modelReward = 0
    let rawRm = 0
    let modelHitGated = false
    if (modelHit) {
      const modelOldState = deriveState(aOld, threshold)
      if (modelOldState === 'Active') {
        rawRm = computeModelReward(usOld, params)
        // v4.0 §8 不变量：Rm < D 严格成立（避免 Rm≥D 时仍涨分）
        modelReward = Math.max(0, Math.min(rawRm, decay - RM_CLAMP_EPSILON))
        modelRewardRawSum += rawRm
        modelRewardEffectiveSum += modelReward
      } else {
        // 模型命中但 aOld 不是 Active -> 被 Active gating 拦下
        modelHitGated = true
        modelHitsGated++
      }
    }

    // ─ activation 更新 ─
    let aNew = aOld + userReward + modelReward - decay
    aNew = Math.max(0, aNew)

    // ─ Floor：仅 Archived 复活时触发（避免高价值条目每次命中都 floor 让 Decay/Wake 失效） ─
    const oldState = deriveState(aOld, threshold)
    let revivedFromArchived = false
    if (userHit && oldState === 'Archived') {
      aNew = Math.max(aNew, floorValue(importance))
      floorRevivals++
      revivedFromArchived = true
    }
    aNew = clampActivation(aNew, maxScore)

    // ─ P2-31.5D/S-F04：everActivated 原子翻转（aNew > 0 则置 true，一旦为 true 不再回落） ─
    const firstActivation = !everActivatedBefore && aNew > 0
    if (aNew > 0) {
      st.everActivated = true
    }
    if (firstActivation) {
      firstActivations++
    }

    // ─ commit ─
    st.activation = aNew
    st.userSilence = usNew
    st.modelSilence = msNew

    // ─ 派生新态 + 记录迁移 ─
    const newState = deriveState(aNew, threshold)
    if (newState === 'Active') active++
    else if (newState === 'Dormant') dormant++
    else archived++
    if (oldState !== newState) {
      let archivedAt: number | null | undefined = undefined
      if (newState === 'Archived') {
        archivedAt = now() // 写入时间戳
        archivedTransitions++ // P1：迁入 Archived 计数（R01/daily 真源）
      } else if (revivedFromArchived && newState === 'Active') {
        archivedAt = null // Floor 复活 -> 清空
      }
      transitions.push({ id, from: oldState, to: newState, archivedAt })
    }

    // P1：收集更新后 activation 分布（daily 聚合均值/中位数真源）
    activationValues.push(aNew)

    // ─ P2-31.5D：收集逐条诊断 ─
    entryDiagnostics.push({
      memoryId: id,
      userHit,
      modelHit,
      modelHitGated,
      modelRewardRaw: rawRm,
      modelRewardEffective: modelReward,
      decay,
      everActivatedBefore,
      firstActivation,
      stateBefore: oldState,
      stateAfter: newState,
      activationBefore: aOld,
      userSilenceBefore: usOld,
      modelSilenceBefore: msOld,
      activationAfter: aNew,
      userSilenceAfter: usNew,
      modelSilenceAfter: msNew
    })
  }

  // P1：activation 分布统计（count/sum/mean/median）
  const activationStats = computeActivationStats(activationValues)

  return {
    transitions,
    stats: { userHits, modelHits, floorRevivals, totalDecay, active, dormant, archived },
    diagnostics: {
      entries: entryDiagnostics,
      modelRewardRawSum,
      modelRewardEffectiveSum,
      modelHitsGated,
      trueFloorRevivals: floorRevivals - firstActivations,
      activationStats,
      archivedTransitions
    }
  }
}

/**
 * 选出 Active 态条目，按 activation 降序（同分 id 升序）截 top maxActive。
 *
 * D-03 验收：20 条超阈值 -> 取 activation 前 15；并列分数按 id 稳定排序。
 * 用于 P2-25 selector + 指标上报。
 */
export function rankActiveEntries(
  states: Map<string, DmaeEntryState>,
  threshold: number,
  maxActive: number
): Array<{ id: string; activation: number }> {
  const active: Array<{ id: string; activation: number }> = []
  for (const [id, st] of states) {
    if (st.activation >= threshold) {
      active.push({ id, activation: st.activation })
    }
  }
  // activation 降序；同分 id 升序（稳定 tiebreak，D-03）
  active.sort((a, b) => b.activation - a.activation || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return active.slice(0, Math.max(0, maxActive))
}

/**
 * 统计各态条目数（指标上报用）。
 * 返回 { active, dormant, archived }。
 */
export function countStates(
  states: Map<string, DmaeEntryState>,
  threshold: number
): { active: number; dormant: number; archived: number } {
  let active = 0
  let dormant = 0
  let archived = 0
  for (const st of states.values()) {
    const s = deriveState(st.activation, threshold)
    if (s === 'Active') active++
    else if (s === 'Dormant') dormant++
    else archived++
  }
  return { active, dormant, archived }
}

/** 从一轮的 activation 值数组计算分布统计（count/sum/mean/median）。空数组 -> 全 0 */
function computeActivationStats(values: number[]): {
  count: number
  sum: number
  mean: number
  median: number
} {
  if (values.length === 0) return { count: 0, sum: 0, mean: 0, median: 0 }
  const sum = values.reduce((s, v) => s + v, 0)
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  return { count: values.length, sum, mean: sum / values.length, median }
}

/**
 * 为新 L2 条目创建初始 DMAE 状态。
 * 新记忆 activation=0（Archived 冷态），与 Cyrene-Agent loadFromDirectory 一致。
 * 调用方在 L2 写入后调用此函数把新 id 加入 states。
 */
export function createInitialEntryState(): DmaeEntryState {
  return { activation: 0, userSilence: 0, modelSilence: 0, everActivated: false }
}
