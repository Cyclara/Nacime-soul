<script setup lang="ts">
// P1-24: Composer - 输入框 + 发送/停止按钮 + 思考模式开关
// 依据：S-001 P1-24、S-002 §3.2 canSend/isStreaming
// 无业务逻辑：只调用 store.setDraft/send/stop + config.patch/save
//
// 思考模式开关（2026-07-15 加入）：
//   - 位置：输入框上方左侧
//   - 状态跟配置走（永久记忆）：thinkingEnabled ↔ config.model.reasoningEffort
//   - 2026-08-20（用户拍板）：开启时恢复"上次使用的档位"，不再一律回 high
//   - 厂商不支持时（supportsThinking=false）禁用：如 Moonshot（thinkingFormat='none'）
//   - 依据：https://api-docs.deepseek.com/zh-cn/guides/thinking_mode

import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore } from '../../stores/chat'
import { useConfigStore } from '../../stores/config'

const chatStore = useChatStore()
const configStore = useConfigStore()
const { canSend, isStreaming } = storeToRefs(chatStore)
const { state: configState } = storeToRefs(configStore)

const toggleError = ref<string | null>(null)

// 思考模式开关：从 config.model.reasoningEffort 派生
// 2026-08-20（用户拍板）：开启时恢复"上次使用的档位"，不再一律回 high——
// 设置页可选 low/medium/high，任何非 off 值都会被记住（含设置页修改），
// 开关只在 off ↔ 上次档位之间切换。
const lastNonOffEffort = ref<'low' | 'medium' | 'high'>('high')

watch(
  () => configState.value.draft?.model.reasoningEffort,
  (effort) => {
    if (effort !== undefined && effort !== 'off') lastNonOffEffort.value = effort
  },
  { immediate: true }
)

const thinkingEnabled = computed(() => {
  const effort = configState.value.draft?.model.reasoningEffort
  return effort !== undefined && effort !== 'off'
})

// 当前 provider/model 是否支持思考模式（compat 层判定）
// draft 或 saved 中任一认为支持即启用（HMR 后 draft 可能未重新加载）
const supportsThinking = computed(() => {
  const draftVal = configState.value.draft?.model.supportsThinking
  if (draftVal === true) return true
  const savedVal = configState.value.saved?.model.supportsThinking
  return savedVal === true
})

function onInput(e: Event): void {
  // IME 组合期间跳过草稿写入：等 compositionend 后再用完整文本更新，
  // 避免拼音/候选中间态进入 draft（S-01 修复）。
  if ((e as InputEvent).isComposing) return
  const target = e.target as HTMLTextAreaElement
  chatStore.setDraft(target.value)
}

function onEnter(e: KeyboardEvent): void {
  // IME 组合期间按 Enter 是"确认候选词"，不是发送（S-01 修复）。
  // keyCode 229 兜底浏览器不设 isComposing 的情况。
  if (e.isComposing || e.keyCode === 229) return
  if (e.shiftKey) return
  e.preventDefault()
  if (canSend.value) {
    void chatStore.send()
  }
}

function onSend(): void {
  if (canSend.value) {
    void chatStore.send()
  }
}

function onStop(): void {
  void chatStore.stop()
}

async function onToggleThinking(): Promise<void> {
  if (!supportsThinking.value) return
  toggleError.value = null
  const next = thinkingEnabled.value ? 'off' : lastNonOffEffort.value
  configStore.patch('model', { reasoningEffort: next })
  const ok = await configStore.save()
  if (!ok) {
    toggleError.value = '思考模式切换失败，请重试'
  }
}

// “显示思考过程”开关：控制 UI 是否渲染 reasoning_content（与思考模式开关独立）
const showReasoning = computed(() => {
  const draftVal = configState.value.draft?.ui.chat.showReasoning
  if (draftVal !== undefined) return draftVal
  return configState.value.saved?.ui.chat.showReasoning ?? true
})

async function onToggleShowReasoning(): Promise<void> {
  toggleError.value = null
  const currentChat = configState.value.draft?.ui.chat
  if (!currentChat) return
  const next = !showReasoning.value
  // patch 对嵌套对象只做顶层浅合并：ui.chat 必须整体替换，否则 sendOnEnter/showTimestamps 会丢
  configStore.patch('ui', { chat: { ...currentChat, showReasoning: next } })
  const ok = await configStore.save()
  if (!ok) {
    toggleError.value = '显示思考过程切换失败，请重试'
  }
}
</script>

<template>
  <div class="composer-wrapper">
    <div class="thinking-toggle-row">
      <button
        class="thinking-toggle"
        :class="{ 'is-on': thinkingEnabled, 'is-disabled': !supportsThinking }"
        :disabled="!supportsThinking"
        :title="supportsThinking ? '' : '当前模型不支持思考模式'"
        :aria-pressed="thinkingEnabled"
        @click="onToggleThinking"
      >
        <span class="toggle-label">思考模式</span>
        <span class="toggle-track">
          <span class="toggle-thumb"></span>
        </span>
        <span class="toggle-state">{{ thinkingEnabled ? '开' : '关' }}</span>
      </button>
      <button
        class="reasoning-visibility-toggle"
        :class="{ 'is-on': showReasoning }"
        title="是否显示思考过程"
        :aria-pressed="showReasoning"
        @click="onToggleShowReasoning"
      >
        显示思考
      </button>
      <span id="composer-shortcut-hint" class="shortcut-hint">Enter 发送 · Shift+Enter 换行</span>
      <span v-if="toggleError" class="toggle-error">{{ toggleError }}</span>
    </div>
    <div class="composer">
      <textarea
        class="input"
        aria-label="输入给 Nacime 的消息"
        aria-describedby="composer-shortcut-hint"
        placeholder="想和 Nacime 说些什么……"
        :value="chatStore.state.draft"
        rows="2"
        @input="onInput"
        @keydown.enter="onEnter"
      />
      <button v-if="!isStreaming" class="send-btn" :disabled="!canSend" @click="onSend">
        发送
      </button>
      <button v-else class="stop-btn" @click="onStop">停止</button>
    </div>
  </div>
