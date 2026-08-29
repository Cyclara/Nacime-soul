// @vitest-environment jsdom
// src/renderer/src/live2d/PixiLive2DRenderer.test.ts
// P3A-02/03：接口只暴露业务能力；Pixi adapter 注入替身，测试不加载 WebGL/Cubism。

import { describe, expect, it } from 'vitest'
import {
  PixiLive2DRenderer,
  disableForkAutoEyeBlink,
  type PixiLive2DAdapter,
  type PixiLive2DApplicationHandle,
  type PixiLive2DModelHandle
} from './PixiLive2DRenderer'
import type { Live2DFrameDriver, Live2DRendererFrame } from './ILive2DRenderer'

describe('fork 内置自动眨眼必须关闭', () => {
  // fork 的 Cubism4InternalModel.update() 顺序是 motion → expression → eyeBlink，
  // 内置眨眼排在表情之后且**绝对写** ParamEyeLOpen/ROpen，会把表情的 Multiply 眼部通道
  // 整帧抹掉（2026-08-29 真机确认：Mao 的 exp_02 闭眼笑完全不可见）。
  // 何况本项目自带 P3A-17 眨眼状态机，留着内置的等于两套眨眼抢同一对参数。
  it('清空 internalModel.eyeBlink，且对缺字段的模型不抛错', () => {
    const model = { internalModel: { eyeBlink: { updateParameters: () => {} } } }
    disableForkAutoEyeBlink(model)
    expect(model.internalModel.eyeBlink).toBeUndefined()

    expect(() => disableForkAutoEyeBlink({})).not.toThrow()
    expect(() => disableForkAutoEyeBlink({ internalModel: undefined })).not.toThrow()
  })
})

/**
 * 替身模型复刻渲染库的两个关键行为，否则测试会漏掉整类失败：
 * ①`update(dt)` 只累加计时器；②真正的求值发生在渲染阶段，帧插件钩子在**原生 motion 求值处**
 * 被调用。`drive()` 就是模拟渲染阶段那一次内部求值。
 */
interface FakeModelHandle extends PixiLive2DModelHandle {
  /** 模拟渲染阶段的一次内部求值：把累计的计时器换算成 (deltaMs, nowMs) 并调用钩子。 */
  drive(): void
  readonly accumulatedMs: number
  readonly nativeMotionUpdates: number
  readonly hookInstalled: boolean
}

interface AdapterHarness {
  readonly adapter: PixiLive2DAdapter
  readonly app: PixiLive2DApplicationHandle
  readonly state: {
    started: boolean
    destroyed: boolean
    listener: ((deltaMs: number) => void) | null
    appDestroyCount: number
    renderCount: number
    modelDestroyCount: number
    loads: string[]
    expressions: string[]
    motions: Array<{ group: string; index: number | undefined }>
    parameters: Array<{ id: string; value: number; weight: number | undefined }>
    layouts: Array<{ width: number; height: number; zoom: number; offsetX: number; offsetY: number }>
    stageModels: PixiLive2DModelHandle[]
    models: FakeModelHandle[]
    context: 'ok' | 'throw-on-add' | 'throw-on-render'
  }
}

