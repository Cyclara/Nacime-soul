// src/main/memory/dmae/rules.ts
// P2-33：DMAE 异常检测规则引擎（13 条规则 + 抑制关系）。
// 依据：F5-002 §3.3 的 13 条规则全表 + §3.3 抑制关系 + 样本门槛。
//
// 设计要点：
//   1. 每条规则是纯函数 (ctx: AnomalyContext) => DmaeAnomaly | null，可独立单测
//   2. 样本门槛：l2Total<20 或 currentTurn<50 时统计型规则全部静默（R11 例外）
//   3. R06 不是统计异常，是固定情景提示，恒为 info，不受样本门槛控制
//   4. R09 的 advice.kind 恒为 'inspect'，changes 恒为空（S-F07）
//   5. 抑制关系在 evaluateAllRules 中实现，不在单条规则内
//   6. muted 规则不输出（调用方在 evaluateAllRules 后过滤）

import type {
  AnomalyContext,
  AnomalyRule,
  AnomalyRuleId,
  DmaeAnomaly,
  DmaeAdvice,
  DmaeParamChange
} from './anomaly-types'
import type { TunableParam } from './advice-types'
import { solveDecayForLifespan, normalizeSuggestion, maxAchievableLifespan } from './advice'

// === 样本门槛 ===

/** 统计型规则在 l2Total<20 或 currentTurn<50 时全部静默（R11/R06 例外） */
function hasSufficientSample(ctx: AnomalyContext): boolean {
  return ctx.entries.length >= 20 && ctx.currentTurn >= 50
}

// === 13 条规则 ===

/** R01: 衰减主导 / 忘得太快 -- 近 W 天 archivedTransitions/l2Total≥0.6 且 medianLifespan<6 */
const R01: AnomalyRule = (ctx) => {
  if (!hasSufficientSample(ctx)) return null
  const windowDays = ctx.windows.R01.days ?? 3
  const recent3d = ctx.daily.slice(-windowDays)
  if (recent3d.length === 0) return null
  const totalArchived = recent3d.reduce((s, d) => s + d.archivedTransitions, 0)
  const l2Total = ctx.entries.length
  if (l2Total === 0) return null
  const archivedPct = totalArchived / l2Total
  if (archivedPct < 0.6) return null

  // medianLifespan：从 recentSamples 算（首次 Active 到跌出 Active 的轮数）
  const lifespans = computeLifespans(ctx.recentSamples)
  const medianLifespan = median(lifespans)
  if (medianLifespan >= 6) return null

  // 建议值：反解 (α,β) 让存活轮数从 medianLifespan 提升到目标
  const targetTurns = Math.min(
    maxAchievableLifespan(5, 50, ctx.params.promptThreshold),
    Math.max(medianLifespan + 1, Math.ceil(medianLifespan * 2))
  )
  const solve = solveDecayForLifespan({
    targetTurns,
    medianImportance: 5,
    peakActivation: 50,
    threshold: ctx.params.promptThreshold,
    currentBeta: ctx.params.decayBeta,
    currentUserRewardBase: ctx.params.userRewardBase
  })

  const advice = buildTuneAdvice('R01', solve, ctx, [
    { param: 'decayAlpha', current: ctx.params.decayAlpha },
    { param: 'decayBeta', current: ctx.params.decayBeta }
  ])

  return {
    ruleId: 'R01',
    severity: 'critical',
    title: '最近的事淡得有点快',
    narrative: `过去 ${recent3d.length} 天，新近进入记忆的内容里有 ${Math.round(archivedPct * 100)}% 很快就淡下去了，多数只在思考范围里停留约 ${medianLifespan} 轮。可以把遗忘速度放慢一点。`,
    technical: `decay-dominant: ${Math.round(archivedPct * 100)}% archived/${windowDays}d, medianLifespan ${medianLifespan}`,
    evidence: {
      memoryIds: [],
      metrics: { archivedPct: round2(archivedPct), medianLifespan, l2Total },
      windowTurns: 0,
      windowDays
    },
    advice,
    detectedAt: ctx.now
  }
}

