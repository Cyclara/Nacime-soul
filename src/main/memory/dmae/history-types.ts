// src/main/memory/dmae/history-types.ts
// P2-31.5F：DMAE 历史存储 DTO（F5-002 §3.2）。
// 四张表的 TypeScript DTO：dmae_samples / dmae_turns / dmae_daily / dmae_annotations。
// 依据：F5-002 §3.2 的 DmaeSamplePoint / DmaeTurnRecord / DmaeDailyAggregate / DmaeParamAnnotation。
//
// 隐私纪律（F5-011）：这些 DTO 只存数值/ID/枚举，不含记忆 content/引用/查询。

import type { DmaeState } from './formulas'
import type { AnomalyRuleId, UserDmaePreset } from '@shared/memory/dmae-config'
// M-20：DmaeParamsSnapshot / DmaeDailyAggregate 已下沉 shared/memory/dmae-types（跨 IPC），
// 本文件内部使用走此 import；外部既有导入由文件末尾的 re-export 兼容。
import type { DmaeParamsSnapshot } from '@shared/memory/dmae-types'

// === 1. 逐条采样点（dmae_samples）===

/**
 * 逐条采样点。分层采样避免 15k×每轮爆炸：
 *   - 只采样"值得看"的条目：当前 Active 全采 + 本轮发生状态迁移的全采
 *     + 用户显式 pin 观察的全采（面板 [关注] 按钮）
 *   - 其余条目不采样（它们的曲线是平滑衰减，可由公式重建，不必存）
 *   - 每 N 轮采样一次（N = config.memory.dmae.historySampleEveryTurns，默认 1）
 */
export interface DmaeSamplePoint {
  memoryId: string
  /** 全局轮计数器（DMAE turn 序号） */
  turn: number
  ts: number
  activation: number
  userSilence: number
  modelSilence: number
  state: DmaeState
  userHit: boolean
  modelHit: boolean
  modelRewardEffective: number
  modelRewardRaw: number
  modelHitGated: boolean
  decay: number
  everActivatedBefore: boolean
  firstActivation: boolean
  /** 迁移采样真源（005 补列）：更新前/后状态；null = 旧数据行 */
  stateBefore: DmaeState | null
  stateAfter: DmaeState | null
  /** 权威 before 值 + 参数快照（explainLastTurn 用，005 补列；null = 旧数据行） */
  activationBefore: number | null
  userSilenceBefore: number | null
  modelSilenceBefore: number | null
  /** 该轮参数快照 JSON（DmaeParamsSnapshot 序列化）；null = 旧数据行 */
  paramsJson: string | null
}

// === 2. 逐轮标量记录（dmae_turns）===

/**
 * 逐轮标量记录。每轮一行，保留 90 天。
 * 占位数、Σ奖励、真实复活数等每轮一个标量。
 */
export interface DmaeTurnRecord {
  turn: number
  ts: number
  /** 全库 activation ≥ threshold 的条目数（getStats 口径）。不是占位数 */
  eligibleActive: number
  /** 本轮向量检索召回并通过 hydrate 的条数 */
  retrievalHits: number
  /** selectL2 实际返回的条数 = 送进 Prompt 组装的 L2 条数 */
  promptSelected: number
  /** 当时的 maxActive（同时是检索 k） */
  maxActive: number
  userHits: number
  modelHits: number
  /** 模型命中但被 Active gating 拦下的条数 */
  modelHitsGated: number
  /** Σ 本轮所有条目的 clamp 前 Rm */
  modelRewardRawSum: number
  /** Σ 本轮所有条目的 clamp 后 Rm */
  modelRewardEffectiveSum: number
  totalDecay: number
  /** 引擎原始计数（含新记忆首次激活） */
  floorRevivals: number
  /** 剔除 firstActivation 后的真实复活数 */
  trueFloorRevivals: number
  paramsHash: string
  /** 005 补列：各态真实计数 + activation 分布 + 迁入 Archived 数（daily 聚合真源） */
  dormant: number
  archived: number
  l2Total: number
  activationSum: number
  activationCount: number
  activationMedian: number
  archivedTransitions: number
}

// === 3. 每日聚合（dmae_daily）===
// DmaeDailyAggregate 已下沉 shared/memory/dmae-types（M-20），见文件末尾 re-export。

// === 4. 调参事件标注（dmae_annotations）===

/** 调参事件标注。趋势图上画竖线。 */
export interface DmaeParamAnnotation {
  id: string
  ts: number
  turn: number
  before: DmaeParamsSnapshot
  after: DmaeParamsSnapshot
  source: 'manual' | 'preset' | 'advice'
  /** source='preset' 时的预设 id；source='advice' 时的规则 id */
  sourceRef?: string
}

// === 查询请求/响应 ===

export interface DmaeHistoryQuery {
  memoryId?: string
  days: 7 | 30 | 90
}

export interface DmaeHistoryResult {
  samples: DmaeSamplePoint[]
  turns: DmaeTurnRecord[]
}

// === 参数指纹 ===

/**
 * 计算参数指纹（sha1 前 8 位）。参数变了这个值就变，趋势图据此画分段。
 * 不用完整 sha1：8 位 hex = 32 bit，对 8 个参数的组合足够唯一。
 */
export function computeParamsHash(params: DmaeParamsSnapshot): string {
  const json = JSON.stringify([
    params.maxScore,
    params.promptThreshold,
    params.userRewardBase,
    params.wakeGamma,
    params.modelRewardBase,
    params.wakeLambda,
    params.decayAlpha,
    params.decayBeta
  ])
  // 简单 hash（不依赖 crypto 模块，测试友好）
  let hash = 0
  for (let i = 0; i < json.length; i++) {
    const ch = json.charCodeAt(i)
    hash = ((hash << 5) - hash + ch) | 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

// === 从 DmaeParamsSnapshot 构造的辅助 ===

/** 从 MemoryConfig.dmae 提取 DmaeParamsSnapshot */
export function snapshotFromDmaeConfig(dmae: {
  maxScore: number
  promptThreshold: number
  userRewardBase: number
  wakeGamma: number
  modelRewardBase: number
  wakeLambda: number
  decayAlpha: number
  decayBeta: number
}): DmaeParamsSnapshot {
  return {
    maxScore: dmae.maxScore,
    promptThreshold: dmae.promptThreshold,
    userRewardBase: dmae.userRewardBase,
    wakeGamma: dmae.wakeGamma,
    modelRewardBase: dmae.modelRewardBase,
    wakeLambda: dmae.wakeLambda,
    decayAlpha: dmae.decayAlpha,
    decayBeta: dmae.decayBeta
  }
}

// === re-export for type compatibility ===
export type { AnomalyRuleId, UserDmaePreset }
// M-20：下沉 shared/memory/dmae-types 的 DTO，此处 re-export 兼容既有导入
export type { DmaeParamsSnapshot, DmaeDailyAggregate } from '@shared/memory/dmae-types'
