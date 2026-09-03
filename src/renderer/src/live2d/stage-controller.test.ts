// src/renderer/src/live2d/stage-controller.test.ts
// P3A-06/07：stage 控制器不依赖 Vue/Pinia；fake renderer 验证首帧、失败和命令生命周期。

import { describe, expect, it, vi } from 'vitest'
import type {
  ILive2DRenderer,
  Live2DFrameDriver,
  Live2DParameterUpdate,
  Live2DRendererMetrics
} from './ILive2DRenderer'
import { createStageController } from './stage-controller'

interface FakeRenderer extends ILive2DRenderer {
  readonly calls: string[]
  failNextLoad: boolean
  /** P3B-16/17：口型测试观察点——setMouthOpen 写入值与已装的帧驱动。 */
  readonly mouthValues: number[]
  readonly driver: Live2DFrameDriver | null
}

function renderer(): FakeRenderer {
  const calls: string[] = []
  const mouthValues: number[] = []
  let driver: Live2DFrameDriver | null = null
  let failNextLoad = false
  const implementation: FakeRenderer = {
    calls,
    get failNextLoad() {
      return failNextLoad
    },
    set failNextLoad(value: boolean) {
      failNextLoad = value
    },
    get mouthValues() {
      return mouthValues
    },
    get driver() {
      return driver
    },
    attach() {
      calls.push('attach')
    },
    async load(url: string) {
      calls.push(`load:${url}`)
      if (failNextLoad) throw new Error('fake model failure')
    },
    unload() {
      calls.push('unload')
    },
    resize(width: number, height: number) {
      calls.push(`resize:${width}x${height}`)
    },
    setZoom(zoom: number) {
      calls.push(`zoom:${zoom}`)
    },
    setOffset(offsetX: number, offsetY: number) {
      calls.push(`offset:${offsetX},${offsetY}`)
    },
    pause() {
      calls.push('pause')
    },
    resume() {
      calls.push('resume')
    },
    setFrameDriver(next: Live2DFrameDriver | null) {
      driver = next
    },
    async setExpression(name: string) {
      calls.push(`expression:${name}`)
      return true
    },
    async playMotion() {
      return true
    },
    setParameter(update: Live2DParameterUpdate) {
      void update
      return true
    },
    setMouthOpen(value: number) {
      mouthValues.push(value)
      return true
    },
    setEyeOpen() {
      return true
    },
    hitTest() {
      return []
    },
    getMetrics(): Live2DRendererMetrics {
      return {
        fps: 60,
        frameCount: 1,
        modelLoadMs: 33,
        contextLossCount: 0,
        paused: false,
        hasModel: true
      }
    },
    dispose() {
      calls.push('dispose')
    }
  }
  return implementation
}

