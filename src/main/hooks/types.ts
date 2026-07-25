// src/main/hooks/types.ts
// Hook 类型定义：HookFn、HookContext、HookPriority、HookRegistration
// 依据：S-001 P1-13、S-004 #33-#34

/**
 * Hook 优先级。数字越小越先执行。
 *
 * ⚠️ 方向说明：技术分析 §2.5 描述的 OpenClaw 原始约定是"数字越大越先执行"（降序）。
 * 本项目采用相反的升序约定（数字越小越先执行），因为"100 = 最高优先级"更符合
 * 常见的优先级直觉（如 nice 值、HTTP 状态码类别）。两者效果等价：sanitize(100)
 * 始终在 default(200) 之前执行。S-004 #33 测试"priority 高者先执行"在此约定下
 * 通过（100 为高优先级）。
 *
 * 预定义优先级：
 *   100     - 安全/基础设施 hook（sanitize 等，最早执行）
 *   101-199 - 业务预处理 hook
 *   200-299 - 后处理 hook
 *   300+    - 可观测性/审计 hook
 */
export type HookPriority = number

/** 预定义优先级常量 */
export const HookPriority = {
  /** 安全消毒（sanitize-message），最早执行 */
  SANITIZE: 100,
  /** 默认优先级 */
  DEFAULT: 200
} as const

/** Hook 执行上下文 */
export interface HookContext {
  /** 生命周期事件名，如 'chat.message'、'chat.params'、'turn.end' */
  event: string
  /** 关联的 turn ID */
  turnId?: string
  /** 扩展字段 */
  [key: string]: unknown
}

/** Hook 返回结果 */
export interface HookResult {
  /** 转换后的数据（undefined = 不修改 data） */
  data?: unknown
  /** 为 true 时短路后续 hook，runner 立即返回当前 data */
  shouldStop?: boolean
}

/** Hook 函数签名。data 为 unknown，调用方/runner 负责类型安全 */
export type HookFn = (ctx: HookContext, data: unknown) => HookResult | Promise<HookResult>

/** Hook 注册项 */
export interface HookRegistration {
  /** 全局唯一名称，用于注销和调试 */
  name: string
  /** 绑定的事件名 */
  event: string
  /** 优先级（数字越小越先执行） */
  priority: HookPriority
  /** hook 函数 */
  fn: HookFn
  /**
   * 失败策略：true = hook 抛异常时继续执行后续 hook（fail-open）。
   * 默认 false = 抛异常即中止 runner（fail-closed）。
   */
  failOpen?: boolean
}

/** Hook 运行结果 */
export interface HookRunResult<T = unknown> {
  /** 最终 data（可能被多个 hook 依次转换） */
  data: T
  /** 是否被短路 */
  stopped: boolean
  /** 收集到的错误（failOpen hook 抛出的） */
  errors: Error[]
}
