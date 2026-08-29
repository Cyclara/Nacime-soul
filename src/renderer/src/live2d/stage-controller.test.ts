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
}

function renderer(): FakeRenderer {
  const calls: string[] = []
  let failNextLoad = false
  const implementation: FakeRenderer = {
    calls,
    get failNextLoad() {
      return failNextLoad
    },
    set failNextLoad(value: boolean) {
      failNextLoad = value
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
    setFrameDriver(driver: Live2DFrameDriver | null) {
      void driver
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
    setMouthOpen() {
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
