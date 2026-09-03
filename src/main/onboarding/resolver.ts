// src/main/onboarding/resolver.ts
// P3A-29：首次引导兼容推断的 main-owned 真源。
// renderer 不通过空 sessionId 猜历史；只消费已解析并持久化的 ui.onboarding 状态。

import type { OnboardingConfigV1, OnboardingStage } from '@shared/config/types'

export type OnboardingResolutionReason =
  'no-api-key' | 'configured-empty-history' | 'existing-user' | 'persisted-progress'

export interface OnboardingHistoryProbe {
  hasCompletedTurn(): boolean
}

export interface OnboardingResolution {
  readonly stage: OnboardingStage
  readonly reason: OnboardingResolutionReason
  readonly persisted: boolean
}

export interface OnboardingResolver {
  resolve(input: {
    readonly hasApiKey: boolean
    readonly persisted: OnboardingConfigV1
    readonly history: OnboardingHistoryProbe
  }): OnboardingResolution
}

export function createOnboardingResolver(): OnboardingResolver {
  return {
    resolve({ hasApiKey, persisted, history }) {
      if (!hasApiKey) {
        return {
          stage: 'provider-setup',
          reason: 'no-api-key',
          persisted: persisted.stage !== 'provider-setup'
        }
      }
      if (persisted.stage !== 'provider-setup') {
        return { stage: persisted.stage, reason: 'persisted-progress', persisted: false }
      }
      if (history.hasCompletedTurn()) {
        return { stage: 'complete', reason: 'existing-user', persisted: true }
      }
      // P3V-14：已有可读 Key 但从未完成真实对话，仍属于尚未完成首次体验的新用户；
      // 先给可跳过的本地语音设置，再进入第一次见面。已有 completed turn 的老用户
      // 已在上方 healing 为 complete，不会被强迫重走。
      return { stage: 'voice-setup', reason: 'configured-empty-history', persisted: true }
    }
  }
}