/** R02: 衰减不足 / 位置被旧事占满 -- 近 W 天 saturatedTurns/turns≥0.8 且 medianSilence≥30 */
const R02: AnomalyRule = (ctx) => {
  if (!hasSufficientSample(ctx)) return null
  const windowDays = ctx.windows.R02.days ?? 7
  const recent7d = ctx.daily.slice(-windowDays)
  if (recent7d.length === 0) return null
  const totalTurns = recent7d.reduce((s, d) => s + d.turns, 0)
  const totalSaturated = recent7d.reduce((s, d) => s + d.saturatedTurns, 0)
  if (totalTurns === 0 || totalSaturated / totalTurns < 0.8) return null

  // medianSilence：从 active entries 算
  const activeEntries = ctx.entries.filter((e) => e.state === 'Active')
  const silences = activeEntries.map((e) => Math.max(e.userSilence, e.modelSilence))
  const medianSilence = median(silences)
  if (medianSilence < 30) return null

  // 建议：增大 α
  const suggestedAlpha = normalizeSuggestion(
    'decayAlpha',
    ctx.params.decayAlpha,
    ctx.params.decayAlpha * 1.5
  )
  const advice: DmaeAdvice | null =
    suggestedAlpha !== null
      ? {
          ruleId: 'R02',
          kind: 'tune',
          changes: [
            {
              param: 'decayAlpha',
              currentValue: ctx.params.decayAlpha,
              suggestedValue: suggestedAlpha,
              direction: 'increase'
            }
          ],
          narrative: `最近 ${recent7d.length} 天，思考位置经常达到上限。可以让很久没出现的内容更快让位。`,
          interactionWarnings: [],
          observeAfter: { turns: 50, days: 3 },
          confidence: 'medium'
        }
      : null

  return {
    ruleId: 'R02',
    severity: 'warning',
    title: '思考的位置一直很满',
    narrative: `最近 ${recent7d.length} 天，上一轮实际注入的记忆位置经常达到上限。其中一半已经 ${medianSilence} 轮没被提到。可以让很久没出现的内容更快让位。`,
    technical: `stuck-active: ${Math.round((totalSaturated / totalTurns) * 100)}% saturated/${windowDays}d, medianSilence ${medianSilence}`,
    evidence: {
      memoryIds: [],
      metrics: { saturatedPct: round2(totalSaturated / totalTurns), medianSilence, totalTurns },
      windowTurns: 0,
      windowDays
    },
    advice,
    detectedAt: ctx.now
  }
}

/** R03: 激活集合饥饿 -- 近 W 天 medianPromptSelected≤max(2,maxActive×0.2) 且 l2Total≥30 且 medianRetrievalHits≥3 */
const R03: AnomalyRule = (ctx) => {
  if (!hasSufficientSample(ctx)) return null
  if (ctx.entries.length < 30) return null
  const windowDays = ctx.windows.R03.days ?? 3
  const recent3d = ctx.daily.slice(-windowDays)
  if (recent3d.length === 0) return null
  const medianSelected = median(recent3d.map((d) => d.medianPromptSelected))
  const medianRetrieval = median(recent3d.map((d) => d.medianRetrievalHits))
  const threshold = Math.max(2, ctx.maxActive * 0.2)
  if (medianSelected > threshold) return null
  if (medianRetrieval < 3) return null // 检索空手而归不是 DMAE 问题

  const suggestedAlpha = normalizeSuggestion(
    'decayAlpha',
    ctx.params.decayAlpha,
    ctx.params.decayAlpha * 0.7
  )
  const advice: DmaeAdvice | null =
    suggestedAlpha !== null
      ? {
          ruleId: 'R03',
          kind: 'tune',
          changes: [
            {
              param: 'decayAlpha',
              currentValue: ctx.params.decayAlpha,
              suggestedValue: suggestedAlpha,
              direction: 'decrease'
            }
          ],
          narrative: `她有 ${ctx.entries.length} 条记忆，但每轮带进思考的很少。可以让记忆衰减得慢一点，或降低进入门槛。`,
          interactionWarnings: [],
          observeAfter: { turns: 50, days: 3 },
          confidence: 'medium'
        }
      : null

  return {
    ruleId: 'R03',
    severity: 'warning',
    title: '有记忆，却很少被带进思考',
    narrative: `她已经留下 ${ctx.entries.length} 条记忆，但每轮实际带进思考的中位数只有 ${medianSelected} 条。先确认它们有没有被检索到；检索正常时，再考虑降低门槛或放慢淡忘。`,
    technical: `starvation: medianPromptSelected ${medianSelected} ≤ ${threshold}, medianRetrieval ${medianRetrieval}`,
    evidence: {
      memoryIds: [],
      metrics: {
        medianPromptSelected: medianSelected,
        medianRetrievalHits: medianRetrieval,
        l2Total: ctx.entries.length
      },
      windowTurns: 0,
      windowDays
    },
    advice,
    detectedAt: ctx.now
  }
}

