// src/shared/live2d/stage-types.ts
// P3A-05/06：独立 Live2D stage 的最小跨进程合同。
//
// stage 不获得 chat/config/memory 权限，只接收当前实例的枚举命令与不含绝对路径的
// bootstrap DTO。模型实际资源 URL 由 main 生成；renderer 从不接收用户文件系统路径。

import type { Live2dSemanticEmotion } from './types'

export type Live2dStageStatus = 'starting' | 'loading-model' | 'ready' | 'degraded' | 'error'

export interface Live2dStageBootstrap {
  readonly stageInstanceId: string
  readonly status: Live2dStageStatus
  /** main 受控模型资源 URL；不得是绝对用户路径。 */
  readonly initialModelUrl: string | null
  /** main 受控 Cubism Core runtime URL；随包资源，绝不使用 CDN。 */
  readonly cubismCoreUrl: string | null
  /** legacy Cubism 2 runtime URL required by the fork's combined bundle; may be null. */
  readonly cubism2Url?: string | null
  /** 受 ui.live2d.zoom 约束的初始模型缩放；main/config 是唯一真源。 */
  readonly zoom: number
  /** 初始取景偏移（画布百分比，-100..100）；与 zoom 同为 main/config 单真源。 */
  readonly offsetX: number
  readonly offsetY: number
  /** 仅模型元数据；不含路径，供 stage expression alias 解析。 */
  readonly expressionNames?: readonly string[]
}

export interface Live2dStageReadyRequest {
  readonly stageInstanceId: string
}

export interface Live2dStageReport {
  readonly stageInstanceId: string
  readonly status: Live2dStageStatus
  readonly fps?: number
  readonly modelLoadMs?: number
  /** 仅固定错误码，永不携带错误 stack / 路径 / 模型正文。 */
  readonly errorCode?: string
}

export type Live2dStageCommand =
  /**
   * 换模型必须同时带上新模型的 expression 名单。stage 的 alias 解析只认这一份名单，
   * 而 bootstrap 里那份属于**首次尝试**的模型——降级或用户切换之后它就过期了，
   * 不随命令更新会让表情静默失效（2026-08-29 真机实测：首选模型损坏 → 降级 Mao 后
   * 名单仍是损坏模型的空数组，任何情绪都解析不到）。
   */
  | { readonly type: 'load-model'; readonly modelUrl: string; readonly expressionNames?: readonly string[] }
  | { readonly type: 'set-emotion'; readonly emotion: Live2dSemanticEmotion }
  | { readonly type: 'set-zoom'; readonly zoom: number }
  | { readonly type: 'set-offset'; readonly offsetX: number; readonly offsetY: number }
  | { readonly type: 'resize'; readonly width: number; readonly height: number }
  | { readonly type: 'pause' }
  | { readonly type: 'resume' }
  | { readonly type: 'dispose' }