</template>

<style scoped>
.composer-wrapper {
  position: relative;
  z-index: 4;
  display: flex;
  flex-direction: column;
  padding: 8px 16px 16px;
  border-top: 1px solid var(--color-border-subtle);
  background: linear-gradient(180deg, transparent, var(--color-bg-secondary) 30%);
  backdrop-filter: blur(18px);
}

.thinking-toggle-row,
.composer {
  width: min(100%, 1040px);
  margin-inline: auto;
}

.thinking-toggle-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  min-height: 34px;
  gap: 5px;
  padding: 0 4px 7px;
}

.thinking-toggle {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 30px;
  padding: 4px 8px;
  border-radius: var(--radius-full);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.thinking-toggle:hover:not(.is-disabled) {
  background: var(--color-accent-soft);
  color: var(--color-text-secondary);
}

.thinking-toggle.is-disabled {
  cursor: not-allowed;
  opacity: 0.48;
}

.toggle-label {
  font-weight: 500;
  letter-spacing: 0.01em;
}

/* 滑动开关：track 是圆角胶囊，thumb 左右滑动 */
.toggle-track {
  position: relative;
  width: 32px;
  height: 18px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 9px;
  background: var(--color-bg-tertiary);
  transition: background 0.2s ease;
}

.toggle-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--color-text-muted);
  box-shadow: var(--shadow-sm);
  transition:
    left 0.2s ease,
    background 0.2s ease;
}

.thinking-toggle.is-on .toggle-track {
  border-color: color-mix(in srgb, var(--color-accent) 44%, transparent);
  background: var(--color-accent-soft-hover);
}

.thinking-toggle.is-on .toggle-thumb {
  left: 16px;
  background: var(--color-accent);
}

.toggle-state {
  min-width: 14px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.thinking-toggle.is-on .toggle-state {
  color: var(--color-accent);
  font-weight: 600;
}

.shortcut-hint {
  margin-left: auto;
  color: var(--color-text-muted);
  font-size: 10px;
  letter-spacing: 0.01em;
  white-space: nowrap;
}

.toggle-error {
  flex-basis: 100%;
  padding-left: 8px;
  color: var(--color-error);
  font-size: var(--font-size-xs);
}

.reasoning-visibility-toggle {
  min-height: 28px;
  padding: 4px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-full);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.reasoning-visibility-toggle:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
}

.reasoning-visibility-toggle.is-on {
  border-color: color-mix(in srgb, var(--color-accent) 26%, transparent);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.composer {
  display: flex;
  align-items: stretch;
  gap: 8px;
  padding: 7px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 20px;
  background: var(--color-surface-elevated);
  box-shadow:
    var(--shadow-glow),
    inset 0 1px rgba(255, 255, 255, 0.035);
  transition:
    border-color 0.18s ease,
    box-shadow 0.18s ease;
}

.composer:focus-within {
  border-color: color-mix(in srgb, var(--color-accent) 48%, var(--color-border));
  box-shadow:
    0 0 0 3px var(--color-accent-soft),
    var(--shadow-md);
}

.input {
  flex: 1;
  min-width: 0;
  min-height: 50px;
  max-height: 160px;
  padding: 10px 12px;
  border: 0;
  border-radius: 14px;
  background: transparent;
  color: var(--color-text);
  font-size: 15px;
  line-height: 1.55;
  user-select: text;
}

.input::placeholder {
  color: var(--color-text-muted);
}

.send-btn,
.stop-btn {
  align-self: stretch;
  min-width: 78px;
  min-height: 48px;
  padding: 9px 18px;
  border-radius: 14px;
  font-size: var(--font-size-base);
  font-weight: 650;
  letter-spacing: 0.02em;
}

.send-btn {
  background: var(--color-accent);
  color: var(--color-text-on-accent);
  box-shadow:
    inset 0 1px rgba(255, 255, 255, 0.24),
    var(--shadow-sm);
}

.send-btn:hover:not(:disabled) {
  background: var(--color-accent-hover);
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}

.stop-btn {
  background: var(--color-error-bg);
  color: var(--color-error);
  box-shadow: inset 0 0 0 1px var(--color-error-border);
}

.stop-btn:hover {
  background: color-mix(in srgb, var(--color-error-bg) 76%, var(--color-error) 10%);
}

@media (max-width: 620px) {
  .composer-wrapper {
    padding-inline: 10px;
    padding-bottom: 10px;
  }

  .composer {
    flex-wrap: wrap;
  }

  .input {
    flex-basis: calc(100% - 96px);
  }

  .send-btn,
  .stop-btn {
    min-width: 70px;
  }
}
</style>
