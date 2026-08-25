// @vitest-environment jsdom
// src/renderer/src/components/common/AppContextMenu.test.ts
// 验收反馈⑤：主题化右键菜单。
// 菜单集合沿用 M-38 验收标准：输入框=剪切/复制/粘贴/全选；只读选中=复制/全选；空白不弹。
// 验收反馈⑥：气泡（[data-message-id]）上出现「删除这轮对话」，两段式确认，流式中不显示。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import { setActivePinia, createPinia } from 'pinia'
import AppContextMenu from './AppContextMenu.vue'
import { useChatStore } from '../../stores/chat'

const writeText = vi.fn(async () => {})
const readText = vi.fn(async () => '贴上来')

function mockClipboard(): void {
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText, readText },
    configurable: true
  })
}

function makeTextarea(value: string, selStart: number, selEnd: number): HTMLTextAreaElement {
  const el = document.createElement('textarea')
  el.value = value
  document.body.appendChild(el)
  el.setSelectionRange(selStart, selEnd)
  return el
}

function rightClick(el: EventTarget, x = 100, y = 100): void {
  el.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y })
  )
}

function menuEl(): HTMLElement | null {
  return document.body.querySelector('.app-context-menu')
}

function menuItems(): Array<{ text: string; disabled: boolean }> {
  return [...document.body.querySelectorAll<HTMLButtonElement>('.app-context-menu-item')].map(
    (b) => ({ text: b.textContent?.trim() ?? '', disabled: b.disabled })
  )
}