/** R04: 僵尸 Active -- 存在 state=Active 且 userSilence≥W 且 modelSilence≥W */
const R04: AnomalyRule = (ctx) => {
  if (!hasSufficientSample(ctx)) return null
  const windowTurns = ctx.windows.R04.turns ?? 50
  const zombies = ctx.entries.filter(
    (e) => e.state === 'Active' && e.userSilence >= windowTurns && e.modelSilence >= windowTurns
  )
  if (zombies.length < 1) return null

  return {
    ruleId: 'R04',
    severity: 'warning',
    title: '有些记忆一直亮着',
    narrative: `有 ${zombies.length} 条内容已经至少 ${windowTurns} 轮没有命中，却仍保持清晰。它们多半属于不会自然淡忘的永久记忆；看看重要度是否真的需要设为 10。`,
    technical: `stuck-active: ${zombies.length} entries active≥${windowTurns} turns, 0 hits`,
    evidence: {
      memoryIds: zombies.slice(0, 20).map((e) => e.id),
      metrics: { count: zombies.length },
      windowTurns,
      windowDays: 0
    },
    advice: {
      ruleId: 'R04',
      kind: 'inspect',
      changes: [],
      narrative: '这些记忆可能是 importance≥10 的永久豁免条目。检查它们的重要度是否合理。',
      interactionWarnings: [],
      observeAfter: { turns: 0, days: 0 },
      confidence: 'high'
    },
    detectedAt: ctx.now
  }
}

/** R05: 冷冻记忆 / 从未激活 -- neverActivated占l2Total≥30% 且已存在≥W 轮 */
const R05: AnomalyRule = (ctx) => {
  if (!hasSufficientSample(ctx)) return null
  const windowTurns = ctx.windows.R05.turns ?? 100
  // P1（2026-08-10 审计）：轮数从真实 turn 历史节奏推算（每轮平均毫秒），不再用硬编码 30s/轮
  const msPerTurn = estimateMsPerTurn(ctx.recentTurns)
  const frozen = ctx.entries.filter((e) => {
    if (e.everActivated) return false
    if (e.createdAt <= 0) return false // 未知创建时间，无法判龄
    const ageTurns = msPerTurn > 0 ? (ctx.now - e.createdAt) / msPerTurn : 0
    return ageTurns >= windowTurns
  })
  if (frozen.length === 0) return null
  const frozenPct = frozen.length / ctx.entries.length
  if (frozenPct < 0.3) return null

  return {
    ruleId: 'R05',
    severity: 'warning',
    title: '有些记忆从未真正亮起来',
    narrative: `有 ${Math.round(frozenPct * 100)}% 的记忆存在很久，却从没达到过 Active。若从未被检索到，调参数没有帮助；若命中过却没跨过门槛，再调整 Bu 或 threshold。`,
    technical: `frozen: ${Math.round(frozenPct * 100)}% neverActivated, ${frozen.length} entries`,
    evidence: {
      memoryIds: frozen.slice(0, 20).map((e) => e.id),
      metrics: { frozenPct: round2(frozenPct), count: frozen.length },
      windowTurns,
      windowDays: 0
    },
    advice: {
      ruleId: 'R05',
      kind: 'inspect',
      changes: [],
      narrative: '先检查这些记忆是否被检索到。若从未召回，是检索问题不是 DMAE 问题。',
      interactionWarnings: [],
      observeAfter: { turns: 0, days: 0 },
      confidence: 'medium'
    },
    detectedAt: ctx.now
  }
}

