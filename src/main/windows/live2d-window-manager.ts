// src/main/windows/live2d-window-manager.ts
// P3A-04/05：Live2D stage 的 main-process 真源。
//
// 两个 renderer 不共享 Pinia。这里拥有 BrowserWindow、stage instance、可见状态和
// webContents capability 生命周期；模型文件/注册表会在 P3A-08..15 注入本 manager。

import type { BrowserWindow, Rectangle, WebContents } from 'electron'
import type {
  Live2dStageBootstrap,
  Live2dStageCommand,
  Live2dStageReadyRequest,
  Live2dStageReport,
  Live2dStageStatus
} from '@shared/live2d/stage-types'
import type { Live2dSemanticEmotion } from '@shared/live2d/types'
import { AppError } from '@shared/errors'
import { sendEvent } from '../ipc/register'
import type { ModelLoadPlan } from '../live2d/model-service'

export interface Live2dWindowSnapshot {
  readonly stageInstanceId: string | null
  readonly status: Live2dStageStatus | 'closed'
  readonly visible: boolean
  readonly alwaysOnTop: boolean
  readonly webContentsId: number | null
  readonly loadedModelId: string | null
  /** P3B-15：stage 是否以 audio-only 轻量模式运行（TTS 开而 Live2D 关）。 */
  readonly audioOnly: boolean
}

interface ManagedStageWindow {
  readonly webContents: WebContents
  isDestroyed(): boolean
  isVisible(): boolean
  show(): void
  destroy(): void
  getBounds(): Rectangle
  setPosition(x: number, y: number): void
  setAlwaysOnTop(value: boolean): void
  on(
    event: 'closed' | 'render-process-gone' | 'hide' | 'minimize' | 'show' | 'restore',
    listener: () => void
  ): unknown
}

export interface Live2dWindowManagerDeps {
  readonly createWindow: (options: { readonly alwaysOnTop: boolean }) => BrowserWindow
  /** 注册/注销 capability 后由 main 重新 configure IPC guard。 */
  readonly onStageCreated: (webContentsId: number) => void
  readonly onStageDestroyed: (webContentsId: number) => void
  readonly getModelLoadPlan: () => ModelLoadPlan
  readonly getStageModelUrl: (modelId: string) => string | null
  readonly getModelExpressionNames?: (modelId: string) => readonly string[]
  readonly getLoadAttemptUrl?: (attemptIndex: number) => string | null
  readonly getCubismCoreUrl: () => string | null
  readonly getCubism2Url?: () => string | null
  readonly getZoom: () => number
  /** 取景偏移（画布百分比）；与 zoom 同为 config 单真源，stage 不自行记忆构图。 */
  readonly getOffset: () => { readonly x: number; readonly y: number }
  /** 只返回当前窗口所在显示器的工作区；用于重置位置，不接受 renderer 坐标。 */
  readonly getDisplayWorkArea?: (windowBounds: Rectangle) => Rectangle
  /** stage 首帧 ready / 1.1s FPS 采样报告时记录性能指标；只传数字，无模型路径或文本。 */
  readonly onPerformanceReport?: (sender: WebContents, report: Live2dStageReport) => void
  /** 仅为纯单测注入；生产默认走 sendEvent 的 capability 守卫。 */
  readonly sendStageCommand?: (webContents: WebContents, command: Live2dStageCommand) => void
  readonly scheduleResume?: (callback: () => void) => void
  readonly cancelScheduledResume?: () => void
  /**
   * S-006-补充 §1.7.7：stage 崩溃后的有界重建调度。生产默认 setTimeout(0)（让
   * Chromium 先完成 render-process-gone 的清理）；测试注入同步/可控 timer。
   */
  readonly scheduleCrashRebuild?: (callback: () => void) => void
  /** 状态变化时由 main 投影一份 metadata-only event 到 chat renderer。 */
  readonly onStateChange?: () => void
  /**
   * P3B-15（F5-007 §1.14）：stage ready(stageInstanceId) 后、转交 audio port 前调用。
   * 此刻 stage renderer 已启动（preload 就绪），main 可以安全地 postMessage 专用 port。
   */
  readonly onStageReady?: (webContents: WebContents) => void
}

