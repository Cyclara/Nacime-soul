// src/main/windows/context-menu.test.ts
// M-38：右键菜单——输入框三板斧 + 只读选中复制 + 无选中不弹空菜单。
import { describe, it, expect, vi, beforeEach } from 'vitest'

const popup = vi.fn()
const buildFromTemplate = vi.fn((template: unknown[]) => ({ popup, template }))

vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: unknown[]) => buildFromTemplate(template)
  }
}))

import { registerContextMenu } from './context-menu'

interface FakeEditFlags {
  canCut: boolean
  canCopy: boolean
  canPaste: boolean
  canSelectAll: boolean
}

interface FakeParams {
  isEditable: boolean
  selectionText: string
  editFlags: FakeEditFlags
}

type ContextMenuHandler = (event: unknown, params: FakeParams) => void

const ALL_FLAGS: FakeEditFlags = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true }

function makeWin(): { win: { webContents: { on: (e: string, h: ContextMenuHandler) => void } }; fire: (p: Partial<FakeParams>) => void } {
  let handler: ContextMenuHandler | null = null
  const win = {
    webContents: {
      on: (event: string, h: ContextMenuHandler) => {
        if (event === 'context-menu') handler = h
      }
    }
  }
  return {
    win,
    fire: (p) => {
      const params: FakeParams = {
        isEditable: false,
        selectionText: '',
        editFlags: { ...ALL_FLAGS },
        ...p
      }
      handler!(null, params)
    }
  }
}

function rolesOf(template: unknown[]): unknown[] {
  return template.map((item) =>
    item && typeof item === 'object' && 'role' in item
      ? (item as { role: string }).role
      : item && typeof item === 'object' && 'type' in item
        ? (item as { type: string }).type
        : item
  )
}

describe('M-38 右键菜单', () => {
  beforeEach(() => {
    popup.mockClear()
    buildFromTemplate.mockClear()
  })

  it('输入框（可编辑）：剪切/复制/粘贴 + 全选，按 editFlags 可用性', () => {
    const { win, fire } = makeWin()
    registerContextMenu(win as never)
    fire({ isEditable: true, editFlags: { ...ALL_FLAGS } })

    expect(buildFromTemplate).toHaveBeenCalledTimes(1)
    const template = buildFromTemplate.mock.calls[0][0]
    expect(rolesOf(template)).toEqual(['cut', 'copy', 'paste', 'separator', 'selectAll'])
    expect(popup).toHaveBeenCalledWith({ window: win })
  })

  it('输入框无选中/剪贴板空：只给全选（不可用项不出现，不加分隔线）', () => {
    const { win, fire } = makeWin()
    registerContextMenu(win as never)
    fire({
      isEditable: true,
      editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true }
    })

    const template = buildFromTemplate.mock.calls[0][0]
    expect(rolesOf(template)).toEqual(['selectAll'])
  })

  it('只读区域有选中文本：复制 + 全选', () => {
    const { win, fire } = makeWin()
    registerContextMenu(win as never)
    fire({ isEditable: false, selectionText: '被选中的聊天文字' })

    const template = buildFromTemplate.mock.calls[0][0]
    expect(rolesOf(template)).toEqual(['copy', 'selectAll'])
    const labels = template.map((i) => (i as { label?: string }).label)
    expect(labels).toEqual(['复制', '全选'])
    expect(popup).toHaveBeenCalledTimes(1)
  })

  it('只读区域只有空白选中：不弹菜单', () => {
    const { win, fire } = makeWin()
    registerContextMenu(win as never)
    fire({ isEditable: false, selectionText: '   ' })
    expect(buildFromTemplate).not.toHaveBeenCalled()
    expect(popup).not.toHaveBeenCalled()
  })

  it('无选中且非输入框：不弹空菜单', () => {
    const { win, fire } = makeWin()
    registerContextMenu(win as never)
    fire({ isEditable: false, selectionText: '' })
    expect(buildFromTemplate).not.toHaveBeenCalled()
    expect(popup).not.toHaveBeenCalled()
  })
})