/** R06: 冷启动门槛提示 -- userRewardBase<promptThreshold（固定情景提示，info） */
const R06: AnomalyRule = (ctx) => {
  // R06 不是统计异常，不受样本门槛控制
  if (ctx.params.userRewardBase >= ctx.params.promptThreshold) return null

  // 情景预览：usOld=0/1/2 时的 Ru
  const ru0 = ctx.params.userRewardBase * (1 + ctx.params.wakeGamma * Math.log(1 + 0))
  const ru1 = ctx.params.userRewardBase * (1 + ctx.params.wakeGamma * Math.log(1 + 1))
  const ru2 = ctx.params.userRewardBase * (1 + ctx.params.wakeGamma * Math.log(1 + 2))

  return {
    ruleId: 'R06',
    severity: 'info',
    title: '刚记下的内容可能需要再聊一次',
    narrative: `在现有异步写入时序下，新记忆第一次可参与检索前积累了几轮沉默并不固定。以最保守的连续命中情形算，单次奖励（${ru0.toFixed(1)}）低于门槛（${ctx.params.promptThreshold}）。先把它当作提示，不把一次没接住直接归因于遗忘。`,
    technical: `cold-start: Bu(${ctx.params.userRewardBase}) < threshold(${ctx.params.promptThreshold}); Ru@us0=${ru0.toFixed(1)} @us1=${ru1.toFixed(1)} @us2=${ru2.toFixed(1)}`,
    evidence: {
      memoryIds: [],
      metrics: {
        ru0: round2(ru0),
        ru1: round2(ru1),
        ru2: round2(ru2),
        threshold: ctx.params.promptThreshold
      },
      windowTurns: 0,
      windowDays: 0
    },
    advice: null, // R06 不给强制建议，只提示
    detectedAt: ctx.now
  }
}

/** R07: 抖动 / 反复进出 -- 近 W 轮跨越threshold≥6次 */
const R07: AnomalyRule = (ctx) => {
  if (!hasSufficientSample(ctx)) return null
  const windowTurns = ctx.windows.R07.turns ?? 50
  // 从 recentSamples 按条目统计跨阈值次数
  const byMemory = new Map<string, import('./history-types').DmaeSamplePoint[]>()
  for (const s of ctx.recentSamples) {
    if (s.turn < ctx.currentTurn - windowTurns) continue
    const arr = byMemory.get(s.memoryId) ?? []
    arr.push(s)
    byMemory.set(s.memoryId, arr)
  }
  let maxCrossings = 0
  let jitteryId = ''
  for (const [id, samples] of byMemory) {
    samples.sort((a, b) => a.turn - b.turn)
    let crossings = 0
    let wasActive = samples[0]?.activation >= ctx.params.promptThreshold
    for (let i = 1; i < samples.length; i++) {
      const isActive = samples[i].activation >= ctx.params.promptThreshold
      if (isActive !== wasActive) crossings++
      wasActive = isActive
    }
    if (crossings > maxCrossings) {
      maxCrossings = crossings
      jitteryId = id
    }
  }
  if (maxCrossings < 6) return null

  return {
    ruleId: 'R07',
    severity: 'info',
    title: '有条记忆在门槛附近来回',
    narrative: `这条记忆近 ${windowTurns} 轮跨过门槛 ${maxCrossings} 次，可能让表现显得忽记忽忘。可以让一次命中推得更高，或让衰减更平缓。`,
    technical: `jitter: ${maxCrossings} crossings/${windowTurns} turns on ${jitteryId}`,
    evidence: {
      memoryIds: jitteryId ? [jitteryId] : [],
      metrics: { crossings: maxCrossings },
      windowTurns,
      windowDays: 0
    },
    advice: null,
    detectedAt: ctx.now
  }
}

/** R08: 模型奖励失效 -- 近 W 轮 Σeff/Σraw<0.05 且 Σ(modelHits-modelHitsGated)≥20 */
const R08: AnomalyRule = (ctx) => {
  if (!hasSufficientSample(ctx)) return null
  const windowTurns = ctx.windows.R08.turns ?? 200
  // 从 recentTurns 取近 W 轮
  const recent = ctx.recentTurns.slice(-windowTurns)
  if (recent.length < 20) return null
  const rawSum = recent.reduce((s, t) => s + t.modelRewardRawSum, 0)
  const effSum = recent.reduce((s, t) => s + t.modelRewardEffectiveSum, 0)
  const validModelHits = recent.reduce((s, t) => s + (t.modelHits - t.modelHitsGated), 0)
  if (validModelHits < 20) return null
  if (rawSum === 0) return null
  const yield_ = effSum / rawSum
  if (yield_ >= 0.05) return null

  return {
    ruleId: 'R08',
    severity: 'info',
    title: '两个旋钮现在几乎不产生收益',
    narrative: `在当前公式里，Bm 和 λ 不能让 activation 净增长；它们最多延缓一小部分衰减。想改善记忆进入或留存，请看 Bu/γ/threshold 或 α/β。`,
    technical: `model-reward-inert: Rm_eff/Rm_raw = ${round2(yield_)} over ${recent.length} turns`,
    evidence: {
      memoryIds: [],
      metrics: { yield: round2(yield_), validModelHits, turns: recent.length },
      windowTurns: recent.length,
      windowDays: 0
    },
    advice: {
      ruleId: 'R08',
      kind: 'inspect',
      changes: [],
      narrative: '调 Bm/λ 无用，这是公式不变量。改善记忆请调 α/β/Bu/γ/threshold。',
      interactionWarnings: [],
      observeAfter: { turns: 0, days: 0 },
      confidence: 'high'
    },
    detectedAt: ctx.now
  }
}