/**
 * 单例式窗口管理器。show() 可多次调用且不重复建窗；destroy() 可多次调用；关闭后下一次
 * show() 得到新 webContents 和新 stage instance，旧 ID 的能力会先移除。
 */
export class Live2dWindowManager {
  private window: ManagedStageWindow | null = null
  private stageInstanceId: string | null = null
  private status: Live2dStageStatus | 'closed' = 'closed'
  private alwaysOnTop = true
  private lastReport: Live2dStageReport | null = null
  private loadPlan: ModelLoadPlan | null = null
  private activeModelId: string | null = null
  private loadedModelId: string | null = null
  private pendingLoadAttemptIndex = -1
  private resumeTimer: ReturnType<typeof setTimeout> | null = null
  /** 取景预览进行中：stage 显示草稿构图，config 未变；窗口重建或结束预览即归位。 */
  private previewing = false
  /** P3B-15：audio-only 轻量模式（不建 Pixi/模型、窗口保持隐藏、只跑 PlaybackHost）。 */
  private audioOnly = false
  /** 建窗时记下的 webContents id；窗口销毁后不可再读 window.webContents。 */
  private webContentsId: number | null = null
  /**
   * S-006-补充 §1.7.7「有界重建 1 次」：本 stage 会话内 renderer 崩溃后自动重建的次数。
   * 一次成功 ready 即归零（连续崩溃才受限；隔很久再崩仍可重建）；第二次连续崩溃保持
   * error 交给用户的显式恢复入口（设置页重开）。
   */
  private crashRebuilds = 0
  private crashRebuildTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * 本次 stage 会话已发起过的模型加载次数（bootstrap 首个候选 + 每次 load-model）。
   * P3A-28 的内存预算只在「单模型稳态」下判定，需要它来区分「刚开机」与「换过装」。
   * 降级链里的每一次尝试都算——因为每一次都可能真的把纹理传上过显存。
   */
  private modelsLoadedThisSession = 0

  constructor(private readonly deps: Live2dWindowManagerDeps) {}

  show(options?: { readonly alwaysOnTop?: boolean }): Live2dWindowSnapshot {
    if (options?.alwaysOnTop !== undefined) this.alwaysOnTop = options.alwaysOnTop
    const existing = this.window
    if (existing !== null && !existing.isDestroyed()) {
      try {
        // 从 audio-only 升到可见模式：隐藏着的声音宿主不切换为可视形象
        if (this.audioOnly) this.audioOnly = false
        existing.setAlwaysOnTop(this.alwaysOnTop)
        if (!existing.isVisible()) {
          existing.show()
          this.scheduleStageResume()
        }
      } catch {
        // 窗口可能在检查后关闭；保持当前快照，不让生命周期竞态崩溃 main。
      }
      return this.snapshot()
    }
    if (existing !== null) this.releaseWindow(existing)

    const window = this.deps.createWindow({
      alwaysOnTop: this.alwaysOnTop
    }) as unknown as ManagedStageWindow
    this.window = window
    this.audioOnly = false
    this.webContentsId = window.webContents.id
    this.stageInstanceId = null
    this.status = 'starting'
    this.lastReport = null
    this.loadPlan = this.deps.getModelLoadPlan()
    this.pendingLoadAttemptIndex = 0
    this.activeModelId = null
    this.loadedModelId = null
    // 新 stage 进程 = 新的内存基线，计数随之归零。
    this.modelsLoadedThisSession = 0
    this.deps.onStageCreated(window.webContents.id)
    this.deps.onStateChange?.()

    window.on('closed', () => this.releaseWindow(window))
    window.on('render-process-gone', () => this.handleRendererGone(window, 'visible'))
    // page visibility 在透明 BrowserWindow 上不能准确表达“用户主动隐藏/最小化”；
    // 生命周期真源留在 main，只有真正不显示给用户时才停 ticker。
    window.on('hide', () => this.sendStageCommand({ type: 'pause' }))
    window.on('minimize', () => this.sendStageCommand({ type: 'pause' }))
    window.on('show', () => this.scheduleStageResume())
    window.on('restore', () => this.scheduleStageResume())

    return this.snapshot()
  }

