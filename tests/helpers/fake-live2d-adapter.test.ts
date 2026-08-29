// tests/helpers/fake-live2d-adapter.test.ts
// P3-00C 自测：假 Live2D adapter 自身行为正确，后续 Live2D 任务可直接信任它。

import { describe, it, expect } from 'vitest'
import { createFakeLive2DAdapter } from './fake-live2d-adapter'

describe('fake-live2d-adapter 自测', () => {
  it('loadModel → 参数读写 → expression/motion → update → destroy 全流程记日志', async () => {
    const adapter = createFakeLive2DAdapter()
    const model = await adapter.loadModel('/models/fake/fake.model3.json')

    model.setParameter('ParamEyeLOpen', 0.8)
    expect(model.getParameter('ParamEyeLOpen')).toBe(0.8)
    expect(model.hasParameter('ParamEyeLOpen')).toBe(true)
    expect(model.getParameter('ParamMouthOpenY')).toBe(0) // 未设置参数读 0

    expect(model.expression('smile')).toBe(true)
    expect(model.motion('Idle', 0)).toBe(true)
    model.update(16.7)
    model.update(16.7)
    expect(model.updateCount).toBe(2)
    expect(adapter.liveModelCount).toBe(1)

    model.destroy()
    expect(model.destroyed).toBe(true)
    expect(adapter.liveModelCount).toBe(0)
    // 幂等：重复 destroy 不再记日志
    const callsBefore = adapter.calls.length
    model.destroy()
    expect(adapter.calls.length).toBe(callsBefore)

    const methods = adapter.calls.map((c) => c.method)
    expect(methods[0]).toBe('load')
    expect(methods).toContain('setParameter')
    expect(methods).toContain('expression')
    expect(methods).toContain('motion')
    expect(methods).toContain('update')
    expect(methods[methodOrderLastIndex(methods)]).toBe('destroy')
  })

  it('failNextLoads 注入失败：失败 N 次后恢复成功', async () => {
    const adapter = createFakeLive2DAdapter()
    adapter.failNextLoads(2, new Error('network down'))

    await expect(adapter.loadModel('/a')).rejects.toThrow('network down')
    await expect(adapter.loadModel('/a')).rejects.toThrow('network down')
    await expect(adapter.loadModel('/a')).resolves.toBeDefined()
    expect(adapter.liveModelCount).toBe(1)
  })

  it('createApplication：ticker 手动驱动帧；destroy 后 ticker/listener 归零', () => {
    const adapter = createFakeLive2DAdapter()
    const app = adapter.createApplication({ width: 300, height: 400 })
    expect(adapter.liveApplicationCount).toBe(1)

    let ticks = 0
    const onTick = (): void => {
      ticks++
    }
    app.ticker.add(onTick)
    app.ticker.start()
    app.ticker.tick(16.7)
    app.ticker.tick(16.7)
    expect(ticks).toBe(2)

    // 未 start 不驱动
    app.ticker.stop()
    app.ticker.tick(16.7)
    expect(ticks).toBe(2)

    app.resize(500, 600)
    expect(app.width).toBe(500)
    expect(app.height).toBe(600)

    app.destroy()
    expect(app.destroyed).toBe(true)
    expect(app.ticker.destroyed).toBe(true)
    expect(app.ticker.listenerCount).toBe(0)
    expect(adapter.liveApplicationCount).toBe(0)
  })
})

function methodOrderLastIndex(methods: string[]): number {
  return methods.length - 1
}