/** R09: Floor复活频繁 -- 近 W 天 ΣtrueFloorRevivals/turns≥0.3（恒 inspect） */
const R09: AnomalyRule = (ctx) => {
  if (!hasSufficientSample(ctx)) return null
  const windowDays = ctx.windows.R09.days ?? 3
  const recent3d = ctx.daily.slice(-windowDays)
  if (recent3d.length === 0) return null
  const totalTurns = recent3d.reduce((s, d) => s + d.turns, 0)
  const totalRevivals = recent3d.reduce((s, d) => s + d.trueFloorRevivals, 0)
  if (totalTurns === 0 || totalRevivals / totalTurns < 0.3) return null

  return {
    ruleId: 'R09',
    severity: 'info',
    title: '有些旧事反复被重新点亮',
    narrative: `近 ${recent3d.length} 天发生了 ${totalRevivals} 次"曾经亮过、归零后又被用户命中"的真实复活。原因不止一种；先展开证据看命中与衰减，再决定是否动参数。`,
    technical: `floor-revival: ${totalRevivals}/${totalTurns} = ${round2(totalRevivals / totalTurns)} rev/turn`,
    evidence: {
      memoryIds: [],
      metrics: {
        trueFloorRevivals: totalRevivals,
        totalTurns,
        ratio: round2(totalRevivals / totalTurns)
      },
      windowTurns: 0,
      windowDays
    },
    advice: {
      ruleId: 'R09',
      kind: 'inspect', // S-F07：恒为 inspect，永不给参数数值
      changes: [], // S-F07：恒为空
      narrative: '复活频率受多种因素影响，先看证据再决定。',
      interactionWarnings: [],
      observeAfter: { turns: 0, days: 0 },
      confidence: 'low'
    },
    detectedAt: ctx.now
  }
}

/**
 * R10: 参数变更无响应 -- lastAnnotation 距今≥窗口(days/turns)，且目标指标（avgActivation）变化<5%。
 * P1（2026-08-10 审计）：修复前只检查"时间够久"就触发，从不评估指标是否真的没变。
 * 目标指标用 avgActivation（趋势图同源），对比 annotation 之前 vs 之后各窗口天的均值。
 */
const R10: AnomalyRule = (ctx) => {
  if (!hasSufficientSample(ctx)) return null
  if (!ctx.lastAnnotation) return null
  const winDays = ctx.windows.R10.days ?? 3
  const winTurns = ctx.windows.R10.turns ?? 100
  const daysAgo = (ctx.now - ctx.lastAnnotation.ts) / (24 * 60 * 60 * 1000)
  const turnsAgo = ctx.currentTurn - ctx.lastAnnotation.turn
  if (daysAgo < winDays && turnsAgo < winTurns) return null

  // 指标对比：annotation.ts 之前的日均 avgActivation vs 之后的
  const before: number[] = []
  const after: number[] = []
  for (const d of ctx.daily) {
    const dayTs = new Date(`${d.date}T00:00:00`).getTime()
    const bucket = dayTs < ctx.lastAnnotation.ts ? before : after
    bucket.push(d.avgActivation)
  }
  const beforeAvg = avg(before)
  const afterAvg = avg(after)
  // 任一侧无数据或 before 为 0 -> 无法判定，不触发（避免假阳性）
  if (before.length === 0 || after.length === 0 || beforeAvg === 0) return null
  const relativeChange = Math.abs((afterAvg - beforeAvg) / beforeAvg)
  if (relativeChange >= 0.05) return null // 指标确实变化了 -> 不报警

  return {
    ruleId: 'R10',
    severity: 'info',
    title: '上次调整还看不出变化',
    narrative: `${Math.round(daysAgo)} 天前调整了参数，但平均记忆强度（${beforeAvg.toFixed(1)} → ${afterAvg.toFixed(1)}，变化 ${(relativeChange * 100).toFixed(1)}%）没有明显起色。可能幅度太小，也可能观察窗口里参数又变过。`,
    technical: `no-response: ${Math.round(daysAgo)}d/${turnsAgo}t since last annotation, avgActivation Δ${(relativeChange * 100).toFixed(1)}%`,
    evidence: {
      memoryIds: [],
      metrics: {
        daysAgo: Math.round(daysAgo),
        turnsAgo,
        avgActivationBefore: round2(beforeAvg),
        avgActivationAfter: round2(afterAvg),
        relativeChange: round2(relativeChange)
      },
      windowTurns: turnsAgo,
      windowDays: Math.round(daysAgo)
    },
    advice: null,
    detectedAt: ctx.now
  }
}

