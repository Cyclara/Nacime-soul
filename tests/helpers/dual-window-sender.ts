// tests/helpers/dual-window-sender.ts
// P3-00C：双窗口 sender fixture——chat 主窗 + Live2D stage 窗的受信 sender 对。
//
// 用途：
//   - P3A-05 IPC guard 能力分组测试：两个窗口各自 namespace 的正/负例
//   - 任何断言"sender 身份/来源"的 main 侧测试
//
// 复用 main/ipc/validators.ts 的真实 SenderInfo/IpcGuardConfig/isTrustedSender，
// fixture 只负责造数据，不复制校验逻辑。

import type { IpcGuardConfig, SenderInfo } from '../../src/main/ipc/validators'
import { isTrustedSender } from '../../src/main/ipc/validators'

/** dev 环境两个窗口的既定身份（与 P3A-04..06 的双入口约定一致） */
export const CHAT_WINDOW = {
  webContentsId: 1,
  url: 'http://localhost:5173/'
} as const

export const LIVE2D_STAGE_WINDOW = {
  webContentsId: 2,
  url: 'http://localhost:5173/live2d.html'
} as const

export interface DualWindowSenders {
  chatSender: SenderInfo
  stageSender: SenderInfo
  guardConfig: IpcGuardConfig
  /** 两窗口均受信 */
  bothTrusted: () => { chat: boolean; stage: boolean }
}

export function makeDualWindowSenders(
  overrides?: Partial<{ trustedOrigins: string[]; extraWebContentsIds: number[] }>
): DualWindowSenders {
  const chatSender: SenderInfo = {
    url: CHAT_WINDOW.url,
    webContentsId: CHAT_WINDOW.webContentsId
  }
  const stageSender: SenderInfo = {
    url: LIVE2D_STAGE_WINDOW.url,
    webContentsId: LIVE2D_STAGE_WINDOW.webContentsId
  }
  const guardConfig: IpcGuardConfig = {
    trustedOrigins: new Set(overrides?.trustedOrigins ?? ['http://localhost:5173']),
    trustedWebContentsIds: new Set([
      CHAT_WINDOW.webContentsId,
      LIVE2D_STAGE_WINDOW.webContentsId,
      ...(overrides?.extraWebContentsIds ?? [])
    ])
  }
  return {
    chatSender,
    stageSender,
    guardConfig,
    bothTrusted: () => ({
      chat: isTrustedSender(chatSender, guardConfig),
      stage: isTrustedSender(stageSender, guardConfig)
    })
  }
}

/** 造一个"仿冒 sender"：ID 受信但 origin 被改（或反之），供负例测试 */
export function makeForgedSender(base: SenderInfo, forge: Partial<SenderInfo>): SenderInfo {
  return { ...base, ...forge }
}