function createHarness(): AdapterHarness {
  const state: AdapterHarness['state'] = {
    started: false,
    destroyed: false,
    listener: null,
    appDestroyCount: 0,
    renderCount: 0,
    modelDestroyCount: 0,
    loads: [],
    expressions: [],
    motions: [],
    parameters: [],
    layouts: [],
    stageModels: [],
    models: [],
    context: 'ok'
  }
  const createModel = (): FakeModelHandle => {
    let hook: Live2DFrameDriver | null = null
    let pendingMs = 0
    let elapsedMs = 0
    let nativeMotionUpdates = 0
    let lastNowMs: number | null = null

    return {
      setParameter(id, value, weight) {
        state.parameters.push({ id, value, weight })
      },
      hasParameter(id) {
        return id === 'ParamMouthOpenY' || id === 'ParamEyeLOpen'
      },
      async expression(name) {
        state.expressions.push(name)
        return name !== 'missing'
      },
      async motion(group, index) {
        state.motions.push({ group, index })
        return group !== 'missing'
      },
      update(deltaMs) {
        pendingMs += deltaMs
        elapsedMs += deltaMs
      },
      setFrameHook(next) {
        hook = next
      },
      drive() {
        if (pendingMs === 0) return
        pendingMs = 0
        const nowMs = elapsedMs
        const deltaMs = lastNowMs === null ? 0 : Math.max(0, nowMs - lastNowMs)
        lastNowMs = nowMs
        const runNative = (): void => {
          nativeMotionUpdates++
        }
        if (hook === null) {
          runNative()
          return
        }
        // 与生产 seam 同构：钩子异常不得逃逸进渲染循环，native 求值仍必须发生。
        try {
          hook({ deltaMs, nowMs }, runNative)
        } catch {
          runNative()
        }
      },
      get accumulatedMs() {
        return elapsedMs
      },
      get nativeMotionUpdates() {
        return nativeMotionUpdates
      },
      get hookInstalled() {
        return hook !== null
      },
      resizeToFit(width, height, layout) {
        state.layouts.push({ width, height, ...layout })
      },
      hitTest(x, y) {
        return x === 4 && y === 8 ? ['Head'] : []
      },
      destroy() {
        state.modelDestroyCount++
      }
    }
  }
  const app: PixiLive2DApplicationHandle = {
    ticker: {
      add(listener) {
        state.listener = listener
      },
      remove(listener) {
        if (state.listener === listener) state.listener = null
      },
      start() {
        state.started = true
      },
      stop() {
        state.started = false
      }
    },
    stage: {
      addChild(candidate) {
        if (state.context === 'throw-on-add') throw new Error('context lost')
        state.stageModels.push(candidate)
      },
      removeChild(candidate) {
        const index = state.stageModels.indexOf(candidate)
        if (index >= 0) state.stageModels.splice(index, 1)
      }
    },
    resize() {
      // no-op
    },
    render() {
      if (state.context === 'throw-on-render') throw new Error('first frame failed')
      state.renderCount++
      // 渲染阶段才触发模型内部求值——帧插件正是挂在那里面。
      for (const model of state.stageModels) (model as FakeModelHandle).drive()
    },
    destroy() {
      state.destroyed = true
      state.appDestroyCount++
    }
  }
  const adapter: PixiLive2DAdapter = {
    createApplication() {
      return app
    },
    async loadModel(manifestUrl) {
      state.loads.push(manifestUrl)
      if (manifestUrl === 'bad') throw new Error('load failed')
      const model = createModel()
      state.models.push(model)
      return model
    }
  }
  return { adapter, app, state }
}

function canvas(): HTMLCanvasElement {
  return document.createElement('canvas')
}

