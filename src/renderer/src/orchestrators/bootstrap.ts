// src/renderer/src/orchestrators/bootstrap.ts
// P1-24: bootstrapApp - 跨域启动编排
// 依据：S-002 §2 铁律 2（跨域流程放 orchestrators/）、§3.1 app store bootstrap
//
// 职责：协调 app/config/chat 三个 store 的启动顺序
//   1. app.subscribe() -> 注册全局事件（窗口状态、app 错误）
//   2. config.load() -> 加载脱敏配置快照
//   3. chat.subscribe() -> 注册流式事件
//   4. chat.hydrate() -> 创建或恢复会话
//   5. app.setBootStage('ready')
//
// 安全：Store 不直接互调，由本编排器协调（S-002 铁律 1）

import { useAppStore } from '../stores/app'
import { useChatStore } from '../stores/chat'
import { useConfigStore } from '../stores/config'
import type { Unsubscribe } from '@shared/ipc/contracts'

export async function bootstrapApp(): Promise<void> {
  const appStore = useAppStore()
  const configStore = useConfigStore()
  const chatStore = useChatStore()

  const unsubs: Unsubscribe[] = []

  try {
    // 1. 注册全局事件
    appStore.setBootStage('registering-events')
    unsubs.push(appStore.subscribe())

    // 获取 app 信息
    if (window.companion) {
      const infoResult = await window.companion.app.getInfo()
      if (infoResult.ok) {
        appStore.setAppVersion(infoResult.data.version)
      }
    }

    // 2. 加载配置
    appStore.setBootStage('loading-config')
    await configStore.load()

    // 3. 注册流式事件
    unsubs.push(chatStore.subscribe())

    // 4. 创建会话
    await chatStore.hydrate()

    // 5. 就绪
    appStore.setBootStage('ready')
  } catch (err) {
    appStore.reportError({
      code: 'UNKNOWN',
      message: err instanceof Error ? err.message : '启动失败',
      severity: 'fatal',
      retryable: false
    })
  }
}

/** 清理所有订阅（组件卸载时调用） */
export function teardownBootstrap(unsubs: Unsubscribe[]): void {
  for (const unsub of unsubs) {
    unsub()
  }
}