  /**
   * P3B-15（F5-007 §1.14）：`tts.enabled=true` 且 `ui.live2d.enabled=false` 时的
   * audio-only-hidden stage——创建/保留 `show:false` 的轻量 stage，只初始化 preload +
   * PlaybackHost（不创建 Pixi Application/模型，窗口从不显示给用户）。已有窗口
   * （无论哪种模式）直接复用，不重复建窗。
   */
  ensureAudioOnlyStage(): Live2dWindowSnapshot {
    const existing = this.window
    if (existing !== null && !existing.isDestroyed()) return this.snapshot()
    if (existing !== null) this.releaseWindow(existing)

    const window = this.deps.createWindow({
      alwaysOnTop: false
    }) as unknown as ManagedStageWindow
    this.window = window
    this.audioOnly = true
    this.webContentsId = window.webContents.id
    this.stageInstanceId = null
    this.status = 'starting'
    this.lastReport = null
    this.loadPlan = null
    this.pendingLoadAttemptIndex = 0
    this.activeModelId = null
    this.loadedModelId = null
    this.modelsLoadedThisSession = 0
    this.deps.onStageCreated(window.webContents.id)
    this.deps.onStateChange?.()

    window.on('closed', () => this.releaseWindow(window))
    window.on('render-process-gone', () => this.handleRendererGone(window, 'audio-only'))

    return this.snapshot()
  }

  /**
   * S-006-补充 §1.7.7 stage 崩溃恢复：
   *   render-process-gone → 标 error（旧 webContentsId 随 releaseWindow 出 trust set）
   *   → 有界重建 1 次（新 stageInstanceId + 新 webContentsId，按原模式重建）
   *   → 成功 ready 计数归零；再崩保持 error，交给用户显式恢复。
   * 绝不重建 chat window（chat CrashGuard 是另一条独立回路）。
   */
  private handleRendererGone(window: ManagedStageWindow, mode: 'visible' | 'audio-only'): void {
    if (this.window !== window) return
    this.status = 'error'
    this.deps.onStateChange?.()
    if (this.crashRebuilds >= 1) return // 有界：连续第二次崩溃不再自动重建
    this.crashRebuilds += 1
    const schedule =
      this.deps.scheduleCrashRebuild ??
      ((callback: () => void) => {
        this.crashRebuildTimer = setTimeout(callback, 0)
      })
    schedule(() => {
      this.crashRebuildTimer = null
      // 期间用户可能已主动关闭/切换（window 已不是崩溃那个）——不重建
      if (this.window !== window) return
      const rebuilds = this.crashRebuilds
      this.destroy()
      // destroy → releaseWindow 会复位计数；重建属于同一「连续崩溃」序列，恢复计数
      this.crashRebuilds = rebuilds
      if (mode === 'audio-only') this.ensureAudioOnlyStage()
      else this.show()
    })
  }

  destroy(): void {
    const window = this.window
    if (window === null) return
    this.releaseWindow(window)
    if (!window.isDestroyed()) {
      try {
        window.destroy()
      } catch {
        // 关闭竞态下窗口可能已由系统销毁；releaseWindow 已完成能力清理。
      }
    }
  }

  setAlwaysOnTop(value: boolean): void {
    this.alwaysOnTop = value
    const window = this.window
    if (window !== null && !window.isDestroyed()) {
      try {
        window.setAlwaysOnTop(value)
      } catch {
        // 窗口在检查后关闭时，设置属于尽力而为；不升级为 main 崩溃。
      }
    }
    this.deps.onStateChange?.()
  }

  setZoom(value: number): void {
    // 预览进行中时 config 变更不得抢走画面；预览结束会统一按 config 归位。
    if (this.previewing) return
    this.sendStageCommand({ type: 'set-zoom', zoom: normalizeZoom(value) })
    this.deps.onStateChange?.()
  }

