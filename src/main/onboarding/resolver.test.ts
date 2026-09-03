// src/main/onboarding/resolver.test.ts
// P3A-29：旧用户/空会话/已持久进度的 onboarding 推断必须在 main 完成。

import { describe, expect, it } from 'vitest'
import { createOnboardingResolver } from './resolver'

const resolver = createOnboardingResolver()
const noCompletedTurns = { hasCompletedTurn: () => false }
const completedTurnExists = { hasCompletedTurn: () => true }

const initial = {
  version: 1 as const,
  stage: 'provider-setup' as const,
  completedAt: undefined,
  voiceSendMode: undefined
}

describe('P3A-29 OnboardingResolver', () => {
  it('无 API Key 始终回 provider-setup，旧的进度会被 healing', () => {
    expect(
      resolver.resolve({
        hasApiKey: false,
        persisted: { ...initial, stage: 'first-conversation' },
        history: completedTurnExists
      })
    ).toEqual({ stage: 'provider-setup', reason: 'no-api-key', persisted: true })
  })

  it('已有 API Key 且存在真实 completed turn 时，不把空 session 误当作首次用户', () => {
    expect(
      resolver.resolve({ hasApiKey: true, persisted: initial, history: completedTurnExists })
    ).toEqual({
      stage: 'complete',
      reason: 'existing-user',
      persisted: true
    })
  })

  it('已有 API Key 但没有真实 completed turn 时先进入可跳过的语音设置', () => {
    expect(
      resolver.resolve({ hasApiKey: true, persisted: initial, history: noCompletedTurns })
    ).toEqual({
      stage: 'voice-setup',
      reason: 'configured-empty-history',
      persisted: true
    })
  })

  it('已经持久化的 connection-test / voice-setup / first-conversation / complete 进度优先于自动推断', () => {
    for (const stage of [
      'connection-test',
      'voice-setup',
      'first-conversation',
      'complete'
    ] as const) {
      expect(
        resolver.resolve({
          hasApiKey: true,
          persisted: { ...initial, stage },
          history: completedTurnExists
        })
      ).toEqual({ stage, reason: 'persisted-progress', persisted: false })
    }
  })
})
