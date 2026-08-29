// src/renderer/src/live2d/motion/pipeline.test.ts
// P3A-16：插件排序、四阶段顺序、handled 短路、异常 fail-open。

import { describe, expect, it, vi } from 'vitest'
import { createMotionPipeline, type MotionPlugin } from './pipeline'

function plugin(id: string, priority: number, phases: MotionPlugin['phases'], log: string[], action?: MotionPlugin['onFrame']): MotionPlugin {
  return { id, priority, phases, onFrame: action ?? ((ctx) => log.push(`${id}:${ctx.phase}`)) }
}

describe('P3A-16 MotionPipeline', () => {
  it('按 priority/id 稳定排序，执行 pre → native → post → final', () => {
    const log: string[] = []
    const pipeline = createMotionPipeline()
    pipeline.add(plugin('z', 2, ['final'], log))
    pipeline.add(plugin('a', 1, ['pre'], log))
    pipeline.add(plugin('b', 1, ['post'], log))
    pipeline.run({ deltaMs: 16, nowMs: 16 }, () => log.push('native'))
    expect(log).toEqual(['a:pre', 'native', 'b:post', 'z:final'])
    expect(pipeline.pluginIds).toEqual(['a', 'b', 'z'])
  })

  it('handled 只短路当前阶段后续插件，不跳过 native/post/final', () => {
    const log: string[] = []
    const pipeline = createMotionPipeline()
    pipeline.add(plugin('first', 1, ['pre'], log, (ctx) => { log.push('first:pre'); ctx.markHandled() }))
    pipeline.add(plugin('second', 2, ['pre'], log))
    pipeline.add(plugin('post', 3, ['post'], log))
    pipeline.run({ deltaMs: 16, nowMs: 16 }, () => log.push('native'))
    expect(log).toEqual(['first:pre', 'native', 'post:post'])
  })

  it('插件抛错不停止 ticker，记录错误后继续其他阶段', () => {
    const errors: string[] = []
    const log: string[] = []
    const pipeline = createMotionPipeline({ onPluginError: (id) => errors.push(id) })
    pipeline.add(plugin('bad', 1, ['pre'], log, () => { throw new Error('bad') }))
    pipeline.add(plugin('good', 2, ['pre'], log))
    pipeline.run({ deltaMs: 16, nowMs: 16 }, () => log.push('native'))
    expect(errors).toEqual(['bad'])
    expect(log).toEqual(['good:pre', 'native'])
  })

  it('remove/dispose 释放插件且操作幂等', () => {
    const dispose = vi.fn()
    const pipeline = createMotionPipeline()
    pipeline.add({ id: 'x', priority: 1, phases: [], onFrame: () => {}, dispose })
    expect(pipeline.remove('missing')).toBe(false)
    expect(pipeline.remove('x')).toBe(true)
    expect(pipeline.remove('x')).toBe(false)
    pipeline.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