describe('P3A-02/03 PixiLive2DRenderer', () => {
  it('业务抽象不泄漏 Pixi：挂载、加载、参数、motion 和 hitTest 均走注入 adapter', async () => {
    const harness = createHarness()
    const renderer = new PixiLive2DRenderer({ adapterFactory: () => harness.adapter, now: () => 100 })
    renderer.attach(canvas())
    await renderer.load('model.model3.json')

    expect(harness.state.loads).toEqual(['model.model3.json'])
    expect(renderer.getMetrics()).toMatchObject({ hasModel: true, paused: false, modelLoadMs: 0 })
    expect(await renderer.setExpression('smile')).toBe(true)
    expect(await renderer.playMotion('Idle', 1)).toBe(true)
    expect(renderer.setMouthOpen(4)).toBe(true)
    expect(renderer.setEyeOpen(-3)).toBe(true)
    expect(renderer.hitTest(4, 8)).toEqual(['Head'])
    expect(harness.state.parameters).toEqual([
      { id: 'ParamMouthOpenY', value: 1, weight: undefined },
      { id: 'ParamEyeLOpen', value: 0, weight: undefined }
    ])
    expect(harness.state.expressions).toEqual(['smile'])
    expect(harness.state.motions).toEqual([{ group: 'Idle', index: 1 }])
  })

  it('角色缩放按 0.25..3 钳位，并在 resize 时保持当前 zoom', async () => {
    const harness = createHarness()
    const renderer = new PixiLive2DRenderer({ adapterFactory: () => harness.adapter })
    renderer.attach(canvas())
    renderer.setZoom(2)
    await renderer.load('stable')
    renderer.setZoom(9)
    renderer.resize(640, 480)

    expect(harness.state.layouts).toEqual([
      { width: 300, height: 150, zoom: 2, offsetX: 0, offsetY: 0 },
      { width: 300, height: 150, zoom: 3, offsetX: 0, offsetY: 0 },
      { width: 640, height: 480, zoom: 3, offsetX: 0, offsetY: 0 }
    ])
  })

  it('取景偏移按 -100..100 钳位，与 zoom 相互独立且在 resize 后保持', async () => {
    const harness = createHarness()
    const renderer = new PixiLive2DRenderer({ adapterFactory: () => harness.adapter })
    renderer.attach(canvas())
    await renderer.load('stable')
    renderer.setOffset(-140, 50)
    renderer.setZoom(0.5)
    renderer.resize(640, 480)

    expect(harness.state.layouts.slice(1)).toEqual([
      { width: 300, height: 150, zoom: 1, offsetX: -100, offsetY: 50 },
      { width: 300, height: 150, zoom: 0.5, offsetX: -100, offsetY: 50 },
      { width: 640, height: 480, zoom: 0.5, offsetX: -100, offsetY: 50 }
    ])
  })

  it('候选模型加载/挂载失败不销毁旧模型；候选自行释放', async () => {
    const harness = createHarness()
    const renderer = new PixiLive2DRenderer({ adapterFactory: () => harness.adapter })
    renderer.attach(canvas())
    await renderer.load('stable')
    const stable = harness.state.stageModels[0]
    harness.state.context = 'throw-on-add'

    await expect(renderer.load('candidate')).rejects.toThrow('context lost')
    expect(renderer.getMetrics().hasModel).toBe(true)
    expect(harness.state.modelDestroyCount).toBe(1)
    expect(harness.state.stageModels).toEqual([stable])
  })

  it('候选首帧 render 失败时移除候选并保留旧模型', async () => {
    const harness = createHarness()
    const renderer = new PixiLive2DRenderer({ adapterFactory: () => harness.adapter })
    renderer.attach(canvas())
    await renderer.load('stable')
    const stable = harness.state.stageModels[0]
    harness.state.context = 'throw-on-render'

    await expect(renderer.load('candidate')).rejects.toThrow('first frame failed')
    expect(renderer.getMetrics().hasModel).toBe(true)
    expect(harness.state.modelDestroyCount).toBe(1)
    expect(harness.state.stageModels).toEqual([stable])
  })

  it('候选模型先预热并通过同步首帧 render，成功后才替换旧模型', async () => {
    const harness = createHarness()
    const renderer = new PixiLive2DRenderer({ adapterFactory: () => harness.adapter })
    renderer.attach(canvas())
    await renderer.load('stable')
    const stable = harness.state.stageModels[0]

    expect(harness.state.renderCount).toBe(1)
    expect(harness.state.parameters).toEqual([])
    await renderer.load('candidate')
    expect(harness.state.renderCount).toBe(2)
    expect(harness.state.modelDestroyCount).toBe(1)
    expect(harness.state.stageModels).toHaveLength(1)
    expect(harness.state.stageModels[0]).not.toBe(stable)
  })

  it('pause/resume 与 dispose 释放 ticker/listener/model/application，且重复 dispose 幂等', async () => {
    const harness = createHarness()
    let clock = 0
    const renderer = new PixiLive2DRenderer({
      adapterFactory: () => harness.adapter,
      now: () => clock
    })
    renderer.attach(canvas())
    await renderer.load('stable')

    renderer.pause()
    expect(harness.state.started).toBe(false)
    renderer.resume()
    expect(harness.state.started).toBe(true)
    expect(harness.state.renderCount).toBe(2)
    clock = 1_100
    harness.state.listener?.(16)
    expect(renderer.getMetrics().frameCount).toBe(1)

    renderer.dispose()
    renderer.dispose()
    expect(harness.state.listener).toBeNull()
    expect(harness.state.appDestroyCount).toBe(1)
    expect(harness.state.modelDestroyCount).toBe(1)
    expect(harness.state.destroyed).toBe(true)
    expect(() => renderer.resize(10, 10)).toThrow('disposed')
  })

  it('可见性由 stage controller 显式暂停和恢复，renderer 不读取初始隐藏窗口的 DOM 可见性', async () => {
    const harness = createHarness()
    const renderer = new PixiLive2DRenderer({ adapterFactory: () => harness.adapter })
    renderer.attach(canvas())
    await renderer.load('stable')

    renderer.pause()
    expect(renderer.getMetrics().paused).toBe(true)
    renderer.resume()
    expect(renderer.getMetrics().paused).toBe(false)
    expect(harness.state.renderCount).toBe(2)
    renderer.resume()
    expect(harness.state.renderCount).toBe(3)
  })

  it('context loss prevents default, pauses rendering, then resumes on restoration', async () => {
    const harness = createHarness()
    const element = canvas()
    const renderer = new PixiLive2DRenderer({ adapterFactory: () => harness.adapter })
    renderer.attach(element)
    await renderer.load('stable')
    const event = new Event('webglcontextlost', { cancelable: true })
    element.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(renderer.getMetrics()).toMatchObject({ paused: true, contextLossCount: 1 })
    element.dispatchEvent(new Event('webglcontextrestored'))
    expect(renderer.getMetrics().paused).toBe(false)
  })
})

