// src/renderer/src/live2d/PixiLive2DRenderer.ts
// P3A-03：pixi-live2d-display-lipsyncpatch 的实现适配层。
//
// 所有 Pixi / Cubism 细节停留在本文件。上层仅通过 ILive2DRenderer 工作，避免 fork
// 停维护时扩散替换成本。实际模型使用 autoUpdate:false，由本类唯一 ticker 控制；
// P3A-16 可以安全接入可测的帧插件管线。

import '@pixi/unsafe-eval'
import { Application } from 'pixi.js'
import type { Live2DModel } from 'pixi-live2d-display-lipsyncpatch/cubism4'
import {
  LIVE2D_PARAMETER_IDS,
  type ILive2DRenderer,
  type Live2DFrameDriver,
  type Live2DParameterUpdate,
  type Live2DRendererFrame,
  type Live2DRendererMetrics,
  type Live2DViewLayout
} from './ILive2DRenderer'
import { createMotionPipeline, type MotionPipeline } from './motion/pipeline'

export interface PixiLive2DModelHandle {
  setParameter(id: string, value: number, weight?: number, blend?: 'set' | 'multiply'): void
  hasParameter(id: string): boolean
  expression(name: string): Promise<boolean>
  motion(group: string, index?: number): Promise<boolean>
  /** 只推进模型的帧计时器；真正的内部求值在库的渲染阶段发生（见 setFrameHook）。 */
  update(deltaMs: number): void
  /**
   * 安装/卸下 P3A-16 帧插件钩子，传 null 卸下。
   *
   * 实现必须在**原生 motion 求值处**调用钩子，并保证原生求值整帧执行且只执行一次。
   * 声明为必填而非可选：漏装钩子的后果是插件全体静默失效——画面照常动（native 还在跑），
   * 眨眼/眼跳/呼吸/表情却全部消失，是最难在测试里发现的一类失败。
   */
  setFrameHook(hook: Live2DFrameDriver | null): void
  resizeToFit?(width: number, height: number, layout: Live2DViewLayout): void
  hitTest(x: number, y: number): string[]
  destroy(): void
}

export interface PixiLive2DTickerHandle {
  add(listener: (deltaMs: number) => void): void
  remove(listener: (deltaMs: number) => void): void
  start(): void
  stop(): void
}

export interface PixiLive2DApplicationHandle {
  readonly ticker: PixiLive2DTickerHandle
  readonly stage: {
    addChild(model: PixiLive2DModelHandle): void
    removeChild(model: PixiLive2DModelHandle): void
  }
  resize(width: number, height: number): void
  render(): void
  destroy(): void
}

/**
 * 很窄的 Pixi/Cubism seam。测试注入 fake adapter，不加载 GPU、Cubism runtime 或真实纹理。
 * 生产适配器封装在 createPixiLive2DAdapter()，不向 ILive2DRenderer 暴露第三方类型。
 */
export interface PixiLive2DAdapter {
  createApplication(size: { width: number; height: number }): PixiLive2DApplicationHandle
  loadModel(manifestUrl: string): Promise<PixiLive2DModelHandle>
}

export interface PixiLive2DRendererOptions {
  readonly adapterFactory?: (canvas: HTMLCanvasElement) => PixiLive2DAdapter
  readonly now?: () => number
}

function defaultNow(): number {
  return performance.now()
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function normalizeDimension(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.round(value))
}

function normalizeZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(3, Math.max(0.25, value))
}

function normalizeOffset(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(-100, value))
}

function canvasDimension(canvas: HTMLCanvasElement, axis: 'width' | 'height'): number {
  const clientValue = axis === 'width' ? canvas.clientWidth : canvas.clientHeight
  const canvasValue = axis === 'width' ? canvas.width : canvas.height
  return normalizeDimension(clientValue || canvasValue || 1)
}

