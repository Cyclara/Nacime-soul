// @vitest-environment jsdom
// src/renderer/src/components/common/AppContextMenu.test.ts
// 验收反馈⑤：主题化右键菜单。
// 菜单集合沿用 M-38 验收标准：输入框=剪切/复制/粘贴/全选；只读选中=复制/全选；空白不弹。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import AppContextMenu from './AppContextMenu.vue'

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
