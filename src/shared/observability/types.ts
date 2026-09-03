// src/shared/observability/types.ts
// 可观测性类型契约 + 固定常量（SCRUB_RULES、ERROR_POLICY）
// 依据：F5-011 §3

import type { ErrorCode } from '../errors'

/** 日志级别。数字越小越严重 */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug'

/**
 * 日志字段白名单。隐私红线的类型层实现：
 * 聊天正文/记忆内容/音频没有合法的字段可放。
 */
export interface LogFields {
  /** 模块名，如 'llm' | 'tts' | 'memory' | 'live2d' | 'ipc' */
  scope: string
  /** 机器可读错误码 */
  code?: ErrorCode
  /** 关联的追踪 ID */
  turnId?: string
  /** 数值类上下文：耗时、长度、计数。值只允许 number/boolean */
  metrics?: Record<string, number | boolean>
  /** 枚举/ID 类上下文：模型名、provider、状态。值只允许短字符串（≤64 字符） */
  tags?: Record<string, string>
  /**
   * 自由文本。唯一允许自由字符串的字段，写入前强制过 scrub()。
   * 禁止把 userMessage/assistantReply/记忆 content 传进来。
   */
  detail?: string
}

export interface Logger {
  fatal(msg: string, fields: LogFields): void
  error(msg: string, fields: LogFields): void
  warn(msg: string, fields: LogFields): void
  info(msg: string, fields: LogFields): void
  debug(msg: string, fields: LogFields): void
  /** 创建带固定 scope 的子 logger */
  child(scope: string): Logger
}

// === 脱敏管道（写盘前最后一道，对 msg 和 detail 生效）===

export interface ScrubRule {
  name: string
  pattern: RegExp // 必须带 g flag
  replacement: string
}