/**
 * P3A-03 最小真实渲染器。
 *
 * load() 先完成新模型资源加载与 stage.addChild，再移除/销毁旧模型；资源加载失败时旧模型
 * 原样保留。这一保守生命周期是 P3A-15「切换失败不白屏」的底座。
 */
export class PixiLive2DRenderer implements ILive2DRenderer {
  private readonly adapterFactory: (canvas: HTMLCanvasElement) => PixiLive2DAdapter
  private readonly now: () => number
  private canvas: HTMLCanvasElement | null = null
  private app: PixiLive2DApplicationHandle | null = null
  private model: PixiLive2DModelHandle | null = null
  private frameDriver: Live2DFrameDriver | null = null
  private readonly motionPipeline: MotionPipeline
  private readonly onTickerFrame: (deltaMs: number) => void
  private readonly onModelFrame: Live2DFrameDriver
  private readonly onContextLost: (event: Event) => void
  private readonly onContextRestored: () => void
  private disposed = false
  private paused = false
  private contextLost = false
  private frameCount = 0
  private fps = 0
  private lastFrameAt: number | null = null
  private fpsWindowStartedAt: number | null = null
  private fpsWindowFrameCount = 0
  private modelLoadMs: number | null = null
  private contextLossCount = 0
  private layout: Live2DViewLayout = { zoom: 1, offsetX: 0, offsetY: 0 }

  constructor(options: PixiLive2DRendererOptions = {}) {
    this.adapterFactory = options.adapterFactory ?? createPixiLive2DAdapter
    this.now = options.now ?? defaultNow
    this.motionPipeline = createMotionPipeline()
    this.onTickerFrame = (deltaMs) => this.renderFrame(deltaMs)
    this.onModelFrame = (frame, nativeMotionUpdate) =>
      this.runFramePlugins(frame, nativeMotionUpdate)
    this.onContextLost = (event) => {
      event.preventDefault()
      this.contextLost = true
      this.contextLossCount++
      this.pause()
    }
    this.onContextRestored = () => {
      this.contextLost = false
      this.resume()
    }
  }

  attach(canvas: HTMLCanvasElement): void {
    this.assertUsable()
    if (this.app !== null) {
      throw new Error('Live2D renderer is already attached')
    }

    const width = canvasDimension(canvas, 'width')
    const height = canvasDimension(canvas, 'height')
    const adapter = this.adapterFactory(canvas)
    const app = adapter.createApplication({ width, height })

    this.canvas = canvas
    this.adapter = adapter
    this.app = app
    canvas.addEventListener('webglcontextlost', this.onContextLost)
    canvas.addEventListener('webglcontextrestored', this.onContextRestored)
    app.ticker.add(this.onTickerFrame)
    app.ticker.start()
  }

  async load(manifestUrl: string): Promise<void> {
    this.assertAttached()
    if (manifestUrl.length === 0) {
      throw new Error('Live2D model manifest URL must not be empty')
    }

    const loadStartedAt = this.now()
    const candidate = await this.adapterFactoryForAttachedCanvas().loadModel(manifestUrl)
    const app = this.requireApp()
    const previous = this.model
    let candidateAttached = false

    try {
      // fork 只在实际 draw 前、且累计 delta 非零时推进 internalModel。先预热一个最小
      // delta，使同步首帧验证能先更新 motion/physics/dynamic flags；旧模型始终留到候选
      // 完整 draw 成功为止。
      candidate.update(1_000 / 60)
      candidate.resizeToFit?.(
        canvasDimension(this.canvas!, 'width'),
        canvasDimension(this.canvas!, 'height'),
        this.layout
      )
      app.stage.addChild(candidate)
      candidateAttached = true
      // 同步验证候选首帧；只有完整 draw 成功才进入 swap，失败时旧模型仍在 stage。
      app.render()
    } catch (error) {
      if (candidateAttached) app.stage.removeChild(candidate)
      candidate.destroy()
      throw error
    }

    this.model = candidate
    // 钩子只在 swap 之后装：预热那一帧候选还没成为 this.model，插件此时写参数会落到旧模型上。
    candidate.setFrameHook(this.onModelFrame)
    this.modelLoadMs = Math.max(0, Math.round(this.now() - loadStartedAt))

    if (previous !== null) {
      previous.setFrameHook(null)
      app.stage.removeChild(previous)
      previous.destroy()
    }
  }

