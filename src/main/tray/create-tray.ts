// src/main/tray/create-tray.ts
// P3A-32：Windows 托盘真源。状态有同等的 tooltip/menu 文本，不把颜色当作唯一信息。

import { Menu, Tray, nativeImage } from 'electron'
import { join } from 'node:path'

export type TrayStatus = 'idle' | 'unread' | 'attention'

export interface NacimeTray {
  setStatus(status: TrayStatus): void
  destroy(): void
}

const STATUS_COPY: Record<TrayStatus, string> = {
  idle: 'Nacime · 等待陪伴',
  unread: 'Nacime · 有新的消息',
  attention: 'Nacime · 需要你的注意'
}

function createTrayIcon(assetsDirectory: string, status: TrayStatus): ReturnType<typeof nativeImage.createFromPath> {
  const icon = nativeImage.createFromPath(join(assetsDirectory, 'tray', `tray-${status}-24.png`))
  return process.platform === 'darwin' ? icon.resize({ width: 18, height: 18 }) : icon
}

export function createNacimeTray(options: {
  readonly assetsDirectory: string
  readonly showMainWindow: () => void
}): NacimeTray {
  const tray = new Tray(createTrayIcon(options.assetsDirectory, 'idle'))

  const applyStatus = (status: TrayStatus): void => {
    const label = STATUS_COPY[status]
    tray.setImage(createTrayIcon(options.assetsDirectory, status))
    tray.setToolTip(label)
    tray.setContextMenu(Menu.buildFromTemplate([
      { label, enabled: false },
      { type: 'separator' },
      { label: '打开 Nacime', click: options.showMainWindow },
      { label: '退出', role: 'quit' }
    ]))
  }

  applyStatus('idle')
  tray.on('click', options.showMainWindow)

  return {
    setStatus: applyStatus,
    destroy() {
      tray.destroy()
    }
  }
}
