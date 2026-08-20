// @vitest-environment jsdom
// src/renderer/src/components/debug/DebugPanel.test.ts
// M-45 回归（2026-08-20）：调试面板不再按构建模式（import.meta.env.PROD）禁用——
// 权威门在 main 侧（app.isPackaged 时拒绝服务）；渲染层只在快照拿不到时保持隐藏。
// 旧实现：out/ 未打包直跑也是 PROD 构建，onMounted 早退连 keydown 都不注册，
// Ctrl+Shift+D 完全失效（"以前没问题"是因为当时跑 npm run dev，PROD=false）。

import { describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import DebugPanel from './DebugPanel.vue'
import type { DebugSnapshot } from '@shared/observability/types'

function makeSnapshot(): DebugSnapshot {
  return {
    appVersion: '1.0.0-test',
    uptimeSec: 61,
    metrics: {},
    recentTraces: [],
    recentErrors: [],
    logFilePath: 'x/logs/main.log',
    circuit: null,
    offline: null
  }
}

function mockCompanion(getSnapshotImpl: () => Promise<unknown>): void {
  Object.defineProperty(window, 'companion', {
    value: {
      debug: {
        getSnapshot: vi.fn(getSnapshotImpl),
        openLogFolder: vi.fn(async () => ({ ok: true, data: undefined }))
      }
    },
    writable: true,
    configurable: true
  })
}

async function pressShortcut(): Promise<void> {
  window.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, shiftKey: true, key: 'D' }))
  await flushPromises()
}

describe('DebugPanel 快捷键门（M-45 回归）', () => {
  it('快照可用时 Ctrl+Shift+D 打开面板（构建模式不再禁用）', async () => {
    mockCompanion(async () => ({ ok: true, data: makeSnapshot() }))
    const wrapper = mount(DebugPanel)
    expect(wrapper.find('.debug-panel').exists()).toBe(false)
    await pressShortcut()
    expect(wrapper.find('.debug-panel').exists()).toBe(true)
    expect(wrapper.text()).toContain('1.0.0-test')
    wrapper.unmount()
  })

  it('main 拒绝（打包场景，ok=false）时保持隐藏', async () => {
    mockCompanion(async () => ({ ok: false, error: { code: 'IPC_UNAUTHORIZED' } }))
    const wrapper = mount(DebugPanel)
    await pressShortcut()
    expect(wrapper.find('.debug-panel').exists()).toBe(false)
    wrapper.unmount()
  })

  it('拉取抛异常同样保持隐藏（静默）', async () => {
    mockCompanion(async () => {
      throw new Error('ipc down')
    })
    const wrapper = mount(DebugPanel)
    await pressShortcut()
    expect(wrapper.find('.debug-panel').exists()).toBe(false)
    wrapper.unmount()
  })

  it('已打开时再按一次关闭；关闭后重开会重新探测', async () => {
    mockCompanion(async () => ({ ok: true, data: makeSnapshot() }))
    const wrapper = mount(DebugPanel)
    await pressShortcut()
    expect(wrapper.find('.debug-panel').exists()).toBe(true)
    await pressShortcut()
    expect(wrapper.find('.debug-panel').exists()).toBe(false)
    await pressShortcut()
    expect(wrapper.find('.debug-panel').exists()).toBe(true)
    wrapper.unmount()
  })
})