  unload(): void {
    const app = this.app
    const model = this.model
    this.model = null
    if (app === null || model === null) return
    model.setFrameHook(null)
    app.stage.removeChild(model)
    model.destroy()
  }

  resize(width: number, height: number): void {
    this.assertAttached()
    const normalizedWidth = normalizeDimension(width)
    const normalizedHeight = normalizeDimension(height)
    this.requireApp().resize(normalizedWidth, normalizedHeight)
    this.model?.resizeToFit?.(normalizedWidth, normalizedHeight, this.layout)
  }

  setZoom(zoom: number): void {
    this.assertAttached()
    this.applyLayout({ ...this.layout, zoom: normalizeZoom(zoom) })
  }

  setOffset(offsetX: number, offsetY: number): void {
    this.assertAttached()
    this.applyLayout({
      ...this.layout,
      offsetX: normalizeOffset(offsetX),
      offsetY: normalizeOffset(offsetY)
    })
  }

  private applyLayout(layout: Live2DViewLayout): void {
    this.layout = layout
    const canvas = this.canvas
    if (canvas === null) return
    this.model?.resizeToFit?.(
      canvasDimension(canvas, 'width'),
      canvasDimension(canvas, 'height'),
      this.layout
    )
  }

  pause(): void {
    if (this.disposed || this.paused) return
    this.paused = true
    this.lastFrameAt = null
    this.app?.ticker.stop()
  }

  resume(): void {
    if (this.disposed || this.contextLost) return
    const wasPaused = this.paused
    this.paused = false
    if (wasPaused) {
      // 窗口从隐藏/最小化恢复时清空 FPS 观察窗，避免暂停时长污染采样。
      this.fpsWindowStartedAt = null
      this.fpsWindowFrameCount = 0
    }
    try {
      // BrowserWindow 可能在初始隐藏期间被 Chromium 节流，但 renderer 不知道该状态；
      // 因此 resume 必须幂等地补一次渲染并显式启动唯一 ticker，而不能只翻转本地 paused。
      this.app?.render()
    } catch {
      // 一次显式首帧渲染失败不让 resume 破坏聊天；后续 ticker/context 路径会继续处理。
    }
    this.app?.ticker.start()
  }

  setFrameDriver(driver: Live2DFrameDriver | null): void {
    this.assertUsable()
    this.frameDriver = driver
  }

  addMotionPlugin(plugin: Parameters<MotionPipeline['add']>[0]): void {
    this.assertUsable()
    this.motionPipeline.add(plugin)
  }

  async setExpression(expression: string): Promise<boolean> {
    if (expression.length === 0 || this.model === null || this.disposed) return false
    return this.model.expression(expression)
  }

  async playMotion(group: string, index?: number): Promise<boolean> {
    if (group.length === 0 || this.model === null || this.disposed) return false
    return this.model.motion(group, index)
  }

  setParameter(update: Live2DParameterUpdate): boolean {
    if (this.model === null || this.disposed || !Number.isFinite(update.value)) return false
    if (!this.model.hasParameter(update.id)) return false
    this.model.setParameter(update.id, update.value, update.weight, update.blend)
    return true
  }

  setMouthOpen(value: number): boolean {
    return this.setParameter({ id: LIVE2D_PARAMETER_IDS.mouthOpen, value: clampUnit(value) })
  }

  setEyeOpen(value: number): boolean {
    const normalized = clampUnit(value)
    const left = this.setParameter({ id: LIVE2D_PARAMETER_IDS.eyeLeftOpen, value: normalized })
    const right = this.setParameter({ id: LIVE2D_PARAMETER_IDS.eyeRightOpen, value: normalized })
    return left || right
  }

