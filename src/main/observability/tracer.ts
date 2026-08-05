// src/main/observability/tracer.ts
// P2-27: TurnTracer 实现--每轮对话的 span 追踪 + 环形缓冲 20 条。
// 依据：F5-011 §3（TraceSpan/TurnTrace）、§2（"TurnTrace 是一个数组加时间戳"）、§5（durationMs 用 performance.now）。
//
// 设计要点：
//   1. beginTurn(turnId, inputLen) -> span(name, fn) * N -> endTurn(outputLen)
//   2. span 自动记 startMs/durationMs/ok/code（try/catch/finally，不吞错，重新抛）
//   3. startMs 相对 turn 开始（F5-011 §3 TraceSpan.startMs）；用 performance.now() 算相对时间
//   4. startedAt 用 Date.now()（epoch ms，F5-011 §3 TurnTrace.startedAt）
//   5. 环形缓冲 20 条（F5-011 §3 "保留最近 20 条"）；溢出丢弃最旧
//   6. 败而不崩：span 抛错记 ok=false + code 后重新抛（不影响主流程的错误传播）
//   7. 不订阅 hook runner（当前 runner 无 started/response 事件）；ChatService 主动调 span()
//
// 隐私纪律（F5-011）：TraceSpan 不含消息内容，只记 name/耗时/ok/code。inputLen/outputLen 是长度不是内容。

import { performance } from 'node:perf_hooks'
import type { TraceSpan, TurnTrace } from '@shared/observability/types'
import { isAppError } from '@shared/errors'

/** 环形缓冲容量。F5-011 §3 "保留最近 20 条" */
const TRACE_BUFFER_SIZE = 20

/** TurnTracer 接口 */
export interface TurnTracer {
  /** 开始一轮 trace。清空当前 spans，记录 startedAt + inputLen */
  beginTurn(turnId: string, inputLen: number): void
  /**
   * 包装一个 span。自动记 startMs/durationMs/ok/code。
   * fn 抛错时记 ok=false + code 后重新抛（不吞错）。
   * 未 beginTurn 就调 span 时，span 仍记但 startMs 基准为 0（诊断用）。
   */
  span<T>(name: TraceSpan['name'], fn: () => T | Promise<T>): Promise<T>
  /**
   * 手动 span：startSpan -> 业务代码 -> handle.end()。
   * 用于不便用 span() 包装的场景（如流式循环、跨函数 span）。
   * 必须在 endTurn 前调 end()，否则 span 不入 trace。
   */
  startSpan(name: TraceSpan['name']): SpanHandle
  /** 结束一轮 trace。计算 totalMs，推入环形缓冲 */
  endTurn(outputLen: number): void
  /** 返回最近 N 条 trace（≤20，旧->新） */
  snapshot(): TurnTrace[]
}

/** startSpan 返回的句柄 */
export interface SpanHandle {
  /** 结束 span。ok 默认 true；抛错时传 false + code */
  end(ok?: boolean, code?: TraceSpan['code']): void
}

class TurnTracerImpl implements TurnTracer {
  private readonly buffer: TurnTrace[] = []
  private currentTurnId: string | null = null
  private currentStartedAt = 0
  private currentInputLen = 0
  /** performance.now() 基准（turn 开始时） */
  private currentBase = 0
  private currentSpans: TraceSpan[] = []

  beginTurn(turnId: string, inputLen: number): void {
    this.currentTurnId = turnId
    this.currentStartedAt = Date.now()
    this.currentInputLen = inputLen
    this.currentBase = performance.now()
    this.currentSpans = []
  }

  async span<T>(name: TraceSpan['name'], fn: () => T | Promise<T>): Promise<T> {
    const startMs = performance.now() - this.currentBase
    let ok = true
    let code: TraceSpan['code']
    try {
      return await fn()
    } catch (e) {
      ok = false
      code = isAppError(e) ? e.code : undefined
      throw e
    } finally {
      const durationMs = performance.now() - this.currentBase - startMs
      const span: TraceSpan = {
        name,
        startMs,
        durationMs,
        ok,
        ...(code !== undefined ? { code } : {})
      }
      // 未 beginTurn 时也记（诊断），但 turnId 为 null
      this.currentSpans.push(span)
    }
  }

  startSpan(name: TraceSpan['name']): SpanHandle {
    const startMs = performance.now() - this.currentBase
    let ended = false
    // 箭头函数捕获 this，避免 no-this-alias
    const end = (ok = true, code?: TraceSpan['code']): void => {
      if (ended) return
      ended = true
      const durationMs = performance.now() - this.currentBase - startMs
      const span: TraceSpan = {
        name,
        startMs,
        durationMs,
        ok,
        ...(code !== undefined ? { code } : {})
      }
      this.currentSpans.push(span)
    }
    return { end }
  }

  endTurn(outputLen: number): void {
    if (this.currentTurnId === null) return
    const totalMs = performance.now() - this.currentBase
    const trace: TurnTrace = {
      turnId: this.currentTurnId,
      startedAt: this.currentStartedAt,
      spans: this.currentSpans,
      totalMs,
      inputLen: this.currentInputLen,
      outputLen
    }
    this.buffer.push(trace)
    if (this.buffer.length > TRACE_BUFFER_SIZE) {
      this.buffer.shift()
    }
    // 重置当前轮
    this.currentTurnId = null
    this.currentStartedAt = 0
    this.currentInputLen = 0
    this.currentBase = 0
    this.currentSpans = []
  }

  snapshot(): TurnTrace[] {
    return this.buffer.map((t) => ({ ...t, spans: [...t.spans] }))
  }
}

/** 创建独立 TurnTracer 实例（测试用） */
export function createTracer(): TurnTracer {
  return new TurnTracerImpl()
}

// === 全局单例 ===

let globalTracer: TurnTracer | null = null

/** 配置全局 TurnTracer 单例。生产环境在 main 入口调用 */
export function configureTracer(tracer: TurnTracer): void {
  globalTracer = tracer
}

/** 获取全局 TurnTracer 单例。未配置时返回惰性创建的实例 */
export function getTracer(): TurnTracer {
  if (!globalTracer) {
    globalTracer = new TurnTracerImpl()
  }
  return globalTracer
}
