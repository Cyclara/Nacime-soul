<script setup lang="ts">
// P1-24/P2-31: ChatShell - 聊天容器（消息列表 + 输入框 + 记忆面板入口）
// 依据：S-001 P1-24、S-006 §1.2（ChatHeader 菜单入口；当前用浮动按钮简化，前端模型可美化）
// 无业务逻辑：组合 MessageList + Composer + 记忆入口

import { computed } from 'vue'
import { useRouter } from 'vue-router'
import MessageList from './MessageList.vue'
import Composer from './Composer.vue'
import SelectionToolbar from './SelectionToolbar.vue'
import ChatSearch from './ChatSearch.vue'
import { useSettingsUiStore } from '../../stores/settings-ui'
import { useChatStore } from '../../stores/chat'
import Live2dPresenceButton from '../live2d/Live2dPresenceButton.vue'

const router = useRouter()
const settingsUi = useSettingsUiStore()
const chatStore = useChatStore()

// 2026-08-21 布局③：会呼吸的存在指示——只读 chat store 推导她的当下状态，
// 不写回任何 store：无轮次=慢慢听；有轮次但 assistant 还没出字=在想；开始出字=在回应。
const presencePhase = computed<'idle' | 'thinking' | 'responding'>(() => {
  const turn = chatStore.state.activeTurn
  if (!turn) return chatStore.state.isSending ? 'thinking' : 'idle'
  const msg = chatStore.state.messages.find((m) => m.id === turn.assistantMessageId)
  return msg && msg.content.length > 0 ? 'responding' : 'thinking'
})
const PRESENCE_TEXT = { idle: '慢慢听你说', thinking: '在想…', responding: '在回应你' } as const
const presenceText = computed(() => PRESENCE_TEXT[presencePhase.value])
</script>

<template>
  <div class="chat-shell">
    <div class="ambient-glow" aria-hidden="true"></div>
    <header class="chat-header">
      <div class="header-inner">
        <div class="companion-identity">
          <span class="companion-avatar" aria-hidden="true">N</span>
          <span class="identity-copy">
            <strong>Nacime</strong>
            <span class="presence" :data-phase="presencePhase" role="status" aria-live="polite"
              ><i aria-hidden="true"></i
              ><span :key="presencePhase" class="presence-text">{{ presenceText }}</span></span
            >
          </span>
          <!-- P2-44：聊天记录搜索入口（放大镜在标题旁，用户指定位置） -->
          <ChatSearch />
          <Live2dPresenceButton />
        </div>
        <div class="header-actions">
          <button
            class="memory-entry"
            aria-label="查看她的记忆"
            title="她的记忆"
            @click="router.push('/memory')"
          >
            <span class="memory-glyph" aria-hidden="true">◌</span>
            <span>她的记忆</span>
          </button>
          <button
            class="settings-entry"
            aria-label="打开设置"
            title="设置"
            @click="settingsUi.open('appearance')"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M12 8.35A3.65 3.65 0 1 0 12 15.65 3.65 3.65 0 0 0 12 8.35Zm8.1 4.7v-2.1l-2.02-.72a6.7 6.7 0 0 0-.65-1.55l.92-1.94-1.49-1.49-1.94.92a6.7 6.7 0 0 0-1.55-.65L12.65 3h-2.1l-.72 2.02a6.7 6.7 0 0 0-1.55.65l-1.94-.92-1.49 1.49.92 1.94a6.7 6.7 0 0 0-.65 1.55l-2.02.72v2.1l2.02.72c.15.55.37 1.07.65 1.55l-.92 1.94 1.49 1.49 1.94-.92c.48.28 1 .5 1.55.65l.72 2.02h2.1l.72-2.02a6.7 6.7 0 0 0 1.55-.65l1.94.92 1.49-1.49-.92-1.94c.28-.48.5-1 .65-1.55l2.02-.72Z"
              />
            </svg>
          </button>
        </div>
      </div>
    </header>
    <MessageList />
    <!-- M-18：发送/流式失败错误条（此前 lastError 只写不渲染，用户看不到失败原因） -->
    <div v-if="chatStore.state.lastError" class="send-error" role="alert">
      <span class="send-error-text">{{ chatStore.state.lastError.message }}</span>
      <button
        class="send-error-close"
        aria-label="关闭提示"
        title="关闭"
        @click="chatStore.clearLastError()"
      >
        ×
      </button>
    </div>
    <!-- 验收反馈⑦：选择模式工具条（右键气泡 → 选择）——批量按轮删除/清空会话 -->
    <SelectionToolbar v-if="chatStore.selectionMode" />
    <Composer />
  </div>
</template>

<style scoped>
.chat-shell {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.035) 100%);
}

.ambient-glow {
  position: absolute;
  z-index: 0;
  top: 8%;
  left: 50%;
  width: min(52vw, 620px);
  aspect-ratio: 1;
  border-radius: 50%;
  background: radial-gradient(circle, var(--color-companion-soft), transparent 68%);
  filter: blur(26px);
  opacity: 0.62;
  pointer-events: none;
  transform: translateX(-50%);
  animation: breathe 9s ease-in-out infinite;
}

