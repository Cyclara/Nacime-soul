// tests/helpers/dual-window-sender.test.ts
// P3-00C 自测：双窗口 sender fixture——两窗受信、仿冒 ID/origin 全拒绝。

import { describe, it, expect } from 'vitest'
import { isTrustedSender } from '../../src/main/ipc/validators'
import {
  CHAT_WINDOW,
  LIVE2D_STAGE_WINDOW,
  makeDualWindowSenders,
  makeForgedSender
} from './dual-window-sender'

describe('dual-window-sender 自测', () => {
  it('chat 与 stage 两个 sender 均受信', () => {
    const { bothTrusted, chatSender, stageSender } = makeDualWindowSenders()
    expect(chatSender.webContentsId).toBe(CHAT_WINDOW.webContentsId)
    expect(stageSender.webContentsId).toBe(LIVE2D_STAGE_WINDOW.webContentsId)
    expect(chatSender.webContentsId).not.toBe(stageSender.webContentsId)
    expect(bothTrusted()).toEqual({ chat: true, stage: true })
  })

  it('仿冒 webContentsId 被拒绝', () => {
    const { chatSender, guardConfig } = makeDualWindowSenders()
    const forged = makeForgedSender(chatSender, { webContentsId: 999 })
    expect(isTrustedSender(forged, guardConfig)).toBe(false)
  })

  it('仿冒 origin 被拒绝（ID 受信但 URL 被改）', () => {
    const { chatSender, guardConfig } = makeDualWindowSenders()
    const forged = makeForgedSender(chatSender, { url: 'https://evil.example/' })
    expect(isTrustedSender(forged, guardConfig)).toBe(false)
  })

  it('stage 窗口销毁后 ID 从集合移除即不再受信（P3A-05 生命周期语义）', () => {
    const { stageSender, guardConfig } = makeDualWindowSenders()
    expect(isTrustedSender(stageSender, guardConfig)).toBe(true)
    guardConfig.trustedWebContentsIds.delete(LIVE2D_STAGE_WINDOW.webContentsId)
    expect(isTrustedSender(stageSender, guardConfig)).toBe(false)
  })
})