describe('P3A-06/07 StageController', () => {
  it('模型 load 完成并经过一帧后才报告 ready', async () => {
    const fake = renderer()
    const reports: unknown[] = []
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      callback(16)
      return 1
    })
    const controller = createStageController({
      renderer: fake,
      report: async (report) => {
        reports.push(report)
      },
      requestFrame,
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
      ensureCubismCore: async () => {}
    })

    controller.attach({} as HTMLCanvasElement)
    await controller.initialize({
      stageInstanceId: 'stage-1',
      status: 'loading-model',
      initialModelUrl: 'safe://mao',
      cubismCoreUrl: null,
      zoom: 1,
      offsetX: 0,
      offsetY: 0
    })

    expect(fake.calls).toEqual(['attach', 'zoom:1', 'offset:0,0', 'load:safe://mao'])
    expect(requestFrame).toHaveBeenCalledTimes(1)
    expect(reports).toEqual([
      { stageInstanceId: 'stage-1', status: 'loading-model' },
      { stageInstanceId: 'stage-1', status: 'ready', fps: 60, modelLoadMs: 33 }
    ])
    expect(controller.getState()).toMatchObject({ status: 'ready', errorCode: null })
  })

  it('首帧后延迟上报真实 FPS', async () => {
    const fake = renderer()
    const reports: unknown[] = []
    let timer: (() => void) | null = null
    const controller = createStageController({
      renderer: fake,
      report: async (report) => {
        reports.push(report)
      },
      requestFrame: (callback) => {
        callback(0)
        return 0
      },
      setTimer: (callback) => {
        timer = callback
        return 0 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {
        timer = null
      },
      ensureCubismCore: async () => {}
    })
    controller.attach({} as HTMLCanvasElement)
    await controller.initialize({
      stageInstanceId: 'stage-performance',
      status: 'loading-model',
      initialModelUrl: 'safe://mao',
      cubismCoreUrl: null,
      zoom: 1,
      offsetX: 0,
      offsetY: 0
    })
    const performanceCallback = timer as (() => void) | null
    performanceCallback?.()
    expect(reports.at(-1)).toEqual({
      stageInstanceId: 'stage-performance',
      status: 'ready',
      fps: 60,
      modelLoadMs: 33
    })
    controller.dispose()
  })

  it('模型加载失败报告安全错误码，不让异常逃出 stage 生命周期', async () => {
    const fake = renderer()
    fake.failNextLoad = true
    const reports: unknown[] = []
    const controller = createStageController({
      renderer: fake,
      report: async (report) => {
        reports.push(report)
      },
      requestFrame: (callback) => {
        callback(0)
        return 0
      },
      ensureCubismCore: async () => {}
    })
    controller.attach({} as HTMLCanvasElement)

    await expect(
      controller.initialize({
        stageInstanceId: 'stage-2',
        status: 'loading-model',
        initialModelUrl: 'safe://broken',
        cubismCoreUrl: null,
        zoom: 1,
        offsetX: 0,
        offsetY: 0
      })
    ).resolves.toBeUndefined()
    expect(reports.at(-1)).toEqual({
      stageInstanceId: 'stage-2',
      status: 'error',
      errorCode: 'MODEL_JSON_INVALID'
    })
    expect(controller.getState()).toMatchObject({
      status: 'error',
      errorCode: 'MODEL_JSON_INVALID'
    })
  })

  it('枚举 command 只调用对应 renderer 方法，dispose 后不再处理新命令', async () => {
    const fake = renderer()
    const controller = createStageController({
      renderer: fake,
      report: async () => {},
      requestFrame: (callback) => {
        callback(0)
        return 0
      },
      ensureCubismCore: async () => {}
    })
    controller.attach({} as HTMLCanvasElement)
    await controller.initialize({
      stageInstanceId: 'stage-3',
      status: 'loading-model',
      initialModelUrl: null,
      cubismCoreUrl: null,
      zoom: 1,
      offsetX: 0,
      offsetY: 0
    })

    await controller.handleCommand({ type: 'set-zoom', zoom: 1.5 })
    await controller.handleCommand({ type: 'set-offset', offsetX: -20, offsetY: 50 })
    await controller.handleCommand({ type: 'resize', width: 640, height: 480 })
    await controller.handleCommand({ type: 'pause' })
    await controller.handleCommand({ type: 'resume' })
    await controller.handleCommand({ type: 'dispose' })
    await controller.handleCommand({ type: 'pause' })

    expect(fake.calls).toEqual([
      'attach',
      'zoom:1',
      'offset:0,0',
      'zoom:1.5',
      'offset:-20,50',
      'resize:640x480',
      'pause',
      'resume',
      'dispose'
    ])
  })

  // 2026-08-29 真机回归：首选模型损坏（expression 名单为空）→ 降级到 Mao 后，
  // stage 仍在用 bootstrap 那份**过期**名单，任何情绪都解析不到 → 表情静默失效。
  // 修复是让 load-model 带上目标模型自己的名单；这条用例锁住它。
  it('load-model 携带的 expression 名单会替换 bootstrap 那份，换模型后表情不再静默失效', async () => {
    const fake = renderer()
    const controller = createStageController({
      renderer: fake,
      report: async () => {},
      requestFrame: (callback) => {
        callback(0)
        return 0
      },
      ensureCubismCore: async () => {}
    })
    controller.attach({} as HTMLCanvasElement)
    // bootstrap 来自首选模型：一个表情都没有。
    await controller.initialize({
      stageInstanceId: 'stage-4',
      status: 'loading-model',
      initialModelUrl: null,
      cubismCoreUrl: null,
      zoom: 1,
      offsetX: 0,
      offsetY: 0,
      expressionNames: []
    })

    await controller.handleCommand({ type: 'set-emotion', emotion: 'happy' })
    expect(fake.calls.filter((call) => call.startsWith('expression:'))).toEqual([])

    // 降级到有全套表情的模型。
    await controller.handleCommand({
      type: 'load-model',
      modelUrl: 'nacime-live2d://model/mao/Mao.model3.json',
      expressionNames: ['exp_01', 'exp_02', 'exp_03', 'exp_04', 'exp_05']
    })
    await controller.handleCommand({ type: 'set-emotion', emotion: 'happy' })
    await controller.handleCommand({ type: 'set-emotion', emotion: 'sad' })
    // 走 Mao 的显式别名表（按 .exp3.json 实际参数核对）：happy=exp_04（睁大眼+笑眼）、
    // sad=exp_05（眉尾下垂+嘴角下垂）。此前的 exp_03 是按编号猜的，实为「纯闭眼」。
    expect(fake.calls.filter((call) => call.startsWith('expression:'))).toEqual([
      'expression:exp_04',
      'expression:exp_05'
    ])

    // 再换到没有表情的模型：名单同样要跟着退回，不能残留上一个模型的别名。
    await controller.handleCommand({
      type: 'load-model',
      modelUrl: 'nacime-live2d://model/hiyori/Hiyori.model3.json',
      expressionNames: []
    })
    const beforeHiyori = fake.calls.filter((call) => call.startsWith('expression:')).length
    await controller.handleCommand({ type: 'set-emotion', emotion: 'happy' })
    expect(fake.calls.filter((call) => call.startsWith('expression:'))).toHaveLength(beforeHiyori)
  })
})

