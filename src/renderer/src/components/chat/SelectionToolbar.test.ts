// @vitest-environment jsdom
// src/renderer/src/components/chat/SelectionToolbar.test.ts
// 验收反馈⑦：选择模式工具条。
// 关键行为：
//   - 三段布局：删除所选（N）/ 全选 / 删除所有对话 + 取消
//   - 删除所选在无勾选时禁用
//   - 两个破坏性操作两段式：第一次上膛（文案变确认），第二次才执行；3 秒未确认自动复位
//   - Esc / 取消按钮退出选择模式

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import SelectionToolbar from './SelectionToolbar.vue'
import { useChatStore } from '../../stores/chat'

function mockCompanion(): void {
  Object.defineProperty(window, 'companion', {
    value: {
      chat: {
        onStream: vi.fn(() => () => {}),
        deleteSelected: vi.fn(async () => ({ ok: true, data: { deletedIds: ['u1', 'a1'] } })),
        clearSession: vi.fn(async () => ({ ok: true, data: { removed: 2 } }))
      }
    },
    writable: true,
    configurable: true
  })
}

let pinia: Pinia

function seedAndMount(): ReturnType<typeof mount> {
  const store = useChatStore()
  store.state.sessionId = 's1'
  store.state.messages.push(
    { id: 'u1', role: 'user', content: '问', createdAt: 1, status: 'complete' },
    { id: 'a1', role: 'assistant', content: '答', createdAt: 2, status: 'complete' }
  )
  store.enterSelection()
  return mount(SelectionToolbar, { global: { plugins: [pinia] } })
}

describe('SelectionToolbar（验收反馈⑦：选择模式工具条）', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    mockCompanion()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('无勾选时删除所选禁用且显示计数 0；勾选后解禁并显示计数', async () => {
    const store = useChatStore()
    const wrapper = seedAndMount()

    const deleteBtn = wrapper.find('.tb-zone.left .tb-btn')
    expect(deleteBtn.text()).toBe('删除所选（0）')
    expect(deleteBtn.attributes('disabled')).toBeDefined()

    store.toggleSelect('u1') // 整轮联动：u1+a1
    await wrapper.vm.$nextTick()
    expect(deleteBtn.text()).toBe('删除所选（2）')
    expect(deleteBtn.attributes('disabled')).toBeUndefined()
  })

  it('删除所选两段式：第一次上膛变确认文案，第二次才执行删除', async () => {
    const store = useChatStore()
    const wrapper = seedAndMount()
    store.toggleSelect('u1')
    await wrapper.vm.$nextTick()

    const deleteBtn = wrapper.find('.tb-zone.left .tb-btn')
    await deleteBtn.trigger('click') // 上膛
    expect(deleteBtn.text()).toBe('你确定删除所选？')
    expect(window.companion.chat.deleteSelected).not.toHaveBeenCalled()

    await deleteBtn.trigger('click') // 确认
    expect(window.companion.chat.deleteSelected).toHaveBeenCalledTimes(1)
  })

  it('上膛后 3 秒未确认自动复位', async () => {
    const store = useChatStore()
    const wrapper = seedAndMount()
    store.toggleSelect('u1')
    await wrapper.vm.$nextTick()

    const deleteBtn = wrapper.find('.tb-zone.left .tb-btn')
    await deleteBtn.trigger('click')
    expect(deleteBtn.text()).toBe('你确定删除所选？')

    await vi.advanceTimersByTimeAsync(3100)
    expect(deleteBtn.text()).toBe('删除所选（2）')
    expect(window.companion.chat.deleteSelected).not.toHaveBeenCalled()
  })

  it('换膛：上膛删除所选后点删除所有对话，后者进入确认态前者复位', async () => {
    const store = useChatStore()
    const wrapper = seedAndMount()
    store.toggleSelect('u1')
    await wrapper.vm.$nextTick()

    const deleteBtn = wrapper.find('.tb-zone.left .tb-btn')
    const clearBtn = wrapper.find('.tb-zone.right .tb-btn.danger')
    await deleteBtn.trigger('click')
    expect(deleteBtn.text()).toBe('你确定删除所选？')

    await clearBtn.trigger('click')
    expect(clearBtn.text()).toBe('你确定删除所有对话？')
    expect(deleteBtn.text()).toBe('删除所选（2）')

    await clearBtn.trigger('click') // 确认清空
    expect(window.companion.chat.clearSession).toHaveBeenCalledTimes(1)
  })

  it('全选按钮文案随 allSelected 切换，点击联动 store.toggleSelectAll', async () => {
    const store = useChatStore()
    const wrapper = seedAndMount()

    const selectAllBtn = wrapper.find('.tb-zone.center .tb-btn')
    expect(selectAllBtn.text()).toBe('全选')

    await selectAllBtn.trigger('click')
    expect(store.selectedCount).toBe(2)
    expect(selectAllBtn.text()).toBe('取消全选')

    await selectAllBtn.trigger('click')
    expect(store.selectedCount).toBe(0)
  })

  it('取消按钮退出选择模式', async () => {
    const store = useChatStore()
    const wrapper = seedAndMount()
    expect(store.selectionMode).toBe(true)

    await wrapper.find('.tb-btn.ghost').trigger('click')
    expect(store.selectionMode).toBe(false)
  })

  it('Esc 退出选择模式', async () => {
    const store = useChatStore()
    seedAndMount()
    expect(store.selectionMode).toBe(true)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(store.selectionMode).toBe(false)
  })
})