  setOffset(x: number, y: number): void {
    if (this.previewing) return
    this.sendStageCommand({
      type: 'set-offset',
      offsetX: normalizeOffset(x),
      offsetY: normalizeOffset(y)
    })
    this.deps.onStateChange?.()
  }

  /**
   * S-006-补充 §1.7.4 的下发环。表情属于表现层，不进公开快照：它每轮都变、3 分钟自动
   * 回 neutral，投影出去只会让 chat store 抖动而没有任何消费者。窗口未开时 no-op。
   */
  setEmotion(emotion: Live2dSemanticEmotion): void {
    this.sendStageCommand({ type: 'set-emotion', emotion })
  }

  /**
   * P3A-25 取景实时预览。只推 stage 命令，不写 config、不改公开快照——因此保存失败或
   * 放弃草稿时，config / 窗口投影 / store 依然是同一份旧值。
   */
  previewFraming(framing: { zoom: number; offsetX: number; offsetY: number } | null): void {
    if (framing === null) {
      if (!this.previewing) return
      this.previewing = false
      // 归位到已保存构图：预览期间用户可能已保存或放弃，config 始终是唯一持久真源。
      this.sendStageCommand({ type: 'set-zoom', zoom: normalizeZoom(this.deps.getZoom()) })
      const offset = this.deps.getOffset()
      this.sendStageCommand({
        type: 'set-offset',
        offsetX: normalizeOffset(offset.x),
        offsetY: normalizeOffset(offset.y)
      })
      return
    }
    this.previewing = true
    this.sendStageCommand({ type: 'set-zoom', zoom: normalizeZoom(framing.zoom) })
    this.sendStageCommand({
      type: 'set-offset',
      offsetX: normalizeOffset(framing.offsetX),
      offsetY: normalizeOffset(framing.offsetY)
    })
  }

  resetWindowPlacement(): boolean {
    const window = this.window
    if (window === null || window.isDestroyed() || this.deps.getDisplayWorkArea === undefined) {
      return false
    }
    try {
      const bounds = window.getBounds()
      const workArea = this.deps.getDisplayWorkArea(bounds)
      const x = Math.round(workArea.x + (workArea.width - bounds.width) / 2)
      const y = Math.round(workArea.y + (workArea.height - bounds.height) / 2)
      window.setPosition(x, y)
      this.deps.onStateChange?.()
      return true
    } catch {
      // 显示器拓扑或窗口可能在计算期间改变；重置失败不影响 stage/chat。
      return false
    }
  }

  /** stage 的第一次 ready 建立随机 instance ID；随后同 webContents 必须严格匹配。 */
  acceptStageReady(sender: WebContents, input: Live2dStageReadyRequest): Live2dStageBootstrap {
    this.requireCurrentWindow(sender)
    if (this.stageInstanceId === null) {
      this.stageInstanceId = input.stageInstanceId
    } else if (this.stageInstanceId !== input.stageInstanceId) {
      throw invalidStageInstance()
    }
    // P3B-15：audio-only 宿主没有模型可加载；bootstrap 只带 mode 标志，不推进降级链。
    if (this.audioOnly) {
      this.status = 'starting'
      this.deps.onStateChange?.()
      this.deps.onStageReady?.(sender)
      return {
        stageInstanceId: this.stageInstanceId,
        status: this.status,
        mode: 'audio-only',
        initialModelUrl: null,
        cubismCoreUrl: null,
        zoom: 1,
        offsetX: 0,
        offsetY: 0,
        expressionNames: []
      }
    }
    this.status = 'loading-model'
    this.loadPlan ??= this.deps.getModelLoadPlan()
    this.pendingLoadAttemptIndex = 0
    const firstAttempt = this.loadPlan.attempts[0]
    this.activeModelId = firstAttempt?.modelId ?? null
    // bootstrap 自带的首个候选也是一次真实加载，同样计入「已加载模型数」。
    if (firstAttempt !== undefined) this.modelsLoadedThisSession++
    this.deps.onStateChange?.()
    this.deps.onStageReady?.(sender)

    return {
      stageInstanceId: this.stageInstanceId,
      status: this.status,
      initialModelUrl:
        firstAttempt === undefined ? null : this.deps.getStageModelUrl(firstAttempt.modelId),
      cubismCoreUrl: this.deps.getCubismCoreUrl(),
      cubism2Url: this.deps.getCubism2Url?.() ?? null,
      zoom: normalizeZoom(this.deps.getZoom()),
      offsetX: normalizeOffset(this.deps.getOffset().x),
      offsetY: normalizeOffset(this.deps.getOffset().y),
      expressionNames:
        firstAttempt === undefined || this.deps.getModelExpressionNames === undefined
          ? []
          : this.deps.getModelExpressionNames(firstAttempt.modelId)
    }
  }