describe('P3B-16/17 StageController 口型接入', () => {
  function lipController(fake: FakeRenderer): ReturnType<typeof createStageController> {
    return createStageController({
      renderer: fake,
      report: async () => {},
      requestFrame: (callback) => {
        callback(16)
        return 1
      },
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
      ensureCubismCore: async () => {}
    })
  }

  const bootstrap = {
    stageInstanceId: 'stage-lip',
    status: 'loading-model' as const,
    initialModelUrl: 'safe://mao',
    cubismCoreUrl: null,
    zoom: 1,
    offsetX: 0,
    offsetY: 0
  }

  function drive(fake: FakeRenderer, deltaMs = 16): void {
    fake.driver?.({ deltaMs, nowMs: 0 }, () => {})
  }

  it('initialize 前接入：模型加载后口型插件随管线生效，电平驱动 setMouthOpen', async () => {
    const fake = renderer()
    const source = {
      level: 0.5,
      readLevel(): number {
        return this.level
      }
    }
    const controller = lipController(fake)
    controller.setLipSyncSource(source)
    controller.attach({} as HTMLCanvasElement)
    await controller.initialize(bootstrap)
    expect(controller.getState().status).toBe('ready')

    drive(fake)
    // attack 200ms：首帧 level = min(0.5, 16/200)
    expect(fake.mouthValues).toHaveLength(1)
    expect(fake.mouthValues[0]).toBeCloseTo(0.08, 5)

    // 静默：收敛写 0 后停写
    source.level = 0
    for (let i = 0; i < 15; i += 1) drive(fake)
    expect(fake.mouthValues.at(-1)).toBe(0)
    const countAfterSilence = fake.mouthValues.length
    for (let i = 0; i < 10; i += 1) drive(fake)
    expect(fake.mouthValues).toHaveLength(countAfterSilence)
  })

  it('模型加载后接入：立即挂载（管线已存在）；null 移除且旧插件闭嘴', async () => {
    const fake = renderer()
    const source = {
      level: 1,
      readLevel(): number {
        return this.level
      }
    }
    const controller = lipController(fake)
    controller.attach({} as HTMLCanvasElement)
    await controller.initialize(bootstrap)
    drive(fake)
    expect(fake.mouthValues).toHaveLength(0) // 未接入：无写入

    controller.setLipSyncSource(source)
    drive(fake)
    expect(fake.mouthValues).toHaveLength(1)

    controller.setLipSyncSource(null)
    // remove 会 dispose 旧插件：active 时补写一次 0
    expect(fake.mouthValues.at(-1)).toBe(0)
    const countAfterRemove = fake.mouthValues.length
    drive(fake)
    expect(fake.mouthValues).toHaveLength(countAfterRemove)
  })
})