describe('AppContextMenu（验收反馈⑤）', () => {
  // 每个用例都挂新实例且实例持 window 监听：必须先 unmount 再清 body，
  // 否则旧实例收到事件重渲染时 teleport 锚点已被擦掉（insertBefore null）
  let wrapper: ReturnType<typeof mount> | null = null

  beforeEach(() => {
    setActivePinia(createPinia())
    mockClipboard()
    writeText.mockClear()
    readText.mockClear()
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('输入框右键（有选中）：剪切/复制/粘贴/全选，剪切复制可用', async () => {
    wrapper = mount(AppContextMenu)
    const ta = makeTextarea('你好世界', 0, 2) // 选中"你好"
    rightClick(ta)
    await nextTick()

    expect(menuEl()).not.toBeNull()
    expect(menuItems()).toEqual([
      { text: '剪切', disabled: false },
      { text: '复制', disabled: false },
      { text: '粘贴', disabled: false },
      { text: '全选', disabled: false }
    ])
  })

  it('输入框右键（无选中、有文本）：剪切/复制禁用，粘贴/全选可用', async () => {
    wrapper = mount(AppContextMenu)
    const ta = makeTextarea('你好世界', 2, 2)
    rightClick(ta)
    await nextTick()

    expect(menuItems()).toEqual([
      { text: '剪切', disabled: true },
      { text: '复制', disabled: true },
      { text: '粘贴', disabled: false },
      { text: '全选', disabled: false }
    ])
  })

  it('只读区域有选中文本：复制 + 全选', async () => {
    wrapper = mount(AppContextMenu)
    const div = document.createElement('div')
    div.textContent = '聊天记录里的一句话'
    document.body.appendChild(div)

    const realGetSelection = window.getSelection.bind(window)
    const selectAllChildren = vi.fn()
    Object.defineProperty(window, 'getSelection', {
      configurable: true,
      value: () => ({ isCollapsed: false, toString: () => '聊天记录里的一句话', selectAllChildren })
    })

    rightClick(div)
    await nextTick()

    expect(menuItems()).toEqual([
      { text: '复制', disabled: false },
      { text: '全选', disabled: false }
    ])

    Object.defineProperty(window, 'getSelection', { configurable: true, value: realGetSelection })
  })

  it('空白处（无选中、非输入框）右键：不弹菜单', async () => {
    wrapper = mount(AppContextMenu)
    const div = document.createElement('div')
    document.body.appendChild(div)

    const realGetSelection = window.getSelection.bind(window)
    Object.defineProperty(window, 'getSelection', {
      configurable: true,
      value: () => ({ isCollapsed: true, toString: () => '' })
    })

    rightClick(div)
    await nextTick()
    expect(menuEl()).toBeNull()

    Object.defineProperty(window, 'getSelection', { configurable: true, value: realGetSelection })
  })

  it('点「复制」写剪贴板并关闭菜单', async () => {
    wrapper = mount(AppContextMenu)
    const ta = makeTextarea('你好世界', 0, 2)
    rightClick(ta)
    await nextTick()

    const copyBtn = [
      ...document.body.querySelectorAll<HTMLButtonElement>('.app-context-menu-item')
    ].find((b) => b.textContent?.includes('复制'))!
    copyBtn.click()
    await flushPromises()

    expect(writeText).toHaveBeenCalledWith('你好')
    expect(menuEl()).toBeNull()
  })

  it('点「粘贴」插入剪贴板文本并派发 input 事件（v-model 链路能感知）', async () => {
    wrapper = mount(AppContextMenu)
    const ta = makeTextarea('你好', 2, 2)
    const onInput = vi.fn()
    ta.addEventListener('input', onInput)

    rightClick(ta)
    await nextTick()
    const pasteBtn = [
      ...document.body.querySelectorAll<HTMLButtonElement>('.app-context-menu-item')
    ].find((b) => b.textContent?.includes('粘贴'))!
    pasteBtn.click()
    await flushPromises()

    expect(readText).toHaveBeenCalled()
    expect(ta.value).toBe('你好贴上来')
    expect(onInput).toHaveBeenCalled()
    expect(menuEl()).toBeNull()
  })

  it('点「剪切」写剪贴板并从输入框移除选中段', async () => {
    wrapper = mount(AppContextMenu)
    const ta = makeTextarea('你好世界', 0, 2)
    rightClick(ta)
    await nextTick()

    const cutBtn = [
      ...document.body.querySelectorAll<HTMLButtonElement>('.app-context-menu-item')
    ].find((b) => b.textContent?.includes('剪切'))!
    cutBtn.click()
    await flushPromises()

    expect(writeText).toHaveBeenCalledWith('你好')
    expect(ta.value).toBe('世界')
  })

  it('Esc 关闭菜单', async () => {
    wrapper = mount(AppContextMenu)
    const ta = makeTextarea('你好世界', 0, 2)
    rightClick(ta)
    await nextTick()
    expect(menuEl()).not.toBeNull()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(menuEl()).toBeNull()
  })

  it('贴右下边缘右键：菜单不溢出视口', async () => {
    wrapper = mount(AppContextMenu)
    const ta = makeTextarea('你好世界', 0, 2)
    rightClick(ta, window.innerWidth - 2, window.innerHeight - 2)
    await nextTick()

    const menu = menuEl()!
    const left = parseInt(menu.style.left, 10)
    const top = parseInt(menu.style.top, 10)
    expect(left).toBeLessThanOrEqual(window.innerWidth - 124 - 8)
    expect(top).toBeLessThanOrEqual(window.innerHeight - 8)
  })
})

// 验收反馈⑥/⑥c：气泡上的删除项（整轮 + 单条，两段式确认）
describe('AppContextMenu 气泡删除（验收反馈⑥/⑥c）', () => {
  let wrapper: ReturnType<typeof mount> | null = null
  const deleteTurn = vi.fn(async () => ({ ok: true, data: { deletedIds: ['u1', 'a1'] } }))
  const deleteMessage = vi.fn(async () => ({ ok: true, data: { deletedIds: ['a1'] } }))

  function makeBubble(messageId: string): HTMLDivElement {
    const row = document.createElement('div')
    row.setAttribute('data-message-id', messageId)
    const bubble = document.createElement('div')
    bubble.textContent = '她的回答'
    row.appendChild(bubble)
    document.body.appendChild(row)
    return bubble
  }

  function itemByText(text: string): HTMLButtonElement | undefined {
    return [...document.body.querySelectorAll<HTMLButtonElement>('.app-context-menu-item')].find(
      (b) => b.textContent?.trim() === text
    )
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    deleteTurn.mockClear()
    deleteMessage.mockClear()
    Object.defineProperty(window, 'companion', {
      value: { chat: { deleteTurn, deleteMessage } },
      writable: true,
      configurable: true
    })
    // store action 需要 sessionId 才会真正发 IPC
    useChatStore().state.sessionId = 's1'
  })

  afterEach(() => {
    wrapper?.unmount()
    wrapper = null
    document.body.innerHTML = ''
  })

  it('气泡右键（无选中）：删除这轮对话 + 删除这条消息 + 选择（整轮在前）', async () => {
    wrapper = mount(AppContextMenu)
    rightClick(makeBubble('a1'))
    await nextTick()

    expect(menuItems()).toEqual([
      { text: '删除这轮对话', disabled: false },
      { text: '删除这条消息', disabled: false },
      { text: '选择', disabled: false }
    ])
  })

  it('气泡右键（有选中）：复制/全选 + 两个删除项 + 选择', async () => {
    wrapper = mount(AppContextMenu)
    const bubble = makeBubble('a1')

    const realGetSelection = window.getSelection.bind(window)
    Object.defineProperty(window, 'getSelection', {
      configurable: true,
      value: () => ({ isCollapsed: false, toString: () => '她的', selectAllChildren: vi.fn() })
    })

    rightClick(bubble)
    await nextTick()

    expect(menuItems()).toEqual([
      { text: '复制', disabled: false },
      { text: '全选', disabled: false },
      { text: '删除这轮对话', disabled: false },
      { text: '删除这条消息', disabled: false },
      { text: '选择', disabled: false }
    ])

    Object.defineProperty(window, 'getSelection', { configurable: true, value: realGetSelection })
  })

  it('整轮两段式：第一次点只上膛（菜单不关、标签变确认），第二次点才真删并关菜单', async () => {
    wrapper = mount(AppContextMenu)
    rightClick(makeBubble('a1'))
    await nextTick()

    itemByText('删除这轮对话')!.click()
    await flushPromises()
    // 上膛：菜单还开着，标签变了，IPC 未调
    expect(menuEl()).not.toBeNull()
    expect(itemByText('确认删除这轮？')).toBeDefined()
    expect(deleteTurn).not.toHaveBeenCalled()

    itemByText('确认删除这轮？')!.click()
    await flushPromises()
    expect(deleteTurn).toHaveBeenCalledWith({ sessionId: 's1', messageId: 'a1' })
    expect(menuEl()).toBeNull()
  })

  it('单条两段式：确认识别后走 deleteMessage，只删被点那一条', async () => {
    wrapper = mount(AppContextMenu)
    rightClick(makeBubble('a1'))
    await nextTick()

    itemByText('删除这条消息')!.click()
    await flushPromises()
    expect(itemByText('确认删除这条？')).toBeDefined()
    expect(deleteMessage).not.toHaveBeenCalled()

    itemByText('确认删除这条？')!.click()
    await flushPromises()
    expect(deleteMessage).toHaveBeenCalledWith({ sessionId: 's1', messageId: 'a1' })
    expect(deleteTurn).not.toHaveBeenCalled() // 不误触整轮
    expect(menuEl()).toBeNull()
  })

  it('上膛一项后点另一项：自动换膛（前一项标签复位、后一项变确认）', async () => {
    wrapper = mount(AppContextMenu)
    rightClick(makeBubble('a1'))
    await nextTick()

    itemByText('删除这轮对话')!.click()
    await flushPromises()
    expect(itemByText('确认删除这轮？')).toBeDefined()

    itemByText('删除这条消息')!.click()
    await flushPromises()
    // 换膛：前一项回默认标签，后一项变确认；真删未发生
    expect(itemByText('删除这轮对话')).toBeDefined()
    expect(itemByText('确认删除这条？')).toBeDefined()
    expect(deleteTurn).not.toHaveBeenCalled()
    expect(deleteMessage).not.toHaveBeenCalled()
    expect(menuEl()).not.toBeNull()
  })

  it('上膛后 3 秒未确认：自动复位回默认标签', async () => {
    vi.useFakeTimers()
    try {
      wrapper = mount(AppContextMenu)
      rightClick(makeBubble('a1'))
      await nextTick()

      itemByText('删除这条消息')!.click()
      await nextTick()
      expect(itemByText('确认删除这条？')).toBeDefined()

      vi.advanceTimersByTime(3000)
      await nextTick()
      expect(itemByText('删除这条消息')).toBeDefined()
      expect(menuEl()).not.toBeNull() // 菜单仍开着，只是解除上膛
      expect(deleteMessage).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('上膛后关闭菜单再打开：回到未上膛状态', async () => {
    wrapper = mount(AppContextMenu)
    const bubble = makeBubble('a1')
    rightClick(bubble)
    await nextTick()

    itemByText('删除这轮对话')!.click()
    await flushPromises()
    expect(itemByText('确认删除这轮？')).toBeDefined()

    // Esc 关闭
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(menuEl()).toBeNull()

    // 重新右键：标签复位
    rightClick(bubble)
    await nextTick()
    expect(itemByText('删除这轮对话')).toBeDefined()
    expect(itemByText('删除这条消息')).toBeDefined()
  })

  it('流式进行中（activeTurn 非空）：气泡右键不出现删除项', async () => {
    useChatStore().state.activeTurn = {
      requestId: 'r1',
      assistantMessageId: 'a9',
      lastSequence: 0,
      startedAt: 1
    }
    wrapper = mount(AppContextMenu)
    rightClick(makeBubble('a1'))
    await nextTick()

    expect(menuEl()).toBeNull() // 无选中 + 删除项被隐藏 -> 空菜单不弹
  })

  it('点「选择」：关闭菜单并进入选择模式，预勾被点气泡所在轮（验收反馈⑦）', async () => {
    const store = useChatStore()
    // 一轮完整对话：点 a1 应预勾 u1+a1（相邻配对联动）
    store.state.messages.push(
      { id: 'u1', role: 'user', content: '问', createdAt: 1, status: 'complete' },
      { id: 'a1', role: 'assistant', content: '答', createdAt: 2, status: 'complete' }
    )

    wrapper = mount(AppContextMenu)
    rightClick(makeBubble('a1'))
    await nextTick()

    itemByText('选择')!.click()
    await flushPromises()

    expect(menuEl()).toBeNull() // 菜单关闭
    expect(store.selectionMode).toBe(true)
    expect([...store.selectedIds].sort()).toEqual(['a1', 'u1'])
    expect(deleteTurn).not.toHaveBeenCalled() // 选择不触发任何删除
    expect(deleteMessage).not.toHaveBeenCalled()
  })
})
