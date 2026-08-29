// src/main/tray/create-tray.test.ts
// P3A-32：托盘三态必须同时有图标和可读 tooltip/menu 文本。

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Menu, nativeImage } from 'electron'
import { createNacimeTray } from './create-tray'

const electronMocks = vi.hoisted(() => {
  const setImage = vi.fn()
  const setToolTip = vi.fn()
  const setContextMenu = vi.fn()
  const on = vi.fn()
  const destroy = vi.fn()
  const TrayMock = vi.fn(function TrayMock() {
    return { setImage, setToolTip, setContextMenu, on, destroy }
  })
  return { setImage, setToolTip, setContextMenu, on, destroy, TrayMock }
})

vi.mock('electron', () => ({
  Tray: electronMocks.TrayMock,
  nativeImage: { createFromPath: vi.fn(() => ({ resize: vi.fn() })) },
  Menu: { buildFromTemplate: vi.fn((template) => template) }
}))

describe('P3A-32 Nacime tray', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('idle/unread/attention 每种状态均更新图标、tooltip 和可读菜单文本', () => {
    const tray = createNacimeTray({ assetsDirectory: 'assets', showMainWindow: vi.fn() })
    for (const status of ['idle', 'unread', 'attention'] as const) tray.setStatus(status)

    expect(electronMocks.TrayMock).toHaveBeenCalledTimes(1)
    expect(nativeImage.createFromPath).toHaveBeenCalledWith(expect.stringContaining('tray-idle-24.png'))
    expect(nativeImage.createFromPath).toHaveBeenCalledWith(expect.stringContaining('tray-unread-24.png'))
    expect(nativeImage.createFromPath).toHaveBeenCalledWith(expect.stringContaining('tray-attention-24.png'))
    expect(electronMocks.setToolTip).toHaveBeenNthCalledWith(2, 'Nacime · 等待陪伴')
    expect(electronMocks.setToolTip).toHaveBeenNthCalledWith(3, 'Nacime · 有新的消息')
    expect(electronMocks.setToolTip).toHaveBeenNthCalledWith(4, 'Nacime · 需要你的注意')
    expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(4)
    tray.destroy()
    expect(electronMocks.destroy).toHaveBeenCalledTimes(1)
  })
})
