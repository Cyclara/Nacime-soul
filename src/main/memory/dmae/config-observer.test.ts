// src/main/memory/dmae/config-observer.test.ts
// P1（2026-08-10 审计）：调参生命周期——config 保存后写 annotation + 清静音。
// 覆盖：参数变化写 annotation（before/after/turn）、非调参事件忽略、清静音写回不死循环。
import { describe, it, expect, vi } from 'vitest'
import { createDmaeConfigObserver, type DmaeConfigObserverDeps } from './config-observer'
import type { DmaeParamsSnapshot } from './history-types'

const PARAMS: DmaeParamsSnapshot = {
  maxScore: 100,
  promptThreshold: 30,
  userRewardBase: 20,
  wakeGamma: 0.5,
  modelRewardBase: 8,
  wakeLambda: 0.3,
  decayAlpha: 1.5,
  decayBeta: 0.3
}

interface ObserverTestHarness {
  addAnnotation: ReturnType<typeof vi.fn>
  clearMuted: ReturnType<typeof vi.fn>
  emit: (configMemoryDmae: Record<string, number>) => void
  setMuted: (v: number) => void
  deps: DmaeConfigObserverDeps
}

function makeDeps(): ObserverTestHarness {
  const addAnnotation = vi.fn()
  const clearMuted = vi.fn()
  let muted: Record<string, number> = {
    R01: 0,
    R02: 0,
    R03: 0,
    R04: 0,
    R05: 0,
    R06: 0,
    R07: 0,
    R08: 0,
    R09: 0,
    R10: 0,
    R11: 0,
    R12: 0,
    R13: 0
  }
  const turn = 7
  const listeners: Array<(e: { config: { memory: { dmae: Record<string, number> } } }) => void> = []
  const subscribe = vi.fn((fn) => {
    listeners.push(fn)
    return () => {
      const i = listeners.indexOf(fn)
      if (i >= 0) listeners.splice(i, 1)
    }
  })
  return {
    addAnnotation,
    clearMuted,
    emit(configMemoryDmae: Record<string, number>) {
      for (const fn of listeners) fn({ config: { memory: { dmae: configMemoryDmae } } } as never)
    },
    setMuted(v: number) {
      muted = { ...muted, R01: v }
    },
    deps: {
      getInitialParams: () => PARAMS,
      getTurn: () => turn,
      subscribe,
      addAnnotation,
      getMuted: () => muted,
      clearMuted
    }
  }
}

describe('P1: createDmaeConfigObserver 调参生命周期', () => {
  it('参数变化 -> 写 annotation（before/after/turn/source=manual）', () => {
    const { deps, emit, addAnnotation } = makeDeps()
    const unsubscribe = createDmaeConfigObserver(deps)

    const changed = { ...PARAMS, decayAlpha: 0.8 }
    emit(changed as never)

    expect(addAnnotation).toHaveBeenCalledTimes(1)
    const ann = addAnnotation.mock.calls[0][0]
    expect(ann.before).toEqual(PARAMS)
    expect(ann.after).toEqual(changed)
    expect(ann.turn).toBe(7)
    expect(ann.source).toBe('manual')
    unsubscribe()
  })

  it('非调参事件（params 未变）-> 不写 annotation（守卫）', () => {
    const { deps, emit, addAnnotation } = makeDeps()
    createDmaeConfigObserver(deps)
    emit({ ...PARAMS } as never) // 相同参数
    emit({ ...PARAMS, maxScore: 100 } as never) // 仍相同
    expect(addAnnotation).not.toHaveBeenCalled()
  })

  it('有静音时调参 -> 清静音一次', () => {
    const { deps, emit, setMuted, clearMuted } = makeDeps()
    setMuted(Date.now() + 3600_000) // R01 静音中
    createDmaeConfigObserver(deps)
    emit({ ...PARAMS, wakeGamma: 0.7 } as never)
    expect(clearMuted).toHaveBeenCalledTimes(1)
  })

  it('无静音时调参 -> 不清静音', () => {
    const { deps, emit, clearMuted } = makeDeps()
    createDmaeConfigObserver(deps)
    emit({ ...PARAMS, wakeGamma: 0.7 } as never)
    expect(clearMuted).not.toHaveBeenCalled()
  })

  it('多次调参 -> 每次写一条 annotation，before 是上一次的 after', () => {
    const { deps, emit, addAnnotation } = makeDeps()
    createDmaeConfigObserver(deps)
    emit({ ...PARAMS, decayAlpha: 0.8 } as never)
    emit({ ...PARAMS, decayAlpha: 0.5 } as never)
    expect(addAnnotation).toHaveBeenCalledTimes(2)
    expect(addAnnotation.mock.calls[1][0].before.decayAlpha).toBe(0.8) // 上一次的 after
    expect(addAnnotation.mock.calls[1][0].after.decayAlpha).toBe(0.5)
  })
})