  acceptStageReport(sender: WebContents, report: Live2dStageReport): void {
    const window = this.requireCurrentWindow(sender)
    if (this.stageInstanceId !== report.stageInstanceId) throw invalidStageInstance()

    this.status = report.status
    this.lastReport = report
    if (report.status === 'ready') {
      // 一次成功 ready = 崩溃序列结束；后续再崩仍允许一次重建（§1.7.7 有界的是「连续」）
      this.crashRebuilds = 0
      this.deps.onPerformanceReport?.(sender, report)
      this.loadedModelId = this.activeModelId
      // P3B-15：audio-only 宿主永远不显示（屏幕上看不见她，声音仍由 PlaybackHost 播放）。
      if (!this.audioOnly && !window.isDestroyed() && !window.isVisible()) {
        try {
          // show 事件会统一走 scheduleStageResume()：先让 Chromium 提交可见状态，
          // 再由 stage 显式恢复唯一的 Pixi ticker。
          window.show()
        } catch {
          // stage 在状态上报与 show 之间关闭时，保持不可见并等待下一次显式打开。
        }
      }
      this.deps.onStateChange?.()
      return
    }
    if (report.status === 'error') {
      this.deps.onStateChange?.()
      this.advanceFallback()
    }
  }

  sendStageCommand(command: Live2dStageCommand): void {
    const window = this.window
    if (window === null || window.isDestroyed() || this.stageInstanceId === null) return
    const send =
      this.deps.sendStageCommand ??
      ((wc, payload) => sendEvent(wc, 'companion:event:stage-command', payload))
    try {
      send(window.webContents, command)
    } catch {
      // 窗口可能在 isDestroyed() 检查之后被销毁；stage 命令是尽力而为，
      // 绝不能让一条渲染指令变成 main 的未捕获异常。
    }
  }

  getSnapshot(): Live2dWindowSnapshot {
    return this.snapshot()
  }

  getLastReport(): Live2dStageReport | null {
    return this.lastReport
  }

  /**
   * P3A-12：失败后只推进一次确定的链，绝不无限重试。stage 保留旧模型的 swap 语义在
   * renderer 内；这里仅选择下一份受控 manifest URL。最终耗尽则维持 error 给 UI 恢复入口。
   */
  private advanceFallback(): void {
    const plan = this.loadPlan
    if (plan === null) return
    for (let index = this.pendingLoadAttemptIndex + 1; index < plan.attempts.length; index++) {
      const attempt = plan.attempts[index]!
      const modelUrl =
        this.deps.getLoadAttemptUrl?.(index) ?? this.deps.getStageModelUrl(attempt.modelId)
      if (modelUrl === null) continue
      this.pendingLoadAttemptIndex = index
      this.activeModelId = attempt.modelId
      this.status = 'loading-model'
      this.deps.onStateChange?.()
      this.sendStageCommand(this.loadModelCommand(attempt.modelId, modelUrl))
      return
    }
    // No remaining candidate: stage remains in error; chat window stays independent and usable.
    this.status = 'error'
    this.deps.onStateChange?.()
  }