/** 初版脱敏规则集，按序应用。依据 F5-011 §3 */
export const SCRUB_RULES: ScrubRule[] = [
  { name: 'openai-key', pattern: /sk-[A-Za-z0-9_-]{8,}/g, replacement: '<api-key>' },
  {
    name: 'bearer',
    pattern: /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
    replacement: 'Bearer <token>'
  },
  {
    name: 'generic-key',
    pattern: /(api[_-]?key|token|secret)["'\s:=]+\S{8,}/gi,
    replacement: '$1=<redacted>'
  },
  {
    name: 'win-userpath',
    pattern: /[A-Z]:\\Users\\[^\\/\s"']+/g,
    replacement: 'C:\\Users\\<user>'
  },
  {
    name: 'unix-home',
    pattern: /\/(home|Users)\/[^/\s"']+/g,
    replacement: '/$1/<user>'
  },
  {
    name: 'data-uri',
    pattern: /data:[\w/+.-]+;base64,[A-Za-z0-9+/=]{64,}/g,
    replacement: '<data-uri>'
  },
  {
    name: 'long-base64',
    pattern: /[A-Za-z0-9+/]{256,}={0,2}/g,
    replacement: '<base64>'
  },
  {
    name: 'email',
    pattern: /[\w.+-]+@[\w-]+\.[\w.]+/g,
    replacement: '<email>'
  },
  {
    name: 'cn-mobile',
    pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
    replacement: '<phone>'
  },
  {
    name: 'url-query',
    pattern: /(https?:\/\/[^\s?"']+)\?[^\s"']*/g,
    replacement: '$1?<query>'
  }
]

/** 各级别处理策略（固定表，不做配置项）。依据 F5-011 §3 */
export const ERROR_POLICY = {
  fatal: { file: true, panel: true, user: 'dialog', crash: 'minidump+offer-restart' },
  error: { file: true, panel: true, user: 'toast-if-user-action' },
  warn: { file: true, panel: true, user: 'none' },
  info: { file: true, panel: false, user: 'none' },
  debug: { file: 'dev-only', panel: false, user: 'none' }
} as const

// === 指标层 ===

/** 指标名注册表（新增指标 = 加一行，禁止裸字符串） */
export type MetricName =
  | 'llm.calls'
  | 'llm.errors'
  | 'llm.latencyMs'
  | 'llm.ttfbMs'
  | 'llm.tokens.in'
  | 'llm.tokens.out'
  | 'tts.synth.calls'
  | 'tts.synth.latencyMs'
  | 'tts.cache.hit'
  | 'tts.cache.miss'
  // ── P3B-21（F5-007 §1.17 冻结清单）：早期播放收益与降级观测 ──
  | 'tts.early.turns'
  | 'tts.early.committed'
  | 'tts.early.played'
  | 'tts.early.firstCommitMs'
  | 'tts.early.firstAudioMs'
  | 'tts.early.selfCorrections'
  | 'tts.early.textOnlyFallbacks'
  | 'tts.early.queueHighWater'
  // ── P3B-19/21：barge-in、文字绘制→音频开始偏差与 ASR 资源基线 ──
  | 'voice.bargeIn.latencyMs'
  | 'voice.paintToAudioMs'
  | 'asr.latencyMs'
  | 'asr.errors'
  /** main 进程承载本地 ASR，采样识别引擎就绪后的进程 RSS（含 native 分配）。 */
  | 'asr.processRssMb'
  | 'memory.l2.count'
  | 'memory.extract.candidates'
  | 'memory.conflicts'
  | 'dmae.active'
  | 'dmae.dormant'
  | 'dmae.archived'
  | 'live2d.fps'
  | 'live2d.modelLoadMs'
  | 'live2d.firstFrameMs'
  | 'live2d.renderMemoryMb'
  | 'live2d.idleCpuPercent'
  | 'ipc.errors'
  | 'app.uptimeSec'
  // F5-001 §3.9 合规审查 12 条（P3C1-03 枚举落地；打点随 gate/circuit/auditor/feedback 各任务）
  | 'compliance.gate.checks'
  | 'compliance.gate.blocks'
  | 'compliance.gate.strips'
  | 'compliance.gate.flags'
  | 'compliance.gate.regenerations'
  | 'compliance.gate.degradedPass'
  | 'compliance.gate.degraded'
  | 'compliance.gate.circuitOpen'
  | 'compliance.gate.latencyMs'
  | 'compliance.audit.runs'
  | 'compliance.audit.violations'
  | 'compliance.userDislike'
  // P3C1-06 审计侧补充：§3.6 失败表/交叉校验显式命名的两条（§3.9 枚举未列）+ §3.9「审计耗时进 histogram」
  | 'compliance.audit.dropped'
  | 'compliance.audit.disagreement'
  | 'compliance.audit.latencyMs'

export interface MetricsRegistry {
  counter(name: MetricName): { inc(n?: number): void; value(): number }
  gauge(name: MetricName): { set(v: number): void; value(): number }
  /** 固定桶直方图，保留 count/sum/p50/p95/max */
  histogram(name: MetricName, bucketsMs?: number[]): { observe(v: number): void }
  snapshot(): Record<string, number>
}

// === 追踪层 ===

export interface TraceSpan {
  name:
    | 'sanitize'
    | 'prompt.build'
    | 'llm.call'
    | 'compliance.review'
    | 'memory.extract'
    | 'tts.synth'
    | 'ui.render'
    | `hook.${string}`
  startMs: number // 相对 turn 开始
  durationMs: number
  ok: boolean
  code?: ErrorCode
}

/** 一轮对话的完整追踪。环形缓冲保留最近 20 条 */
export interface TurnTrace {
  turnId: string // ULID，chat.message hook 入口生成
  startedAt: number // epoch ms
  spans: TraceSpan[]
  totalMs?: number
  inputLen: number // 消息长度（字符数），不是内容
  outputLen?: number
}

// === 调试面板 IPC 契约 ===

/** IPC: 'companion:debug:get-snapshot' 返回。依据 F5-011 §3 */
export interface DebugSnapshot {
  appVersion: string
  uptimeSec: number
  metrics: Record<string, number>
  recentTraces: TurnTrace[] // ≤20
  recentErrors: Array<{ ts: number; level: LogLevel; code?: ErrorCode; msg: string }> // ≤50，已脱敏
  logFilePath: string
  circuit: { state: 'closed' | 'open' | 'half-open'; provider: string } | null
  offline: { state: string } | null // F5-012 状态机接入点，Phase 2+ 填充
}

// === 崩溃处理 ===

export interface CrashContext {
  processType: 'main' | 'renderer'
  reason: string // uncaughtException message（已脱敏）/ render-gone reason
  ts: number
  appVersion: string
  uptimeSec: number
  lastLogLines: string[] // 最近 50 行（已脱敏，从内存环形缓冲取）
}
