// src/main/memory/dmae/config-observer.ts
// P1（2026-08-10 审计）：DMAE 调参生命周期——config 保存后写 dmae_annotations + 清静音。
// 依据：F5-002 §3.2（config-store 订阅写 dmae_annotations）、§3.7（确认保存触发标注 + muted 重置）。
//
// 修复前：historyStore.addAnnotation 无生产调用者、diagnostics.lastAnnotation 恒 null，
// R10（参数变更无响应）永不可达。
//
// 守卫：params 未变化的事件直接忽略——清静音写回 config 时 params 相同，不会再次触发
// annotation（否则死循环）。

import type { AppConfigV1 } from '@shared/config/types'
import type { DmaeParamsSnapshot, DmaeParamAnnotation } from './history-types'
import { snapshotFromDmaeConfig } from './history-types'

/** 观察者依赖（setup.ts 注入生产实现；测试注入假实现） */
export interface DmaeConfigObserverDeps {
  /** 初始参数快照（观察者启动时的当前配置） */
  getInitialParams: () => DmaeParamsSnapshot
  /** 当前全局 DMAE turn（annotation 记录用） */
  getTurn: () => number
  /** config 订阅（返回退订函数） */
  subscribe: (fn: (event: { config: Readonly<AppConfigV1> }) => void) => () => void
  /** 写 annotation 到历史存储 */
  addAnnotation: (annotation: DmaeParamAnnotation) => void
  /** 读当前静音状态（含 13 键） */
  getMuted: () => Readonly<Record<string, number>>
  /** 清空全部静音（确认调参后旧静音不适用） */
  clearMuted: () => void
}

/**
 * 注册 DMAE 调参观察者。返回退订函数。
 * 每次 config 事件：若 dmae 8 参数发生变化 -> 写 annotation（before/after/turn/source）+ 清静音。
 */
export function createDmaeConfigObserver(deps: DmaeConfigObserverDeps): () => void {
  let lastParams = deps.getInitialParams()
  let seq = 0

  return deps.subscribe((event) => {
    const next = snapshotFromDmaeConfig(event.config.memory.dmae)
    if (sameParams(lastParams, next)) return // 守卫：非调参事件 / 清静音写回 -> 忽略
    const before = lastParams
    lastParams = next

    deps.addAnnotation({
      id: `ann-${Date.now()}-${seq++}`,
      ts: Date.now(),
      turn: deps.getTurn(),
      before,
      after: next,
      source: 'manual'
    })

    const muted = deps.getMuted()
    if (Object.values(muted).some((v) => v > 0)) {
      deps.clearMuted()
    }
  })
}

function sameParams(a: DmaeParamsSnapshot, b: DmaeParamsSnapshot): boolean {
  return (
    a.maxScore === b.maxScore &&
    a.promptThreshold === b.promptThreshold &&
    a.userRewardBase === b.userRewardBase &&
    a.wakeGamma === b.wakeGamma &&
    a.modelRewardBase === b.modelRewardBase &&
    a.wakeLambda === b.wakeLambda &&
    a.decayAlpha === b.decayAlpha &&
    a.decayBeta === b.decayBeta
  )
}
