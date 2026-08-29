// src/main/onboarding/resolver.ts
// P3A-29：首次引导兼容推断的 main-owned 真源。
// renderer 不通过空 sessionId 猜历史；只消费已解析并持久化的 ui.onboarding 状态。

import type { OnboardingConfigV1, OnboardingStage } from '@shared/config/types'

export type OnboardingResolutionReason =
  | 'no-api-key'
  | 'configured-empty-history'
  | 'existing-user'
  | 'persisted-progress'

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
      return { stage: 'first-conversation', reason: 'configured-empty-history', persisted: true }
    }
  }
}
