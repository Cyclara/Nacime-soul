// src/main/hooks/registry.ts
// Hook 注册表：register/unregister/getHooks
// 依据：S-001 P1-13、S-004 #33 "相同 priority 保持注册顺序"

import type { HookRegistration } from './types'

/** 全局 hook 注册表 */
const hooks: HookRegistration[] = []

/**
 * 注册 hook。若同名同事件 hook 已存在，先移除旧的再注册新的。
 * 这是 HMR 安全设计：重复注册不产生重复执行。
 */
export function registerHook(reg: HookRegistration): void {
  // 移除同名同事件的旧 hook（HMR 安全）
  const idx = hooks.findIndex((h) => h.name === reg.name && h.event === reg.event)
  if (idx >= 0) {
    hooks.splice(idx, 1)
  }
  hooks.push(reg)
}

/**
 * 注销指定名称和事件的 hook。不存在时静默成功。
 */
export function unregisterHook(name: string, event: string): void {
  const idx = hooks.findIndex((h) => h.name === name && h.event === event)
  if (idx >= 0) {
    hooks.splice(idx, 1)
  }
}

/**
 * 获取指定事件的所有 hook，按优先级升序排列（数字越小越先执行）。
 * 相同优先级保持注册顺序（stable sort）。
 * 依据 S-004 #33。
 */
export function getHooks(event: string): HookRegistration[] {
  return hooks.filter((h) => h.event === event).sort((a, b) => a.priority - b.priority)
}

/** 清空所有 hook（仅测试使用） */
export function clearHooks(): void {
  hooks.length = 0
}

/** 当前注册的 hook 数量（仅测试/调试使用） */
export function hookCount(): number {
  return hooks.length
}