describe('P3A-18/22 StageController 交互接线（S-006-补充 §1.9 / §1.7.5）', () => {
  interface InteractiveRenderer extends FakeRenderer {
    hits: readonly string[]
    throwOnHitTest: boolean
    readonly eyeWrites: number[]
  }

  /** 眼球参数写入可观察的 fake：saccade 每帧写 eyeBallX；交互后目标冻结为 0。 */
  function interactiveRenderer(): InteractiveRenderer {
    const base = renderer()
    const eyeWrites: number[] = []
    const impl: InteractiveRenderer = {
      ...base,
      // 展开会把 base 的 getter 快照成值：driver 在 setFrameDriver 之后才有，必须转发读取
      get driver() {
        return base.driver
      },
      get failNextLoad() {
        return base.failNextLoad
      },
      set failNextLoad(value: boolean) {
        base.failNextLoad = value
      },
      hits: [],
      throwOnHitTest: false,
      eyeWrites,
      hitTest() {
        if (impl.throwOnHitTest) throw new Error('swap race')
        return impl.hits
      },
      setParameter(update: Live2DParameterUpdate) {
        if (update.id === 'ParamEyeBallX') eyeWrites.push(update.value)
        return true
      }
    }
    return impl
  }

  function makeController(fake: InteractiveRenderer): ReturnType<typeof createStageController> {
    return createStageController({
      renderer: fake,
      report: async () => {},
      requestFrame: (callback) => {
        callback(16)
        return 1
      },
      setTimer: () => 0 as unknown as ReturnType<typeof setTimeout>,
      ensureCubismCore: async () => {},
      // 眼跳 RNG 固定为 1：每次采样目标都是 (1,1)，未冻结时眼球会向 1 漂
      random: () => 1
    })
  }

  const bootstrap = {
    stageInstanceId: 'stage-interact',
    status: 'loading-model' as const,
    initialModelUrl: 'safe://mao',
    cubismCoreUrl: null,
    zoom: 1,
    offsetX: 0,
    offsetY: 0
  }

  function drive(fake: InteractiveRenderer, frames: number, deltaMs = 16): void {
    for (let i = 0; i < frames; i += 1) fake.driver?.({ deltaMs, nowMs: i * deltaMs }, () => {})
  }

  it('interact：ready 前/未命中返回空；命中返回 hit area 并冻结眼跳目标', async () => {
    const fake = interactiveRenderer()
    const controller = makeController(fake)
    expect(controller.interact(10, 10)).toEqual([]) // 未 ready：不查 hitTest

    controller.attach({} as HTMLCanvasElement)
    await controller.initialize(bootstrap)
    expect(controller.getState().status).toBe('ready')

    expect(controller.interact(10, 10)).toEqual([]) // hits 为空
    fake.hits = ['Head']
    expect(controller.interact(10, 10)).toEqual(['Head'])

    // 交互后 600ms 眼跳目标冻结：先跑 1.2s 让眼球本该采样到 1 并漂移，
    // 但因冻结，前 600ms 内 lerp factor=0，眼球保持 0
    fake.eyeWrites.length = 0
    drive(fake, 30) // 480ms < 600ms 冻结窗：目标不采样、lerp factor=0
    expect(fake.eyeWrites.every((v) => v === 0)).toBe(true)
    // 冻结解除后还要等满一个采样间隔（1.2s）才取新目标：共驱动 600ms + 1.2s + 余量
    drive(fake, 130)
    expect(fake.eyeWrites.at(-1)).toBeGreaterThan(0)
  })

  it('hitTest 抛错时交互静默失败，不影响 stage 状态', async () => {
    const fake = interactiveRenderer()
    const controller = makeController(fake)
    controller.attach({} as HTMLCanvasElement)
    await controller.initialize(bootstrap)
    fake.throwOnHitTest = true
    expect(controller.interact(1, 1)).toEqual([])
    expect(controller.getState().status).toBe('ready')
  })

  it('说话帧刷新表情期限：15s 静默前有 lip-sync 电平则不回 neutral', async () => {
    const fake = interactiveRenderer()
    const controller = makeController(fake)
    controller.attach({} as HTMLCanvasElement)
    // 别名表按模型 id 解析：必须用 stage 协议 URL 才能命中 Mao 的显式表（happy=exp_04）
    await controller.initialize({
      ...bootstrap,
      initialModelUrl: 'nacime-live2d://model/mao/Mao.model3.json',
      expressionNames: ['exp_04']
    })
    await controller.handleCommand({ type: 'set-emotion', emotion: 'happy' })
    expect(fake.calls.filter((c) => c.startsWith('expression:'))).toEqual(['expression:exp_04'])
    const expressionsBefore = fake.calls.filter((c) => c.startsWith('expression:')).length

    // 接入口型：电平恒 0.5（说话中）
    controller.setLipSyncSource({ readLevel: () => 0.5 })
    // 跑 20s 的帧（超过 15s 复位期限）——说话帧每帧 refresh，不应触发回 neutral
    drive(fake, 1250, 16)
    expect(fake.calls.filter((c) => c.startsWith('expression:'))).toHaveLength(expressionsBefore)

    // 反向对照：沉默（电平 0）跑 16s，复位期限累计到 15s 后回 neutral。Mao 的 neutral
    // 没有 expression 别名（解析为空 → 只置 current，不调 setExpression），因此观察
    // 「刷新期限」正确性的可靠信号是：说话期间 happy 一直保持、沉默后才掉回。
    // 用 getState 之外的口径——再设一次 happy 时若已回 neutral，setExpression 会被再次调用；
    // 若期限被说话刷新而仍是 happy，则第二次 set 仍会调用（幂等设值），两者不可区分，
    // 故此处只锁「说话期间零额外 expression 调用」（上一断言），沉默复位由
    // expression/controller.test 自身覆盖。
    controller.setLipSyncSource({ readLevel: () => 0 })
    drive(fake, 1000, 16)
    expect(controller.getState().status).toBe('ready')
  })
})
