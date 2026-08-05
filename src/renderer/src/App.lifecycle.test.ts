// @vitest-environment jsdom
// C-β：App 生命周期接线合同（vitest 未加载 Vue SFC 插件，源码接线 + 运行时宿主组合验证）。
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { createPinia } from 'pinia'
import { bootstrapApp } from './orchestrators/bootstrap'
import type { ChatStreamEvent } from '@shared/chat/types'

function setupCompanion(): {
  createSession: ReturnType<typeof vi.fn>
  chatListenerCount: () => number
} {
  const streamListeners = new Set<(event: ChatStreamEvent) => void>()
  const createSession = vi.fn(async () => ({ ok: true, data: { sessionId: 's1' } }))
  const companion = {
    app: {
      getInfo: vi.fn(async () => ({ ok: true, data: { version: '1.0.0' } })),
      onError: vi.fn(() => () => {})
    },
    window: {
      onState: vi.fn(() => () => {}),
      getState: vi.fn(async () => ({ ok: true, data: { maximized: false } }))
    },
    config: {
      get: vi.fn(async () => ({
        ok: true,
        data: {
          schemaVersion: 1,
          model: { hasApiKey: true },
          ui: { theme: 'dark' },
          tts: {},
          memory: {},
          security: {}
        }
      }))
    },
    chat: {
      createSession,
      // P2-43：模拟空库（全新用户），hydrate 落回 createSession
      getLastSession: vi.fn(async () => ({ ok: true, data: { sessionId: null } })),
      list: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
        ok: true,
        data: { sessionId, messages: [] }
      })),
      onStream: vi.fn((cb: (event: ChatStreamEvent) => void) => {
        streamListeners.add(cb)
        return () => streamListeners.delete(cb)
      })
    }
  }
  ;(window as unknown as { companion: unknown }).companion = companion
  return { createSession, chatListenerCount: () => streamListeners.size }
}

describe('C-β App bootstrap ownership', () => {
  let container: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(() => {
    container.remove()
  })

  it('实际 SFC 接线：bootstrap 只在 App，ChatView 不再拥有；App 有 teardown 与 matchMedia 清理', () => {
    const appSource = readFileSync(path.join(process.cwd(), 'src/renderer/src/App.vue'), 'utf8')
    const chatViewSource = readFileSync(
      path.join(process.cwd(), 'src/renderer/src/views/ChatView.vue'),
      'utf8'
    )

    expect(appSource).toContain("import { bootstrapApp } from './orchestrators/bootstrap'")
    expect(appSource).toContain('onUnmounted')
    expect(appSource).toContain("removeEventListener('change'")
    expect(appSource).toContain("previous === 'blocked' && stage === 'idle'")
    expect(chatViewSource).not.toContain('bootstrapApp')
  })

  it('ChatView 等价路由子树卸载再挂载时 createSession 总次数为 1；根卸载释放 chat listener', async () => {
    const { createSession, chatListenerCount } = setupCompanion()
    const routeVisible = ref(true)
    const ChatViewStub = defineComponent(() => () => h('div', { 'data-route': 'chat' }))
    const RootHost = defineComponent({
      setup() {
        let teardown: (() => void) | null = null
        onMounted(async () => {
          const candidate = (await bootstrapApp()) as unknown
          teardown = typeof candidate === 'function' ? (candidate as () => void) : null
        })
        onUnmounted(() => teardown?.())
        return () => (routeVisible.value ? h(ChatViewStub) : h('div', { 'data-route': 'memory' }))
      }
    })

    const app = createApp(RootHost)
    app.use(createPinia())
    app.mount(container)
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1))

    routeVisible.value = false
    await nextTick()
    routeVisible.value = true
    await nextTick()

    expect(createSession).toHaveBeenCalledTimes(1)
    expect(chatListenerCount()).toBe(1)

    app.unmount()
    expect(chatListenerCount()).toBe(0)
  })
})