  hitTest(x: number, y: number): readonly string[] {
    if (this.model === null || this.disposed || !Number.isFinite(x) || !Number.isFinite(y))
      return []
    return this.model.hitTest(x, y)
  }

  getMetrics(): Live2DRendererMetrics {
    return {
      fps: this.fps,
      frameCount: this.frameCount,
      modelLoadMs: this.modelLoadMs,
      contextLossCount: this.contextLossCount,
      paused: this.paused,
      hasModel: this.model !== null
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true

    const canvas = this.canvas
    const app = this.app
    const model = this.model
    this.canvas = null
    this.adapter = null
    this.app = null
    this.model = null
    this.frameDriver = null
    this.motionPipeline.dispose()

    if (canvas !== null) {
      canvas.removeEventListener('webglcontextlost', this.onContextLost)
      canvas.removeEventListener('webglcontextrestored', this.onContextRestored)
    }
    if (app !== null) {
      app.ticker.remove(this.onTickerFrame)
      app.ticker.stop()
      if (model !== null) {
        model.setFrameHook(null)
        app.stage.removeChild(model)
        model.destroy()
      }
      app.destroy()
    }
  }

  private renderFrame(deltaMs: number): void {
    if (this.paused || this.model === null || this.disposed) return
    const frameNow = this.now()
    const normalizedDeltaMs = Math.max(
      0,
      Number.isFinite(deltaMs) && deltaMs > 0
        ? deltaMs
        : this.lastFrameAt === null
          ? 0
          : frameNow - this.lastFrameAt
    )
    this.lastFrameAt = frameNow

    try {
      // ticker 上只推进模型的帧计时器。P3A-16 插件管线不在这里跑：渲染库把 `update(dt)`
      // 实现成纯累加，真正的内部求值（motion → 表情 → focus → 物理 → pose）发生在随后的
      // 渲染阶段，所以在 ticker 上执行插件会让 `post/final` 实际排在 native **之前**。
      // 插件改由 runFramePlugins 在 native motion 求值处驱动（见 setFrameHook）。
      this.model.update(normalizedDeltaMs)
    } catch {
      // 推进计时器失败不能让 ticker 整体停住；FPS 记账继续，下一帧照常重试。
    }

    this.frameCount++
    this.fpsWindowFrameCount++
    if (this.fpsWindowStartedAt === null) {
      this.fpsWindowStartedAt = frameNow
      return
    }
    const elapsedMs = frameNow - this.fpsWindowStartedAt
    if (elapsedMs >= 1_000) {
      this.fps = Math.round((this.fpsWindowFrameCount * 1_000) / elapsedMs)
      this.fpsWindowStartedAt = frameNow
      this.fpsWindowFrameCount = 0
    }
  }

  /**
   * P3A-16 管线的唯一执行点，由模型在 native motion 求值处回调。
   *
   * 两条不变量：①native 求值整帧执行且只执行一次——插件可以短路彼此，但按 P3A-16 冻结条款
   * 不得跳过 native；②插件/driver 抛错 fail-open，绝不把异常带回渲染循环。
   */
  private runFramePlugins(frame: Live2DRendererFrame, nativeMotionUpdate: () => void): void {
    let nativeRan = false
    const runNative = (): void => {
      if (nativeRan) return
      nativeRan = true
      nativeMotionUpdate()
    }

    try {
      if (this.disposed) runNative()
      else if (this.frameDriver === null) this.motionPipeline.run(frame, runNative)
      // 自定义 driver（P3A-16）接管完整 pre/native/post/final 顺序；不再套一层 renderer
      // 自己的空管线，避免 native 求值或插件重复执行。
      else this.frameDriver(frame, runNative)
    } catch {
      // 动画插件不能让模型停在上一帧；本帧退化为纯 native 求值。
    }
    runNative()
  }

  private adapterFactoryForAttachedCanvas(): PixiLive2DAdapter {
    if (this.canvas === null || this.adapter === null) {
      throw new Error('Live2D renderer is not attached')
    }
    return this.adapter
  }

  private adapter: PixiLive2DAdapter | null = null

  private requireApp(): PixiLive2DApplicationHandle {
    if (this.app === null) throw new Error('Live2D renderer is not attached')
    return this.app
  }

  private assertAttached(): void {
    this.assertUsable()
    this.requireApp()
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error('Live2D renderer has been disposed')
  }
}

/**
 * 构造真实 Pixi adapter。此函数是唯一需要了解 fork API 的地方。
 *
 * 本地 fork 的类型声明（0.5.0-ls-8）确认 Live2DModel.from/motion/expression/update/
 * destroy 以及 speak/stopSpeaking 均存在；3a 不调用音频 API，留给 3b 的 PlaybackHost。
 */
export function createPixiLive2DAdapter(canvas: HTMLCanvasElement): PixiLive2DAdapter {
  const listenerMap = new Map<(deltaMs: number) => void, () => void>()
  let app: Application | null = null

  return {
    createApplication(size) {
      const application = new Application({
        view: canvas,
        width: normalizeDimension(size.width),
        height: normalizeDimension(size.height),
        backgroundAlpha: 0,
        antialias: true,
        autoDensity: true
      })
      // AIRI 同样在 Application ticker 层设上限。桌宠不需要跑到显示器刷新率以上；
      // 60fps 足够平滑，也避免 144/240Hz 屏幕无意义抬高空闲 CPU。
      application.ticker.maxFPS = 60
      app = application

      return {
        ticker: {
          add(listener) {
            const pixiListener = (): void => listener(application.ticker.deltaMS)
            listenerMap.set(listener, pixiListener)
            application.ticker.add(pixiListener)
          },
          remove(listener) {
            const pixiListener = listenerMap.get(listener)
            if (pixiListener !== undefined) {
              application.ticker.remove(pixiListener)
              listenerMap.delete(listener)
            }
          },
          start() {
            application.ticker.start()
          },
          stop() {
            application.ticker.stop()
          }
        },
        stage: {
          addChild(model) {
            application.stage.addChild(unwrapPixiModel(model))
          },
          removeChild(model) {
            application.stage.removeChild(unwrapPixiModel(model))
          }
        },
        resize(width, height) {
          application.renderer.resize(normalizeDimension(width), normalizeDimension(height))
        },
        render() {
          application.render()
        },
        destroy() {
          listenerMap.clear()
          application.destroy(true, { children: true, texture: true, baseTexture: true })
          app = null
        }
      }
    },
    async loadModel(manifestUrl) {
      if (app === null) throw new Error('Pixi application has not been created')
      // fork 会在 import 时读取 window；延迟 import 使纯 Node 测试只经过注入 adapter，
      // 同时保持生产 stage 的浏览器运行时加载。autoUpdate:false 防止它挂到 shared ticker。
      // 内置 Mao/Hiyori 均为 .model3.json，只加载 Cubism 4 entry；stage 不注册无关的
      // Cubism 2 middleware，避免把两种模型生命周期混在同一 renderer bundle。
      const { Live2DModel, MotionPreloadStrategy } =
        await import('pixi-live2d-display-lipsyncpatch/cubism4')
      const model = await Live2DModel.from(manifestUrl, {
        autoUpdate: false,
        ticker: app.ticker,
        checkMocConsistency: true,
        // 用库默认的 IDLE 而非 ALL：Phase 3a 把 idle motion 也禁掉了（见下面的
        // idleMotionGroup），`playMotion` 在生产侧零调用点，ALL 预加载的全部 motion 文件
        // 因此从不被播放。实测（2026-08-29，Mao↔Hiyori 各 8 次切换）：ALL 稳态 133–134MB /
        // 切换后 191MB；IDLE 稳态 131–132MB / 切换后 175MB——省约 2MB/次切换且无功能代价。
        // 参考项目 AIRI 与 Cyrene-Agent 均不设此选项（即用默认 IDLE）。
        // 将来真的要播 motion（Phase 4+）时改回 ALL 即可，只是一行。
        motionPreload: MotionPreloadStrategy.IDLE,
        // Nacime owns continuous idle animation in its frame-plugin pipeline. Suppress the fork's
        // autonomous idle-motion request: it can outlive a failed first render and start a motion
        // after the manager has begun bounded fallback/disposal.
        idleMotionGroup: '__nacime_disabled_idle__',
        autoHitTest: false,
        autoFocus: false
      })
      installCubism4RenderOrderCompatibility(model)
      disableForkAutoEyeBlink(model)
      return wrapPixiModel(model)
    }
  }
}

interface HookableMotionManager {
  update(coreModel: unknown, now: number): boolean
}

interface Cubism4InternalModelWithMotionManager {
  motionManager?: HookableMotionManager
}

/**
 * 把 P3A-16 帧插件管线挂到渲染库的**原生 motion 求值处**。
 *
 * 库的 `Cubism4InternalModel.update()` 每帧顺序是
 * `motionManager.update()` → `saveParameters()` → `expressionManager.update()` → focus →
 * 呼吸 → 物理 → pose → `coreModel.update()` → `loadParameters()`；而 `Live2DModel.update(dt)`
 * **只累加计时器**，整段求值要等到渲染阶段才发生。所以想让 `pre → native → post → final`
 * 名副其实，唯一可用的挂载点就是替换 `motionManager.update`：替换后 `post/final` 读到的是本帧
 * motion 之后的参数值，写入随后被 `saveParameters()` 固化为下一帧基准，再由表情/focus/物理
 * 叠加其上——与 airi 的 `hookUpdate` 位置一致。
 *
 * 时间基准取库传进来的 `now`（秒）而非墙钟：它由模型自己的 `elapsedTime` 累加，窗口暂停时不
 * 前进，恢复后也就不会出现巨大 delta。
 *
 * 找不到 motionManager 时**抛错**而不是静默跳过：静默的后果是所有帧插件消失、画面却照常动
 * （native 还在跑），属于最难被测试和肉眼发现的一类失败。
 */
function installFrameHookSeam(model: Live2DModel): (hook: Live2DFrameDriver | null) => void {
  const internal = model.internalModel as Cubism4InternalModelWithMotionManager | undefined
  const motionManager = internal?.motionManager
  if (motionManager === undefined || typeof motionManager.update !== 'function') {
    throw new Error('CUBISM_MOTION_MANAGER_UNAVAILABLE')
  }

  const nativeMotionUpdate = motionManager.update
  let frameHook: Live2DFrameDriver | null = null
  let lastNowMs: number | null = null

  motionManager.update = (coreModel: unknown, now: number): boolean => {
    const nowMs = now * 1_000
    const deltaMs = lastNowMs === null ? 0 : Math.max(0, nowMs - lastNowMs)
    lastNowMs = nowMs

    let motionUpdated = false
    let nativeRan = false
    const runNative = (): void => {
      if (nativeRan) return
      nativeRan = true
      motionUpdated = nativeMotionUpdate.call(motionManager, coreModel, now)
    }

    const hook = frameHook
    if (hook !== null) {
      try {
        hook({ deltaMs, nowMs }, runNative)
      } catch {
        // runFramePlugins 已经 fail-open；这里是进入渲染循环前的最后一道防线——
        // 钩子异常一旦逃逸就会中断 _render，整个 stage 停帧。
      }
    }
    runNative()
    return motionUpdated
  }

  return (hook) => {
    frameHook = hook
  }
}

interface Cubism4InternalModelWithEyeBlink {
  eyeBlink?: unknown
}

/**
 * 关掉 fork 内置的 `CubismEyeBlink`，让眼睛只由本项目的 P3A-17 眨眼状态机驱动。
 *
 * fork 的 `Cubism4InternalModel.update()` 顺序是
 *   motionManager.update → saveParameters → **expressionManager.update** → `eyeBlink.updateParameters`
 * 内置眨眼排在表情之后，且用**绝对写**覆盖 `ParamEyeLOpen/ROpen`。而 Mao 的 8 个 .exp3.json
 * 全部以 `ParamEyeLOpen/ROpen` 的 Multiply 为主通道——exp_02（闭眼笑）只有这一个通道——
 * 于是「表情应用成功、返回 true、画面纹丝不动」。2026-08-29 真机逐像素比对确认：带 Add 通道的
 * exp_05/06/07/08 看得见，纯眼部的 exp_02 完全不可见。
 *
 * 另外我们本来就有自己的眨眼插件；不关掉内置的等于两套眨眼同时驱动同一对参数。
 * 它只在 `!motionUpdated` 时运行，而 idle motion 已被 `idleMotionGroup` 禁用，所以它一直在跑。
 */
export function disableForkAutoEyeBlink(model: { internalModel?: unknown }): void {
  const internal = model.internalModel as Cubism4InternalModelWithEyeBlink | undefined
  if (internal !== undefined && typeof internal === 'object') internal.eyeBlink = undefined
}

interface Cubism4CoreDrawableCollection {
  readonly renderOrders?: unknown
}

interface Cubism4CoreNativeModel {
  readonly drawables?: Cubism4CoreDrawableCollection
  getRenderOrders?(): unknown
}

interface Cubism4InternalModelForDrawOrder {
  readonly coreModel?: {
    readonly _model?: Cubism4CoreNativeModel
  }
}

/**
 * Bridges the current Cubism Core `Model.getRenderOrders()` API to the field read by the locked fork.
 *
 * `pixi-live2d-display-lipsyncpatch@0.5.0-ls-8` reads `drawables.renderOrders`, but the bundled
 * current Core exposes the required 0..N-1 render permutation through `Model.getRenderOrders()`.
 * Its `drawables.drawOrders` is a different authored layering value (duplicates such as 500/800),
 * so aliasing that field would render only a few meshes. The compatibility view is model-local and
 * does not modify the global Cubism runtime.
 */
function installCubism4RenderOrderCompatibility(model: Live2DModel): void {
  const internal = model.internalModel as Cubism4InternalModelForDrawOrder | undefined
  const nativeModel = internal?.coreModel?._model
  if (nativeModel === undefined) throw new Error('CUBISM_RENDER_ORDER_UNAVAILABLE')
  const drawables = nativeModel.drawables
  if (drawables === undefined) throw new Error('CUBISM_RENDER_ORDER_UNAVAILABLE')
  if (drawables.renderOrders !== undefined) return
  if (typeof nativeModel.getRenderOrders !== 'function') {
    throw new Error('CUBISM_RENDER_ORDER_UNAVAILABLE')
  }

  Object.defineProperty(drawables, 'renderOrders', {
    configurable: true,
    enumerable: false,
    get: () => nativeModel.getRenderOrders!()
  })
}

const PIXI_MODEL = Symbol('pixi-live2d-model')

type WrappedPixiModel = PixiLive2DModelHandle & { readonly [PIXI_MODEL]: Live2DModel }

function unwrapPixiModel(model: PixiLive2DModelHandle): Live2DModel {
  const nativeModel = (model as Partial<WrappedPixiModel>)[PIXI_MODEL]
  if (nativeModel === undefined) {
    throw new Error('Pixi adapter received a model from a different renderer implementation')
  }
  return nativeModel
}

interface Cubism4ParameterModel {
  getParameterIndex(id: string): number
  getParameterValueById(id: string): number
  setParameterValueById(id: string, value: number, weight?: number): void
  multiplyParameterValueById(id: string, value: number, weight?: number): void
}

interface Cubism2ParameterModel {
  getParamIndex(id: string): number
  getParamFloat(id: string): number
  setParamFloat(id: string, value: number, weight?: number): void
  multParamFloat(id: string, value: number, weight?: number): void
}

function isCubism4ParameterModel(value: unknown): value is Cubism4ParameterModel {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Cubism4ParameterModel>
  return (
    typeof candidate.getParameterIndex === 'function' &&
    typeof candidate.getParameterValueById === 'function' &&
    typeof candidate.setParameterValueById === 'function' &&
    typeof candidate.multiplyParameterValueById === 'function'
  )
}

function isCubism2ParameterModel(value: unknown): value is Cubism2ParameterModel {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<Cubism2ParameterModel>
  return (
    typeof candidate.getParamIndex === 'function' &&
    typeof candidate.getParamFloat === 'function' &&
    typeof candidate.setParamFloat === 'function' &&
    typeof candidate.multParamFloat === 'function'
  )
}

function getCoreModel(model: Live2DModel): unknown {
  return model.internalModel?.coreModel
}

function resizeModelToFit(
  model: Live2DModel,
  width: number,
  height: number,
  layout: Live2DViewLayout
): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
  // model.width/height are scale-aware. Measure from a normalized transform so successive resize
  // events do not compound scale and eventually move the model out of the stage.
  model.scale.set(1)
  const modelWidth = model.width
  const modelHeight = model.height
  if (
    !Number.isFinite(modelWidth) ||
    !Number.isFinite(modelHeight) ||
    modelWidth <= 0 ||
    modelHeight <= 0
  )
    return