/**
 * 帧插件的位置本身就是一条契约。此前管线跑在 ticker 上，而渲染库的 `update(dt)` 只累加计时器，
 * 于是 `post/final` 实际排在 native 求值**之前**——名字与行为相反，直接导致过两个真机 bug
 * （眨眼乘性写入复利成永久闭眼；表情被内置眨眼覆盖）。以下用例把新位置钉死。
 */
describe('P3A-16 帧插件跑在 native motion 求值处', () => {
  it('ticker 只推进计时器，插件由模型内部求值触发，且 pre/native/post 顺序正确', async () => {
    const harness = createHarness()
    let clock = 0
    const renderer = new PixiLive2DRenderer({ adapterFactory: () => harness.adapter, now: () => clock })
    renderer.attach(canvas())
    await renderer.load('stable')
    const model = harness.state.models[0]!
    expect(model.hookInstalled).toBe(true)

    const log: string[] = []
    const frames: Live2DRendererFrame[] = []
    const driver: Live2DFrameDriver = (frame, nativeUpdate) => {
      frames.push(frame)
      log.push('pre')
      nativeUpdate()
      log.push('post')
    }
    renderer.setFrameDriver(driver)

    // ticker 帧：只累加计时器，一个插件都不许跑。
    clock = 16
    harness.state.listener?.(16)
    expect(log).toEqual([])
    expect(model.accumulatedMs).toBe(16 + 1_000 / 60)

    // 渲染阶段：内部求值触发钩子。
    harness.app.render()
    expect(log).toEqual(['pre', 'post'])
    expect(model.nativeMotionUpdates).toBe(2)
    // deltaMs 取模型自己的动画时钟，而不是墙钟。
    expect(frames[0]?.deltaMs).toBeCloseTo(16, 6)
    expect(frames[0]?.nowMs).toBeCloseTo(16 + 1_000 / 60, 6)
  })

  it('driver 抛错时 native motion 求值仍恰好执行一次（P3A-16 不得跳过 native）', async () => {
    const harness = createHarness()
    const renderer = new PixiLive2DRenderer({ adapterFactory: () => harness.adapter })
    renderer.attach(canvas())
    await renderer.load('stable')
    const model = harness.state.models[0]!
    const baseline = model.nativeMotionUpdates

    // 情形一：native 之前抛错 —— 必须补跑。
    renderer.setFrameDriver(() => {
      throw new Error('plugin exploded')
    })
    harness.state.listener?.(16)
    harness.app.render()
    expect(model.nativeMotionUpdates).toBe(baseline + 1)

    // 情形二：native 之后抛错 —— 不许重复跑（旧实现的 `catch { nativeUpdate() }` 会跑两次）。
    renderer.setFrameDriver((_frame, nativeUpdate) => {
      nativeUpdate()
      throw new Error('post plugin exploded')
    })
    harness.state.listener?.(16)
    harness.app.render()
    expect(model.nativeMotionUpdates).toBe(baseline + 2)
  })

  it('切模型后旧模型的钩子被摘掉，插件只驱动当前模型', async () => {
    const harness = createHarness()
    const renderer = new PixiLive2DRenderer({ adapterFactory: () => harness.adapter })
    renderer.attach(canvas())
    await renderer.load('stable')
    await renderer.load('next')

    const previous = harness.state.models[0]!
    const current = harness.state.models[1]!
    expect(previous.hookInstalled).toBe(false)
    expect(current.hookInstalled).toBe(true)

    const frames: Live2DRendererFrame[] = []
    renderer.setFrameDriver((frame, nativeUpdate) => {
      frames.push(frame)
      nativeUpdate()
    })
    harness.state.listener?.(16)
    harness.app.render()
    expect(frames).toHaveLength(1)
  })

  it('unload 与 dispose 摘掉钩子，销毁后的模型不再驱动插件', async () => {
    const harness = createHarness()
    const renderer = new PixiLive2DRenderer({ adapterFactory: () => harness.adapter })
    renderer.attach(canvas())
    await renderer.load('stable')
    const model = harness.state.models[0]!

    let calls = 0
    renderer.setFrameDriver((_frame, nativeUpdate) => {
      calls++
      nativeUpdate()
    })
    renderer.unload()
    expect(model.hookInstalled).toBe(false)

    model.update(16)
    model.drive()
    expect(calls).toBe(0)
  })
})