/** R11: 状态文件异常 -- lastLoadReset≠none 或 saveFailures7d≥3 */
const R11: AnomalyRule = (ctx) => {
  // R11 不受样本门槛控制（完整性判定与样本量无关）
  const h = ctx.stateFileHealth
  const windowDays = ctx.windows.R11.days ?? 7
  if (h.lastLoadReset === 'none' && h.saveFailures7d < 3) return null

  const reasons: string[] = []
  if (h.lastLoadReset !== 'none')
    reasons.push(`加载时发生了${h.lastLoadReset === 'invalid-json' ? 'JSON 损坏' : '版本不匹配'}`)
  if (h.saveFailures7d >= 3) reasons.push(`近 7 天保存失败 ${h.saveFailures7d} 次`)

  return {
    ruleId: 'R11',
    severity: 'critical',
    title: '记忆状态文件需要检查',
    narrative: `${reasons.join('；')}。她最近的激活状态可能不完整；请先检查磁盘空间与权限，其他诊断暂时不作数。`,
    technical: `state-file: lastLoadReset=${h.lastLoadReset}, saveFailures7d=${h.saveFailures7d}`,
    evidence: {
      memoryIds: [],
      metrics: {
        saveFailures7d: h.saveFailures7d,
        lastLoadReset: h.lastLoadReset === 'none' ? 0 : 1
      },
      windowTurns: 0,
      windowDays
    },
    advice: {
      ruleId: 'R11',
      kind: 'inspect',
      changes: [],
      narrative: '这是数据完整性问题，不是调参问题。请检查磁盘空间和文件权限。',
      interactionWarnings: [],
      observeAfter: { turns: 0, days: 0 },
      confidence: 'high'
    },
    detectedAt: ctx.now
  }
}

/** R12: 状态漂移 -- state=Archived但lifecycleState='active'的条目数≥l2Total×10% */
const R12: AnomalyRule = (ctx) => {
  if (!hasSufficientSample(ctx)) return null
  const drifted = ctx.entries.filter(
    (e) =>
      (e.state === 'Archived' && e.lifecycleState === 'active') ||
      (e.state === 'Active' && e.lifecycleState === 'archived')
  )
  if (ctx.entries.length === 0) return null
  const driftPct = drifted.length / ctx.entries.length
  if (driftPct < 0.1) return null

  return {
    ruleId: 'R12',
    severity: 'info',
    title: '两套状态出现了较大差异',
    narrative: `有 ${drifted.length} 条记忆的 DMAE 状态与生命周期状态不一致。少量差异是设计允许的，但这个比例偏高；这不是调参问题，需要查看日志。`,
    technical: `state-drift: ${drifted.length} entries (${Math.round(driftPct * 100)}%) inconsistent`,
    evidence: {
      memoryIds: drifted.slice(0, 20).map((e) => e.id),
      metrics: { count: drifted.length, driftPct: round2(driftPct) },
      windowTurns: 0,
      windowDays: 0
    },
    advice: {
      ruleId: 'R12',
      kind: 'inspect',
      changes: [],
      narrative: '这不是调参问题。查看日志确认状态机逻辑是否有 bug。',
      interactionWarnings: [],
      observeAfter: { turns: 0, days: 0 },
      confidence: 'high'
    },
    detectedAt: ctx.now
  }
}

