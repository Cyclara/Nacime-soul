// src/renderer/src/live2d/stage-controller.ts
// P3A-06/07：独立 stage renderer 的运行时编排器。
//
// 不进 Pinia：它持有 canvas、Pixi/Live2D 对象和生命周期。对外只有元数据状态与固定
// stage report；模型 URL 由 main 安全地给出，renderer 从不解析用户文件路径。

import type { ILive2DRenderer } from './ILive2DRenderer'
import { ensureCubism2, ensureCubismCore } from './cubism-core-loader'
import { createMotionPipeline } from './motion/pipeline'
import { createBlinkPlugin } from './motion/blink'
import { createSaccadePlugin } from './motion/saccade'
import { createBreathPlugin } from './motion/breath'
import { createExpressionController, type ExpressionController } from './expression/controller'
import { aliasesForModel, modelIdFromStageUrl } from './expression/map'
import type {
  Live2dStageBootstrap,
  Live2dStageCommand,
  Live2dStageReport,
  Live2dStageStatus
} from '@shared/live2d/stage-types'

export interface Live2dStageControllerState {
  readonly stageInstanceId: string | null
  readonly status: Live2dStageStatus
  readonly errorCode: string | null
}

export interface StageControllerDeps {
  readonly renderer: ILive2DRenderer
  readonly report: (report: Live2dStageReport) => Promise<unknown>
  readonly requestFrame?: (callback: FrameRequestCallback) => number
  /** P3A-28：首帧后再采一次真实 FPS；测试可注入不调度的 timer。 */
  readonly setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
  readonly ensureCubismCore?: (url: string | null) => Promise<void>
  readonly ensureCubism2?: (url: string | null) => Promise<void>
  readonly random?: () => number
  readonly reduceMotion?: () => boolean
  readonly onStateChange?: (state: Live2dStageControllerState) => void
}

export interface StageController {
  attach(canvas: HTMLCanvasElement): void
  initialize(bootstrap: Live2dStageBootstrap): Promise<void>
  handleCommand(command: Live2dStageCommand): Promise<void>
  resize(width: number, height: number): void
  retry(): Promise<void>
  getState(): Live2dStageControllerState
  dispose(): void
}

