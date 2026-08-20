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
// P2（2026-08-10 审计）：状态按 turnId 键控（inflight Map + 有界 ring）。
// 修复前单例 currentTurnId/currentSpans，跨会话并发 streaming 时后到者顶掉前者，
// A 的 spans/end 被记到 B 的 trace -> 调试面板 timing 误导（F5-011 §4 完整归属要求）。
// 现在每个 turnId 一条独立 inflight 记录；span 句柄绑定其所属 turn。
//
// 隐私纪律（F5-011）：TraceSpan 不含消息内容，只记 name/耗时/ok/code。inputLen/outputLen 是长度不是内容。

import { performance } from 'node:perf_hooks'
import type { TraceSpan, TurnTrace } from '@shared/observability/types'
import { isAppError } from '@shared/errors'

/** 环形缓冲容量。F5-011 §3 "保留最近 20 条" */
const TRACE_BUFFER_SIZE = 20

/** inflight 并发上界（多会话并发 streaming 的保守上限；超出丢弃最老） */
const MAX_INFLIGHT_TRACES = 20

/** TurnTracer 接口 */
export interface TurnTracer {
  /** 开始一轮 trace。同一 turnId 重复 begin 视为重置（幂等）。 */
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
   * turnId 可选：并发场景必须传（否则附着到最近 begin 的 turn）。
   */
  startSpan(name: TraceSpan['name'], turnId?: string): SpanHandle
  /** 结束一轮 trace。计算 totalMs，推入环形缓冲。turnId 可选（并发场景必须传）。 */
  endTurn(outputLen: number, turnId?: string): void
  /** 返回最近 N 条 trace（≤20，旧->新） */
  snapshot(): TurnTrace[]
}

/** startSpan 返回的句柄 */
export interface SpanHandle {
  /** 结束 span。ok 默认 true；抛错时传 false + code */
  end(ok?: boolean, code?: TraceSpan['code']): void
}

/** 一条进行中的 trace 记录 */
interface InflightTrace {
  startedAt: number
  inputLen: number
  /** performance.now() 基准（turn 开始时） */
  base: number
  spans: TraceSpan[]
}

class TurnTracerImpl implements TurnTracer {
  private readonly buffer: TurnTrace[] = []
  /** turnId -> inflight trace（多会话并发互不干扰） */
  private readonly inflight = new Map<string, InflightTrace>()
  /** 最近 begin 的 turnId（无参 span/endTurn 的回退目标；单会话行为兼容） */
  private mostRecentTurnId: string | null = null

  beginTurn(turnId: string, inputLen: number): void {
    this.inflight.set(turnId, {
      startedAt: Date.now(),
      inputLen,
      base: performance.now(),
      spans: []
    })
    this.mostRecentTurnId = turnId
    // 有界：并发 inflight 超上限丢弃最老（孤儿 turn 不会无限堆积）
    while (this.inflight.size > MAX_INFLIGHT_TRACES) {
      const oldest = this.inflight.keys().next().value
      if (oldest === undefined) break
      this.inflight.delete(oldest)
    }
  }

  async span<T>(name: TraceSpan['name'], fn: () => T | Promise<T>): Promise<T> {
    const entry = this.currentEntry()
    const startMs = performance.now() - (entry?.base ?? 0)
    let ok = true
    let code: TraceSpan['code']
    try {
      return await fn()
    } catch (e) {
      ok = false
      code = isAppError(e) ? e.code : undefined
      throw e
    } finally {
      const durationMs = performance.now() - (entry?.base ?? 0) - startMs
      const span: TraceSpan = {
        name,
        startMs,
        durationMs,
        ok,
        ...(code !== undefined ? { code } : {})
      }
      // 未 beginTurn 时也记（诊断），但无归属 trace
      if (entry) entry.spans.push(span)
    }
  }

  startSpan(name: TraceSpan['name'], turnId?: string): SpanHandle {
    const entry = this.entryFor(turnId)
    const startMs = performance.now() - (entry?.base ?? 0)
    let ended = false
    // 箭头函数捕获 this + entry，避免 no-this-alias
    const end = (ok = true, code?: TraceSpan['code']): void => {
      if (ended) return
      ended = true
      const durationMs = performance.now() - (entry?.base ?? 0) - startMs
      const span: TraceSpan = {
        name,
        startMs,
        durationMs,
        ok,
        ...(code !== undefined ? { code } : {})
      }
      if (entry) entry.spans.push(span)
    }
    return { end }
  }

  endTurn(outputLen: number, turnId?: string): void {
    const id = turnId ?? this.mostRecentTurnId
    if (id === null) return
    const entry = this.inflight.get(id)
    if (!entry) return
    const totalMs = performance.now() - entry.base
    const trace: TurnTrace = {
      turnId: id,
      startedAt: entry.startedAt,
      spans: entry.spans,
      totalMs,
      inputLen: entry.inputLen,
      outputLen
    }
    this.buffer.push(trace)
    if (this.buffer.length > TRACE_BUFFER_SIZE) {
      this.buffer.shift()
    }
    // 清掉该 turn 的 inflight 记录（不影响其他并发 turn）
    this.inflight.delete(id)
    if (this.mostRecentTurnId === id) this.mostRecentTurnId = null
  }

  snapshot(): TurnTrace[] {
    return this.buffer.map((t) => ({ ...t, spans: [...t.spans] }))
  }

  /** 无参 span() 的回退目标：最近 begin 的 turn；无则 null */
  private currentEntry(): InflightTrace | null {
    if (this.mostRecentTurnId === null) return null
    return this.inflight.get(this.mostRecentTurnId) ?? null
  }

  /** startSpan 的归属：显式 turnId 优先，否则最近 begin 的 turn */
  private entryFor(turnId?: string): InflightTrace | null {
    if (turnId !== undefined) return this.inflight.get(turnId) ?? null
    return this.currentEntry()
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
