// src/shared/live2d/performance.ts
// P3A-28：Live2D 性能门的纯数据评估；采样本身不写用户内容。
//
// 放在 shared 而非 renderer：fps/首帧来自 stage 报告，内存/CPU 只有 main 能通过
// app.getAppMetrics() 拿到，两侧要用同一套预算判定，判定结果由 main 落 warn 日志。

export interface Live2dPerformanceSample {
  readonly fps: number
  readonly idleCpuPercent: number | null
  readonly renderMemoryMb: number | null
  readonly firstFrameMs: number | null
  readonly visible: boolean
  /**
   * 本次会话已加载过的模型次数（含降级链里的每一次尝试）。
   *
   * 内存预算只在「单模型稳态」下判定，因此需要这个计数：换过模型之后，进程常驻会包含
   * 上一个模型延迟释放的 GPU 纹理，以及 Cubism Core 那块**只能增长、不能还给系统**的
   * WASM 线性内存。2026-08-29 实测 Mao↔Hiyori 各 8 次切换：稳态 131–132MB，切换后 175MB。
   * 参考项目（AIRI / Cyrene-Agent）的释放做法都不比我们更彻底，没有可补的释放动作。
   */
  readonly modelsLoadedThisSession: number
}

export interface Live2dPerformanceBudget {
  readonly minimumFps: number
  readonly maximumRenderMemoryMb: number
  readonly maximumFirstFrameMs: number
  readonly maximumIdleCpuPercent: number
}

/**
 * P3A-28 目标值。**内存一项的口径为「单模型稳态 ≤150MB」**（2026-08-29 用户裁定）：
 * S-Phase3 P3A-28 原文只写「≤150MB」未限定时机，但实测换模型后必然超标而又无从修复，
 * 按原口径会在用户每次换装时长期误报、把真回归淹掉。切换后的峰值仍进 gauge 留基线，
 * 只是不判失败。偏离登记见 `docs/contracts/shared-types-ledger.md` §4 附注。
 */
export const DEFAULT_LIVE2D_PERFORMANCE_BUDGET: Live2dPerformanceBudget = {
  minimumFps: 30,
  maximumRenderMemoryMb: 150,
  maximumFirstFrameMs: 3_000,
  maximumIdleCpuPercent: 5
}

export type Live2dPerformanceCheck = 'fps' | 'memory' | 'firstFrame' | 'idleCpu'

export interface Live2dPerformanceResult {
  readonly ok: boolean
  readonly checks: Readonly<Record<Live2dPerformanceCheck, boolean | null>>
}

export function evaluateLive2dPerformance(
  sample: Live2dPerformanceSample,
  budget: Live2dPerformanceBudget = DEFAULT_LIVE2D_PERFORMANCE_BUDGET
): Live2dPerformanceResult {
  // 换过模型后不判内存：残留量来自延迟释放的纹理与不可收缩的 WASM 堆，既非回归也无从修复。
  // 仍然照常上报 gauge 留基线，只是这一项记为「未测量」而不是「未达标」。
  const singleModelSteadyState = sample.modelsLoadedThisSession <= 1
  const checks = {
    fps: sample.visible ? sample.fps >= budget.minimumFps : null,
    memory:
      sample.renderMemoryMb === null || !singleModelSteadyState
        ? null
        : sample.renderMemoryMb <= budget.maximumRenderMemoryMb,
    firstFrame:
      sample.firstFrameMs === null ? null : sample.firstFrameMs <= budget.maximumFirstFrameMs,
    idleCpu:
      sample.idleCpuPercent === null ? null : sample.idleCpuPercent <= budget.maximumIdleCpuPercent
  }
  const measured = Object.values(checks).filter((check): check is boolean => check !== null)
  return { ok: measured.length > 0 && measured.every(Boolean), checks }
}

/**
 * 只列出**测量过且超预算**的项。未测量项（null）不算未达标，避免“窗口隐藏 = 性能不合格”
 * 这类假报警把真实回归淹掉。
 */
export function failedLive2dPerformanceChecks(
  result: Live2dPerformanceResult
): readonly Live2dPerformanceCheck[] {
  return (Object.keys(result.checks) as Live2dPerformanceCheck[]).filter(
    (check) => result.checks[check] === false
  )
}