export function createStageController(deps: StageControllerDeps): StageController {
  const requestFrame = deps.requestFrame ?? window.requestAnimationFrame.bind(window)
  const setTimer = deps.setTimer ?? setTimeout
  const clearTimer = deps.clearTimer ?? clearTimeout
  const loadCubismCore = deps.ensureCubismCore ?? ensureCubismCore
  const loadCubism2 = deps.ensureCubism2 ?? ensureCubism2
  let coreReady = false
  let cubism2Ready = false
  let firstLoad = true
  let stageInstanceId: string | null = null
  let status: Live2dStageStatus = 'starting'
  let motionPipeline: ReturnType<typeof createMotionPipeline> | null = null
  let expressionController: ExpressionController | null = null
  let errorCode: string | null = null
  let lastModelUrl: string | null = null
  let expressionNames: readonly string[] = []
  let attachFailed = false
  let performanceTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const snapshot = (): Live2dStageControllerState => ({ stageInstanceId, status, errorCode })
  const publishState = (): void => deps.onStateChange?.(snapshot())

  const report = async (nextStatus: Live2dStageStatus, nextErrorCode?: string): Promise<void> => {
    if (stageInstanceId === null) return
    status = nextStatus
    errorCode = nextErrorCode ?? null
    publishState()
    const metrics = deps.renderer.getMetrics()
    try {
      await deps.report({
        stageInstanceId,
        status,
        ...(status === 'ready'
          ? {
              fps: metrics.fps,
              ...(metrics.modelLoadMs === null ? {} : { modelLoadMs: metrics.modelLoadMs })
            }
          : {}),
        ...(nextErrorCode === undefined ? {} : { errorCode: nextErrorCode })
      })
    } catch {
      // 状态回报失败只影响 Live2D 投影；不能让 stage 挂起或影响 chat。
    }
  }

  const waitForFrame = (): Promise<void> =>
    new Promise((resolve) => {
      requestFrame(() => resolve())
    })

  const attachMotionPlugins = (): void => {
    motionPipeline?.dispose()
    const random = deps.random
    const pluginPipeline = createMotionPipeline()
    pluginPipeline.add(
      createBlinkPlugin({
        renderer: deps.renderer,
        ...(random === undefined ? {} : { random }),
        ...(deps.reduceMotion === undefined ? {} : { reduceMotion: deps.reduceMotion })
      })
    )
    pluginPipeline.add(
      createSaccadePlugin({ renderer: deps.renderer, ...(random === undefined ? {} : { random }) })
    )
    pluginPipeline.add(createBreathPlugin({ renderer: deps.renderer }))
    motionPipeline = pluginPipeline
    deps.renderer.setFrameDriver((frame, nativeUpdate) => pluginPipeline.run(frame, nativeUpdate))
  }

  const loadErrorCode = (error: unknown): string => {
    const message = error instanceof Error ? error.message.toLowerCase() : ''
    if (message.includes('fetch') || message.includes('404') || message.includes('not found'))
      return 'FILE_NOT_FOUND'
    if (message.includes('texture') && message.includes('upload')) return 'TEXTURE_UPLOAD_FAILED'
    if (message.includes('texture')) return 'TEXTURE_TOO_LARGE'
    if (message.includes('webgl') || message.includes('context')) return 'WEBGL_UNSUPPORTED'
    return 'MODEL_JSON_INVALID'
  }

  const load = async (modelUrl: string): Promise<void> => {
    if (disposed || stageInstanceId === null) return
    if (performanceTimer !== null) {
      clearTimer(performanceTimer)
      performanceTimer = null
    }
    lastModelUrl = modelUrl
    await report('loading-model')
    try {
      await deps.renderer.load(modelUrl)
      attachMotionPlugins()
      firstLoad = false
      expressionController?.dispose()
      expressionController = createExpressionController({
        renderer: deps.renderer,
        expressionNames,
        // 内置模型的 expression 编号与情绪没有约定关系，必须按模型走显式表（见 map.ts）。
        aliases: aliasesForModel(modelIdFromStageUrl(modelUrl)),
        onUnresolved: (emotion, available) => {
          console.warn(
            `[live2d] emotion "${emotion}" has no expression on this model; falling back to neutral. available=${available.length}`
          )
        }
      })
      motionPipeline?.add({
        id: 'expression-controller',
        priority: 130,
        phases: ['final'],
        onFrame: (context) =>
          expressionController?.update(context.frame.deltaMs, context.frame.nowMs)
      })
      // P3A-07：至少让一个 rAF/ticker 帧发生后才承认 ready，避免透明空窗提前 show。
      await waitForFrame()
      if (!disposed) {
        await report('ready')
        // P3A-28：fps 需要观察窗，首帧 ready 后延迟一次真实采样再投影；不伪造 0。
        if (performanceTimer !== null) clearTimer(performanceTimer)
        performanceTimer = setTimer(() => {
          performanceTimer = null
          if (!disposed && status === 'ready') void report('ready')
        }, 1_100)
      }
    } catch (error) {
      if (
        !firstLoad &&
        error instanceof Error &&
        error.message === 'Live2D renderer is not attached'
      ) {
        return
      }
      const code = loadErrorCode(error)
      // Only the fixed code crosses the stage report boundary; loader details stay local.
      if (!disposed) await report('error', code)
    }
  }

  return {
    attach(canvas) {
      if (disposed) return
      try {
        deps.renderer.attach(canvas)
        attachFailed = false
      } catch {
        // WebGL allocation failures are reported only as the fixed public code below.
        attachFailed = true
      }
    },

    async initialize(bootstrap) {
      if (disposed) return
      motionPipeline?.dispose()
      motionPipeline = null
      expressionController?.dispose()
      expressionController = null
      stageInstanceId = bootstrap.stageInstanceId
      expressionNames = bootstrap.expressionNames ?? []
      status = bootstrap.status
      if (attachFailed) {
        await report('error', 'WEBGL_UNSUPPORTED')
        return
      }
      deps.renderer.setZoom(bootstrap.zoom)
      deps.renderer.setOffset(bootstrap.offsetX, bootstrap.offsetY)
      errorCode = null
      publishState()
      try {
        if (!coreReady) {
          await loadCubismCore(bootstrap.cubismCoreUrl)
          coreReady = true
        }
        if (!cubism2Ready && bootstrap.cubism2Url !== undefined && bootstrap.cubism2Url !== null) {
          await loadCubism2(bootstrap.cubism2Url)
          cubism2Ready = true
        }
      } catch {
        await report('error', 'CUBISM_PARSE_ERROR')
        return
      }
      if (bootstrap.initialModelUrl !== null) {
        await load(bootstrap.initialModelUrl)
      } else {
        await report('error', 'FILE_NOT_FOUND')
      }
    },

    resize(width, height) {
      if (disposed) return
      try {
        deps.renderer.resize(width, height)
      } catch {
        // Resize loss is fail-open; next stage report still controls user-visible state.
      }
    },

    async retry() {
      if (lastModelUrl !== null) await load(lastModelUrl)
    },

    async handleCommand(command) {
      if (disposed) return
      switch (command.type) {
        case 'set-emotion':
          await expressionController?.setEmotion(command.emotion)
          return
        case 'load-model':
          // 名单随命令更新：alias 解析只认这一份，沿用上一个模型的名单会让表情静默失效。
          if (command.expressionNames !== undefined) expressionNames = command.expressionNames
          await load(command.modelUrl)
          return
        case 'set-zoom':
          deps.renderer.setZoom(command.zoom)
          return
        case 'set-offset':
          deps.renderer.setOffset(command.offsetX, command.offsetY)
          return
        case 'resize':
          deps.renderer.resize(command.width, command.height)
          return
        case 'pause':
          deps.renderer.pause()
          return
        case 'resume':
          deps.renderer.resume()
          return
        case 'dispose':
          this.dispose()
      }
    },

    getState: snapshot,

    dispose() {
      if (disposed) return
      disposed = true
      if (performanceTimer !== null) clearTimer(performanceTimer)
      performanceTimer = null
      motionPipeline?.dispose()
      motionPipeline = null
      expressionController?.dispose()
      expressionController = null
      deps.renderer.setFrameDriver(null)
      deps.renderer.dispose()
    }
  }
}