  /** Request a model by public id; the manager resolves the URL and keeps loadedModelId pending until ready. */
  requestModelLoad(modelId: string): boolean {
    const window = this.window
    if (window === null || window.isDestroyed() || this.stageInstanceId === null) return false
    const modelUrl = this.deps.getStageModelUrl(modelId)
    if (modelUrl === null) return false
    this.loadPlan = this.deps.getModelLoadPlan()
    this.pendingLoadAttemptIndex = 0
    this.activeModelId = modelId
    this.status = 'loading-model'
    this.deps.onStateChange?.()
    this.sendStageCommand(this.loadModelCommand(modelId, modelUrl))
    return true
  }

  /**
   * 换模型必须连 expression 名单一起送。stage 的 alias 解析只认收到的那一份，而 bootstrap
   * 里那份是**首次尝试**模型的——降级或用户切换后它就过期了，不更新会让表情静默失效。
   */
  private loadModelCommand(modelId: string, modelUrl: string): Live2dStageCommand {
    this.modelsLoadedThisSession++
    const expressionNames = this.deps.getModelExpressionNames?.(modelId)
    return expressionNames === undefined
      ? { type: 'load-model', modelUrl }
      : { type: 'load-model', modelUrl, expressionNames }
  }

  /** P3A-28：内存预算只在「单模型稳态」（本值 ≤1）下判定。 */
  getModelsLoadedThisSession(): number {
    return this.modelsLoadedThisSession
  }

  private scheduleStageResume(): void {
    if (this.resumeTimer !== null) clearTimeout(this.resumeTimer)
    const scheduleResume =
      this.deps.scheduleResume ??
      ((callback: () => void) => {
        this.resumeTimer = setTimeout(callback, 0)
      })
    scheduleResume(() => {
      this.resumeTimer = null
      this.sendStageCommand({ type: 'resume' })
    })
  }

  private requireCurrentWindow(sender: WebContents): ManagedStageWindow {
    const window = this.window
    if (window === null || window.isDestroyed() || window.webContents.id !== sender.id) {
      throw invalidStageInstance()
    }
    return window
  }

  private releaseWindow(window: ManagedStageWindow): void {
    if (this.window !== window) return
    if (this.resumeTimer !== null) clearTimeout(this.resumeTimer)
    this.resumeTimer = null
    if (this.crashRebuildTimer !== null) clearTimeout(this.crashRebuildTimer)
    this.crashRebuildTimer = null
    this.crashRebuilds = 0
    this.deps.cancelScheduledResume?.()
    // 'closed' 触发时 BrowserWindow 已销毁，此时读 window.webContents 会抛
    // "Object has been destroyed"——那是 main 的未捕获异常，会弹致命错误框并占住
    // 单实例锁。因此用建窗时记下的 id 注销能力，绝不在销毁后回查 webContents。
    if (this.webContentsId !== null) this.deps.onStageDestroyed(this.webContentsId)
    this.webContentsId = null
    // 窗口没了，预览也就没有承载体；不清标志会让下一个 stage 永远收不到 config 变更。
    this.previewing = false
    this.audioOnly = false
    this.window = null
    this.stageInstanceId = null
    this.status = 'closed'
    this.lastReport = null
    this.loadPlan = null
    this.pendingLoadAttemptIndex = 0
    this.activeModelId = null
    this.loadedModelId = null
    this.deps.onStateChange?.()
  }

  private snapshot(): Live2dWindowSnapshot {
    const window = this.window
    return {
      stageInstanceId: this.stageInstanceId,
      status: this.status,
      visible: window !== null && !window.isDestroyed() && window.isVisible(),
      alwaysOnTop: this.alwaysOnTop,
      webContentsId: window !== null && !window.isDestroyed() ? this.webContentsId : null,
      loadedModelId: this.loadedModelId,
      audioOnly: this.audioOnly
    }
  }
}

function normalizeZoom(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(3, Math.max(0.25, value))
}

function normalizeOffset(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(-100, value))
}

function invalidStageInstance(): AppError {
  return new AppError({
    code: 'IPC_VALIDATION',
    userMessage: 'Live2D 窗口状态已过期，请重试',
    severity: 'warn',
    retryable: true
  })
}
