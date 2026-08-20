// @vitest-environment jsdom
// src/renderer/src/components/chat/MessageList.test.ts
// M-31/S-02 回归：用户上滑阅读历史时，流式新内容不强制滚底。
// 旧实现两个 watch 无条件 scrollToBottom，上滑后下一个 token 到达就把视口拽回底部。

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia, type Pinia } from 'pinia'
import MessageList from './MessageList.vue'
import { useChatStore } from '../../stores/chat'
import type { ChatMessageView } from '@shared/chat/types'

function mockCompanion(): void {
  Object.defineProperty(window, 'companion', {
    value: {
      chat: {
        onStream: vi.fn(() => () => {}),
        send: vi.fn(async () => ({ ok: true, data: {} })),
        cancel: vi.fn(async () => ({ ok: true, data: undefined })),
        retry: vi.fn(async () => ({ ok: true, data: { requestId: 'r2' } }))
      },
      config: {
        get: vi.fn(async () => ({ ok: true, data: null })),
        update: vi.fn(async () => ({ ok: true, data: null })),
        testModel: vi.fn(async () => ({ ok: true, data: {} }))
      }
    },
    writable: true,
    configurable: true
  })
}

function message(id: string, role: 'user' | 'assistant', content: string): ChatMessageView {
  return { id, role, content, createdAt: 0, status: 'complete' }
}

/** 让 jsdom 元素可报告滚动高度（jsdom 无布局；clientHeight 不可写，读 0） */
function setScrollHeight(el: HTMLElement, scrollHeight: number): void {
  Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true })
}

let pinia: Pinia

describe('MessageList 滚动锚定（S-02 回归）', () => {
  beforeEach(() => {
    pinia = createPinia()
    setActivePinia(pinia)
    mockCompanion()
  })

  it('用户上滑（距底部 > 80px）后，追加新消息不强制滚底', async () => {
    const chatStore = useChatStore()
    chatStore.state.sessionId = 's1'
    chatStore.state.messages.push(message('m1', 'user', '你好'))

    const wrapper = mount(MessageList, { global: { plugins: [pinia] } })
    const list = wrapper.find('.message-list').element as HTMLElement
    // jsdom：clientHeight 读 0，贴底判定 = scrollHeight - scrollTop <= 80。
    // 总高 1000、scrollTop 500 -> 距离 500 > 80 -> 判定"用户已上滑"
    setScrollHeight(list, 1000)
    list.scrollTop = 500

    // 模拟用户手动滚动（触发 onScroll -> 记录"用户已上滑"）
    list.dispatchEvent(new Event('scroll'))

    // 流式追加新消息（触发 content watch -> scrollToBottom）
    chatStore.state.messages.push(message('m2', 'assistant', '回复内容'))
    await flushPromises()

    // 上滑标记生效：scrollTop 保持 500，未被拽回 scrollHeight
    expect(list.scrollTop).toBe(500)
  })

  it('停在底部（距离 <= 80px）时追加新消息正常跟随滚底', async () => {
    const chatStore = useChatStore()
    chatStore.state.sessionId = 's1'
    chatStore.state.messages.push(message('m1', 'user', '你好'))

    const wrapper = mount(MessageList, { global: { plugins: [pinia] } })
    const list = wrapper.find('.message-list').element as HTMLElement
    setScrollHeight(list, 1000)
    list.scrollTop = 950 // 距离 50 <= 80 -> 判定"贴底"

    // 模拟贴底滚动（onScroll -> 保持跟随）
    list.dispatchEvent(new Event('scroll'))

    chatStore.state.messages.push(message('m2', 'assistant', '回复内容'))
    await flushPromises()

    // 贴底时自动滚到底（scrollTop = scrollHeight）
    expect(list.scrollTop).toBe(1000)
  })
})
