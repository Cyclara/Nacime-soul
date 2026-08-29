// src/renderer/src/orchestrators/bootstrap.ts
// P1-24/C-β: bootstrapApp - App 级跨域启动编排
// 依据：S-002 §2 铁律 2、S-002-补充-bootstrap生命周期
//
// 职责：协调 app/config/chat 三个 store 的启动顺序，并把本次订阅资源
// 聚合成 teardown 交给 App.vue 持有。ChatView 不拥有应用启动生命周期。

import { useAppStore } from '../stores/app'
import { useChatStore } from '../stores/chat'
import { useConfigStore } from '../stores/config'
import { useLive2dStore } from '../stores/live2d'
import type { Unsubscribe } from '@shared/ipc/contracts'

function aggregateTeardown(unsubs: Unsubscribe[]): Unsubscribe {
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    // 后注册的资源先释放，保持与建立顺序相反。
    for (let i = unsubs.length - 1; i >= 0; i--) {
      try {
        unsubs[i]()
      } catch {
        /* teardown best-effort；其余资源仍必须继续释放 */
      }
    }
    unsubs.length = 0
  }
}

/**
 * 执行一次应用启动尝试，返回该尝试的聚合 teardown。
 * 失败时先清理已建立的部分订阅，再进入 blocked，并返回空操作 teardown。
 */
export async function bootstrapApp(): Promise<Unsubscribe> {
  const appStore = useAppStore()
  const configStore = useConfigStore()
  const chatStore = useChatStore()
  const live2dStore = useLive2dStore()

  const unsubs: Unsubscribe[] = []
  const teardown = aggregateTeardown(unsubs)

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
    // P3A-23：Live2D 是 chat renderer 的公开投影；先订阅再 hydrate，避免 stage ready
    // 事件在首个快照请求返回前被丢弃。
    if (window.companion?.live2d) {
      unsubs.push(live2dStore.subscribe())
      await live2dStore.hydrate()
    }

    // 4. 恢复当前会话；只有没有当前会话时才新建
    await chatStore.hydrate()

    // 5. 就绪
    appStore.setBootStage('ready')
    return teardown
  } catch (err) {
    teardown()
    appStore.reportError({
      code: 'UNKNOWN',
      message: err instanceof Error ? err.message : '启动失败',
      severity: 'fatal',
      retryable: false
    })
    return () => {}
  }
}
