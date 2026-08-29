// src/renderer/src/live2d/ILive2DRenderer.ts
// P3A-02：Live2D 渲染器可替换边界。
//
// 业务/StageController 只能依赖本接口，不能把 Pixi、Cubism 或 fork 的对象泄漏到
// 上层。若 pixi-live2d-display-lipsyncpatch 停维护，只替换实现文件即可切换到
// 官方 Cubism SDK for Web。

import { LIVE2D_PARAMETER_IDS, type Live2DStandardParameterId } from '@shared/live2d/types'

export { LIVE2D_PARAMETER_IDS, type Live2DStandardParameterId }

export interface Live2DRendererFrame {
  /**
   * 本帧推进模型的真实时长。取自模型自己的动画时钟而非墙钟，因此窗口暂停/恢复后不会
   * 出现巨大 delta——暂停期间模型时钟本就不前进。
   */
  readonly deltaMs: number
  /** 单调时钟；只用于运行时动画，绝不作为持久化时间。 */
  readonly nowMs: number
}

/**
 * 驱动 native motion 求值的帧回调。
 *
 * P3A-16 的 `pre → native → post → final` 由实现在**原生 motion 求值处**调用，而不是在
 * ticker 上：`nativeUpdate()` 执行渲染库原本的 motion 求值。这样 `post/final` 插件读到的
 * 才是本帧 motion 之后的参数值；插件写入随后被底层固化为下一帧基准，再由 expression、
 * focus、物理与 pose 叠加在其上。
 *
 * renderer 保持 native 求值的单一控制权：插件不得跳过它（P3A-16 冻结条款），driver 抛错时
 * fail-open 补跑且整帧只跑一次。
 */
export type Live2DFrameDriver = (frame: Live2DRendererFrame, nativeUpdate: () => void) => void

/** 供 main/调试面板投影的纯数值运行指标；不携带模型路径或任何用户数据。 */
export interface Live2DRendererMetrics {
  readonly fps: number
  readonly frameCount: number
  readonly modelLoadMs: number | null
  readonly contextLossCount: number
  readonly paused: boolean
  readonly hasModel: boolean
}

/**
 * 取景参数。`zoom` 是相对归一化基准的缩放；`offsetX/offsetY` 是画布尺寸百分比
 * （-100..100），正 X 右移、正 Y 上移。用百分比而非像素，使窗口缩放后构图不变。
 */
export interface Live2DViewLayout {
  readonly zoom: number
  readonly offsetX: number
  readonly offsetY: number
}

export interface Live2DParameterUpdate {
  readonly id: string
  readonly value: number
  /** 由底层 Cubism 参数 API 解释的混合权重；缺省表示直接设置。 */
  readonly weight?: number
  /** set 覆盖当前值；multiply 叠加表达层，不复制模型默认值。 */
  readonly blend?: 'set' | 'multiply'
}

/**
 * 渲染引擎的唯一业务边界。
 *
 * 生命周期为 `attach → load/unload* → dispose`。`load()` 成功前不会销毁已显示模型，
 * 使后续模型切换可以维持旧模型可见；`dispose()` 后所有其他操作都是无效调用。
 */
export interface ILive2DRenderer {
  attach(canvas: HTMLCanvasElement): void
  load(manifestUrl: string): Promise<void>
  unload(): void
  resize(width: number, height: number): void
  setZoom(zoom: number): void
  /** 只改取景偏移，不动 zoom；用于「上半身/全身」这类构图调整。 */
  setOffset(offsetX: number, offsetY: number): void
  pause(): void
  resume(): void
  setFrameDriver(driver: Live2DFrameDriver | null): void
  addMotionPlugin?(plugin: {
    readonly id: string
    readonly priority: number
    readonly phases: readonly ('pre' | 'post' | 'final')[]
    onFrame(context: {
      readonly frame: Live2DRendererFrame
      readonly phase: 'pre' | 'post' | 'final'
      readonly handled: boolean
      markHandled(): void
    }): void
    dispose?(): void
  }): void
  setExpression(expression: string): Promise<boolean>
  playMotion(group: string, index?: number): Promise<boolean>
  setParameter(update: Live2DParameterUpdate): boolean
  setMouthOpen(value: number): boolean
  setEyeOpen(value: number): boolean
  hitTest(x: number, y: number): readonly string[]
  getMetrics(): Live2DRendererMetrics
  dispose(): void
}
