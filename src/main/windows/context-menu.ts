// src/main/windows/context-menu.ts
// M-38（2026-08-21）：聊天窗口右键菜单——复制/粘贴/全选。
//
// 背景：Electron 默认不提供浏览器式右键菜单，用户选中聊天文字后右键无任何入口
// （Ctrl+C 可用但无可见入口）。在 main 侧 webContents 'context-menu' 事件上按
// params 状态弹原生 Menu（role 驱动，行为与可访问性由 Electron 保证）。
//
// 菜单集合（M-38 验收标准）：
//   - 输入框（isEditable）：剪切/复制/粘贴（按 editFlags 可用性）+ 全选
//   - 只读区域有选中文本：复制 + 全选
//   - 无选中且非输入框：不弹空菜单

import { Menu, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

/** 注册窗口右键菜单（创建窗口时调用一次；重建窗口时随 createChatWindow 重新调用） */
export function registerContextMenu(win: BrowserWindow): void {
  win.webContents.on('context-menu', (_event, params) => {
    const template: MenuItemConstructorOptions[] = []

    if (params.isEditable) {
      // 输入框：编辑三板斧按可用性给，再补全选
      if (params.editFlags.canCut) template.push({ role: 'cut', label: '剪切' })
      if (params.editFlags.canCopy) template.push({ role: 'copy', label: '复制' })
      if (params.editFlags.canPaste) template.push({ role: 'paste', label: '粘贴' })
      if (template.length > 0 && params.editFlags.canSelectAll) {
        template.push({ type: 'separator' })
      }
      if (params.editFlags.canSelectAll) template.push({ role: 'selectAll', label: '全选' })
    } else if (params.selectionText.trim().length > 0) {
      // 只读区域（聊天记录等）：选中文字才有菜单
      template.push({ role: 'copy', label: '复制' })
      template.push({ role: 'selectAll', label: '全选' })
    }

    // 无选中且非输入框：不弹空菜单
    if (template.length === 0) return

    Menu.buildFromTemplate(template).popup({ window: win })
  })
}