.chat-header {
  position: relative;
  z-index: 5;
  min-height: 64px;
  padding: 10px 20px;
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-surface-translucent);
  backdrop-filter: blur(18px) saturate(115%);
}

.header-inner {
  display: flex;
  width: min(100%, 1040px);
  min-height: 44px;
  align-items: center;
  justify-content: space-between;
  margin-inline: auto;
}

.companion-identity {
  display: flex;
  align-items: center;
  gap: 11px;
}

.companion-avatar {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--color-companion) 34%, var(--color-border));
  border-radius: 14px 14px 14px 6px;
  background:
    linear-gradient(145deg, var(--color-companion-soft), var(--color-accent-soft)),
    var(--color-surface-elevated);
  box-shadow:
    inset 0 1px rgba(255, 255, 255, 0.08),
    var(--shadow-sm);
  color: var(--color-companion);
  font-family: var(--font-family-display);
  font-size: 19px;
  font-weight: 600;
}

.identity-copy {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.identity-copy strong {
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: 17px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.presence {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.presence i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-companion);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--color-companion) 12%, transparent);
  /* 布局③：idle 慢呼吸（4.6s），像睡着了一样安稳。
     2026-08-21 验收反馈：起伏太含蓄看不出来——振幅/光环加大 */
  animation: presence-breathe 4.6s ease-in-out infinite;
}

/* 在想：短促的专注脉搏 */
.presence[data-phase='thinking'] i {
  animation: presence-pulse 1.15s ease-in-out infinite;
}

/* 在回应：说话般的稳定节律 */
.presence[data-phase='responding'] i {
  animation: presence-breathe 1.7s ease-in-out infinite;
}

.presence[data-phase='thinking'] .presence-text {
  color: var(--color-companion);
}

/* 阶段切换时文字轻轻浮入（:key 重挂载触发） */
.presence-text {
  animation: presence-text-in 0.24s ease;
  transition: color 0.2s ease;
}

@keyframes presence-breathe {
  0%,
  100% {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-companion) 8%, transparent);
    opacity: 0.42;
    transform: scale(0.74);
  }

  50% {
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--color-companion) 16%, transparent);
    opacity: 1;
    transform: scale(1.12);
  }
}

@keyframes presence-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--color-companion) 9%, transparent);
    opacity: 0.5;
    transform: scale(0.78);
  }

  50% {
    box-shadow: 0 0 0 5px color-mix(in srgb, var(--color-companion) 17%, transparent);
    opacity: 1;
    transform: scale(1.1);
  }
}

@keyframes presence-text-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.memory-entry {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  min-height: 36px;
  padding: 7px 12px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: var(--color-accent-soft);
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.04);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  font-weight: 500;
}

.memory-glyph {
  color: var(--color-companion);
  font-family: var(--font-family-display);
  font-size: 19px;
  line-height: 1;
  transform: rotate(-8deg);
}

.memory-entry:hover {
  border-color: color-mix(in srgb, var(--color-accent) 35%, transparent);
  background: var(--color-accent-soft-hover);
  box-shadow: var(--shadow-sm);
  color: var(--color-text);
  transform: translateY(-1px);
}

.settings-entry {
  display: grid;
  width: 36px;
  height: 36px;
  place-items: center;
  border: 1px solid var(--color-border-subtle);
  border-radius: 50%;
  background: var(--color-surface-elevated);
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.05);
  color: var(--color-text-muted);
}

.settings-entry svg {
  width: 16px;
  height: 16px;
  fill: currentColor;
}

.settings-entry:hover {
  border-color: color-mix(in srgb, var(--color-accent) 35%, var(--color-border));
  background: var(--color-accent-soft);
  box-shadow: var(--shadow-sm);
  color: var(--color-accent);
  transform: translateY(-1px) rotate(5deg);
}

@keyframes breathe {
  0%,
  100% {
    opacity: 0.48;
    transform: translateX(-50%) scale(0.96);
  }
  50% {
    opacity: 0.7;
    transform: translateX(-50%) scale(1.04);
  }
}

@media (max-width: 520px) {
  .chat-header {
    min-height: 58px;
    padding-inline: 14px;
  }

  .memory-entry {
    width: 38px;
    padding-inline: 0;
  }

  .memory-entry > span:last-child {
    display: none;
  }
}

/* M-18：发送/流式失败错误条 */
.send-error {
  display: flex;
  width: min(100%, 1040px);
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 0 auto 6px;
  padding: 8px 12px;
  border: 1px solid var(--color-error-border);
  border-radius: var(--radius);
  background: var(--color-error-bg);
  color: var(--color-error);
  font-size: var(--font-size-xs);
}

.send-error-text {
  line-height: 1.5;
}

.send-error-close {
  display: grid;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  place-items: center;
  border-radius: 50%;
  color: var(--color-error);
  font-family: var(--font-family-display);
  font-size: 18px;
  line-height: 1;
}

.send-error-close:hover {
  background: color-mix(in srgb, var(--color-error) 14%, transparent);
}
</style>
