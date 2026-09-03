// src/shared/voice/voice-events.test.ts
// P3B-14：VoiceEvent 校验器测试（preload event 通道纵深防御）。

import { describe, expect, it } from 'vitest'
import { isVoiceEvent } from './voice-events'

describe('P3B-14 isVoiceEvent', () => {
  it('各事件类型合法通过', () => {
    expect(isVoiceEvent({ type: 'listening-started' })).toBe(true)
    expect(isVoiceEvent({ type: 'listening-stopped', reason: 'user' })).toBe(true)
    expect(isVoiceEvent({ type: 'listening-stopped', reason: 'mic-closed' })).toBe(true)
    expect(
      isVoiceEvent({ type: 'listening-stopped', reason: 'error', errorCode: 'model-missing' })
    ).toBe(true)
    expect(isVoiceEvent({ type: 'vad-state', state: 'active' })).toBe(true)
    expect(isVoiceEvent({ type: 'vad-state', state: 'inactive' })).toBe(true)
    expect(isVoiceEvent({ type: 'transcript', text: '你好' })).toBe(true)
    expect(isVoiceEvent({ type: 'asr-error', code: 'recognize-failed' })).toBe(true)
  })

  it('非法形状拒绝', () => {
    expect(isVoiceEvent(null)).toBe(false)
    expect(isVoiceEvent('x')).toBe(false)
    expect(isVoiceEvent({ type: 'listening-started', extra: 1 })).toBe(false)
    expect(isVoiceEvent({ type: 'listening-stopped', reason: 'weird' })).toBe(false)
    expect(isVoiceEvent({ type: 'vad-state', state: 'speaking' })).toBe(false)
    expect(isVoiceEvent({ type: 'vad-state' })).toBe(false)
    expect(isVoiceEvent({ type: 'transcript' })).toBe(false)
    expect(isVoiceEvent({ type: 'asr-error' })).toBe(false)
    expect(isVoiceEvent({ type: 'unknown-event' })).toBe(false)
  })
})