/** R13: 豁免占比失衡 -- exemptRatio<0.02或>0.20（l2Total≥50） */
const R13: AnomalyRule = (ctx) => {
  if (!hasSufficientSample(ctx)) return null
  if (ctx.entries.length < 50) return null
  const exempt = ctx.entries.filter((e) => e.importance >= 10)
  const exemptRatio = exempt.length / ctx.entries.length
  if (exemptRatio >= 0.02 && exemptRatio <= 0.2) return null

  const tooLow = exemptRatio < 0.02
  return {
    ruleId: 'R13',
    severity: 'warning',
    title: '永久记忆的比例不太平衡',
    narrative: `当前有 ${Math.round(exemptRatio * 100)}% 的记忆不会自然衰减。${tooLow ? '太少会缺少长期锚点' : '太多则会长期占据候选集合'}；应调整 importance 评分或手动治理关键记忆。`,
    technical: `exempt-imbalance: exemptRatio=${round2(exemptRatio)} (${tooLow ? 'low' : 'high'})`,
    evidence: {
      memoryIds: exempt.slice(0, 20).map((e) => e.id),
      metrics: {
        exemptRatio: round2(exemptRatio),
        exemptCount: exempt.length,
        l2Total: ctx.entries.length
      },
      windowTurns: 0,
      windowDays: 0
    },
    advice: {
      ruleId: 'R13',
      kind: 'inspect',
      changes: [],
      narrative: tooLow
        ? '永久记忆太少。考虑给关键事实设 importance=10，或手动 pin。'
        : '永久记忆太多。检查 importance 评分策略是否过于宽松。',
      interactionWarnings: [],
      observeAfter: { turns: 0, days: 0 },
      confidence: 'medium'
    },
    detectedAt: ctx.now
  }
}

// === 规则注册表 ===

/** 13 条规则，按 ID 顺序 */
export const ANOMALY_RULES: ReadonlyArray<{ id: AnomalyRuleId; fn: AnomalyRule }> = [
  { id: 'R01', fn: R01 },
  { id: 'R02', fn: R02 },
  { id: 'R03', fn: R03 },
  { id: 'R04', fn: R04 },
  { id: 'R05', fn: R05 },
  { id: 'R06', fn: R06 },
  { id: 'R07', fn: R07 },
  { id: 'R08', fn: R08 },
  { id: 'R09', fn: R09 },
  { id: 'R10', fn: R10 },
  { id: 'R11', fn: R11 },
  { id: 'R12', fn: R12 },
  { id: 'R13', fn: R13 }
]

// === 抑制关系（F5-002 §3.3）===

/**
 * 抑制关系：
 *   R01 存在时 -> 抑制 R09、R03
 *   R02 存在时 -> 抑制 R04
 *   R13 存在时 -> 抑制 R02、R04
 *   R11 存在时 -> 抑制全部其他规则（数据不可信时诊断无意义）
 */
const SUPPRESSIONS: Record<AnomalyRuleId, AnomalyRuleId[]> = {
  R01: ['R09', 'R03'],
  R02: ['R04'],
  R03: [],
  R04: [],
  R05: [],
  R06: [],
  R07: [],
  R08: [],
  R09: [],
  R10: [],
  R11: ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09', 'R10', 'R12', 'R13'],
  R12: [],
  R13: ['R02', 'R04']
}

// === 规则求值（含抑制 + muted 过滤）===

/**
 * 求值全部 13 条规则，应用抑制关系和 muted 过滤。
 * 返回按 severity 排序的异常列表（critical > warning > info）。
 *
 * @param ctx 规则上下文
 * @param muted 当前 muted 状态（ruleId -> 解除时间戳；0=未静音）
 */
export function evaluateAllRules(
  ctx: AnomalyContext,
  muted: Readonly<Record<string, number>> = {}
): DmaeAnomaly[] {
  const now = ctx.now
  // 1. 逐条求值
  const rawResults = new Map<AnomalyRuleId, DmaeAnomaly>()
  for (const rule of ANOMALY_RULES) {
    // muted 过滤：muted[ruleId] > now 表示还在静音期
    const muteUntil = muted[rule.id] ?? 0
    if (muteUntil > now) continue
    const result = rule.fn(ctx)
    if (result) rawResults.set(rule.id, result)
  }

  // 2. 应用抑制关系
  const suppressed = new Set<AnomalyRuleId>()
  for (const id of rawResults.keys()) {
    const suppresses = SUPPRESSIONS[id]
    if (suppresses) {
      for (const target of suppresses) {
        if (rawResults.has(target)) {
          suppressed.add(target)
        }
      }
    }
  }

  // 3. 过滤被抑制的 + 排序
  const result: DmaeAnomaly[] = []
  for (const [id, anomaly] of rawResults) {
    if (suppressed.has(id)) continue
    result.push(anomaly)
  }

  // severity 排序：critical > warning > info
  const severityOrder = { critical: 0, warning: 1, info: 2 }
  result.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])

  return result
}