  // AIRI's desktop stage deliberately normalizes scale=1 to roughly twice the viewport height and
  // places the model at the bottom center. A full-canvas "contain" fit makes official sample models
  // appear as a tiny fragment because their authored canvas includes large transparent margins.
  const scale =
    Math.min((width / modelWidth) * 2, (height / modelHeight) * 2) * normalizeZoom(layout.zoom)
  // 百分比偏移同 AIRI：正 Y 抬高模型，露出更多身体；与 zoom 组合即可在半身/全身之间切换。
  const offsetX = (normalizeOffset(layout.offsetX) / 100) * width
  const offsetY = (normalizeOffset(layout.offsetY) / 100) * height
  model.anchor.set(0.5, 0.5)
  model.scale.set(scale)
  model.position.set(width / 2 + offsetX, height - offsetY)
}

function wrapPixiModel(model: Live2DModel): WrappedPixiModel {
  const setFrameHook = installFrameHookSeam(model)
  const hasParameter = (id: string): boolean => {
    const core = getCoreModel(model)
    if (isCubism4ParameterModel(core)) return core.getParameterIndex(id) >= 0
    if (isCubism2ParameterModel(core)) return core.getParamIndex(id) >= 0
    return false
  }

  return {
    [PIXI_MODEL]: model,
    setParameter(id, value, weight, blend) {
      const core = getCoreModel(model)
      if (isCubism4ParameterModel(core)) {
        if (blend === 'multiply') core.multiplyParameterValueById(id, value, weight)
        else core.setParameterValueById(id, value, weight)
      } else if (isCubism2ParameterModel(core)) {
        if (blend === 'multiply') core.multParamFloat(id, value, weight)
        else core.setParamFloat(id, value, weight)
      }
    },
    hasParameter,
    expression(name) {
      return model.expression(name)
    },
    motion(group, index) {
      return model.motion(group, index)
    },
    update(deltaMs) {
      model.update(deltaMs)
    },
    setFrameHook,
    resizeToFit(width, height, layout) {
      resizeModelToFit(model, width, height, layout)
    },
    hitTest(x, y) {
      return model.hitTest(x, y)
    },
    destroy() {
      model.destroy({ children: true, texture: true, baseTexture: true })
    }
  }
}