// === 辅助函数 ===

/** 从 recentSamples 计算每条记忆的存活轮数（首次 Active 到跌出 Active） */
function computeLifespans(samples: readonly import('./history-types').DmaeSamplePoint[]): number[] {
  const byMemory = new Map<string, import('./history-types').DmaeSamplePoint[]>()
  for (const s of samples) {
    const arr = byMemory.get(s.memoryId) ?? []
    arr.push(s)
    byMemory.set(s.memoryId, arr)
  }
  const lifespans: number[] = []
  for (const [, arr] of byMemory) {
    arr.sort((a, b) => a.turn - b.turn)
    let firstActive: number | null = null
    for (const s of arr) {
      if (s.state === 'Active' && firstActive === null) {
        firstActive = s.turn
      } else if (s.state !== 'Active' && firstActive !== null) {
        lifespans.push(s.turn - firstActive)
        firstActive = null
      }
    }
  }
  return lifespans
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0
  const sorted = [...arr].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}

/** 从 recentTurns 估每轮平均毫秒（P1 修复：R05 不再用硬编码 30s/轮）。无数据返回 0。 */
function estimateMsPerTurn(turns: readonly import('./history-types').DmaeTurnRecord[]): number {
  if (turns.length < 2) return 0
  const first = turns[0]
  const last = turns[turns.length - 1]
  const spanTurns = last.turn - first.turn
  if (spanTurns <= 0 || last.ts <= first.ts) return 0
  return (last.ts - first.ts) / spanTurns
}

/** 构建 tune 类型的 advice（从 solveDecayForLifespan 结果） */
function buildTuneAdvice(
  ruleId: AnomalyRuleId,
  solve: import('./advice-types').SolveDecayResult,
  ctx: AnomalyContext,
  currentParams: Array<{ param: TunableParam; current: number }>
): DmaeAdvice | null {
  if (solve.kind === 'unreachable') {
    return {
      ruleId,
      kind: 'inspect',
      changes: [],
      narrative: `把参数调到极限也只能让她记住约 ${solve.maxTurns} 轮--这是记忆公式本身的限制。如果有些事你希望她永远记得，把那几条记忆的重要度设为 10。`,
      interactionWarnings: [],
      observeAfter: { turns: 0, days: 0 },
      confidence: 'high'
    }
  }

  const changes: DmaeParamChange[] = []
  const alphaCurrent =
    currentParams.find((p) => p.param === 'decayAlpha')?.current ?? ctx.params.decayAlpha
  const betaCurrent =
    currentParams.find((p) => p.param === 'decayBeta')?.current ?? ctx.params.decayBeta

  const alphaSuggested = normalizeSuggestion('decayAlpha', alphaCurrent, solve.alpha)
  if (alphaSuggested !== null && alphaSuggested !== alphaCurrent) {
    changes.push({
      param: 'decayAlpha',
      currentValue: alphaCurrent,
      suggestedValue: alphaSuggested,
      direction: alphaSuggested < alphaCurrent ? 'decrease' : 'increase'
    })
  }
  const betaSuggested = normalizeSuggestion('decayBeta', betaCurrent, solve.beta)
  if (betaSuggested !== null && betaSuggested !== betaCurrent) {
    changes.push({
      param: 'decayBeta',
      currentValue: betaCurrent,
      suggestedValue: betaSuggested,
      direction: betaSuggested < betaCurrent ? 'decrease' : 'increase'
    })
  }

  if (solve.kind === 'needs-combo') {
    const buSuggested = normalizeSuggestion(
      'userRewardBase',
      ctx.params.userRewardBase,
      solve.suggestedBu
    )
    if (buSuggested !== null) {
      changes.push({
        param: 'userRewardBase',
        currentValue: ctx.params.userRewardBase,
        suggestedValue: buSuggested,
        direction: 'increase'
      })
    }
  }

  if (changes.length === 0) return null

  return {
    ruleId,
    kind: 'tune',
    changes,
    narrative: `建议调整参数让记忆存活更久。`,
    interactionWarnings: [],
    observeAfter: { turns: 50, days: 3 },
    confidence: 'medium'
  }
}
