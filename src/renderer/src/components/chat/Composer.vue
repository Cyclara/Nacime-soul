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

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore } from '../../stores/chat'
import { useConfigStore } from '../../stores/config'
import { useVoiceStore } from '../../stores/voice'
import { createVoiceChatOrchestrator } from '../../orchestrators/voice-chat'

const chatStore = useChatStore()
const configStore = useConfigStore()
const voiceStore = useVoiceStore()
const { canSend, isStreaming } = storeToRefs(chatStore)
const { state: configState } = storeToRefs(configStore)

const toggleError = ref<string | null>(null)

// ── P3B-18/19 语音输入闭环（S-006-补充 §1.7.6）：麦克风 → VAD → ASR → draft/send ──
// 跨 store 流程在 orchestrators/voice-chat.ts；组件只读状态、发指令。
// 发送模式真源：config ui.onboarding.voiceSendMode（未设 = 确认后发送）。
const voiceChat = createVoiceChatOrchestrator({
  voice: voiceStore,
  chat: chatStore,
  getSendMode: () =>
    (configState.value.saved?.ui.onboarding.voiceSendMode ??
      configState.value.draft?.ui.onboarding.voiceSendMode ??
      'draft') as 'draft' | 'send'
})
const micListening = ref(false)
const micError = ref<string | null>(null)
const micBusy = ref(false)
let unsubscribeVoice: (() => void) | null = null

/** ASR 就绪（选中引擎模型 ready）才让麦克风可点；未就绪时按钮给出去设置页的提示。 */
const micAvailable = computed(() => voiceStore.canListen)
const micTitle = computed(() => {
  if (micListening.value) return '停止语音输入'
  if (!micAvailable.value) return '语音识别模型还没准备好，去「设置 → 语音」下载'
  return '按一下开始说话，说完停顿会自动转成文字'
})
const speaking = computed(() => voiceStore.state.speaking)

async function onToggleMic(): Promise<void> {
  if (micBusy.value) return
  micBusy.value = true
  micError.value = null
  try {
    if (micListening.value) {
      await voiceChat.stop()
      micListening.value = false
    } else {
      if (!micAvailable.value) {
        micError.value = '语音识别模型还没准备好，先去「设置 → 语音」下载'
        return
      }
      await voiceChat.start(voiceStore.state.inputDeviceId)
      micListening.value = voiceChat.listening
      if (!voiceChat.listening) micError.value = voiceChat.lastError
    }
  } finally {
    micBusy.value = false
  }
}

async function onStopSpeaking(): Promise<void> {
  await voiceChat.interruptSpeech()
}

onMounted(() => {
  // voice store 的 overview/事件订阅：canListen 与 speaking 依赖它。
  // 语音是增强通道：preload 缺 voice 命名空间（旧测试夹具/未来裁剪构建）时静默跳过，
  // 麦克风按钮保持「未就绪」态，文字输入零影响。
  if (window.companion?.voice === undefined) return
  void voiceStore.hydrate().catch(() => {})
  unsubscribeVoice = voiceStore.subscribe()
})

onBeforeUnmount(() => {
  unsubscribeVoice?.()
  unsubscribeVoice = null
  voiceChat.dispose()
})

// 采集端异常（设备拔出/权限撤销）会让 orchestrator 自行停止；把按钮状态跟回来
watch(
  () => voiceStore.state.listening,
  (value) => {
    if (!value && micListening.value && !voiceChat.listening) {
      micListening.value = false
      micError.value = voiceChat.lastError
    }
  }
)

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
      <button
        v-if="speaking"
        type="button"
        class="speaking-pill"
        title="让她停下来（文字会继续显示）"
        @click="onStopSpeaking"
      >
        <span class="speaking-pill__wave" aria-hidden="true"> <i /><i /><i /> </span>
        她在说话 · 点一下让她停下
      </button>
      <span id="composer-shortcut-hint" class="shortcut-hint">Enter 发送 · Shift+Enter 换行</span>
      <span v-if="toggleError" class="toggle-error">{{ toggleError }}</span>
      <span v-if="micError" class="toggle-error" role="alert">{{ micError }}</span>
    </div>
    <div class="composer" :class="{ 'is-listening': micListening }">
      <button
        type="button"
        class="mic-btn"
        :class="{
          'is-on': micListening,
          'is-speaking': micListening && voiceStore.state.vadActive,
          'is-unavailable': !micAvailable && !micListening
        }"
        :aria-pressed="micListening"
        :aria-label="micTitle"
        :title="micTitle"
        :disabled="micBusy"
        @click="onToggleMic"
      >
        <svg class="mic-btn__icon" viewBox="0 0 24 24" aria-hidden="true">
          <rect x="9" y="3" width="6" height="11" rx="3" />
          <path d="M6 11a6 6 0 0 0 12 0" fill="none" stroke="currentColor" stroke-width="1.8" />
          <path
            d="M12 17v3M9 20h6"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
          />
        </svg>
        <span
          v-if="micListening"
          class="mic-btn__level"
          :style="{ '--level': Math.min(1, voiceStore.state.micLevel) }"
          aria-hidden="true"
        />
      </button>
      <textarea
        class="input"
        aria-label="输入给 Nacime 的消息"
        aria-describedby="composer-shortcut-hint"
        :placeholder="
          micListening
            ? voiceStore.state.vadActive
              ? '在听你说……'
              : '说吧，我听着'
            : '想和 Nacime 说些什么……'
        "
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

/* 语音输入中：整条输入区带一圈柔和呼吸光，提示「她在听」 */
.composer.is-listening {
  border-color: color-mix(in srgb, var(--color-accent) 56%, var(--color-border));
  animation: composer-listening 2.4s ease-in-out infinite;
}

@keyframes composer-listening {
  0%,
  100% {
    box-shadow:
      0 0 0 2px var(--color-accent-soft),
      var(--shadow-md);
  }
  50% {
    box-shadow:
      0 0 0 5px color-mix(in srgb, var(--color-accent) 22%, transparent),
      var(--shadow-md);
  }
}

/* ── 麦克风按钮（P3B-18 语音输入入口）── */
.mic-btn {
  position: relative;
  display: grid;
  align-self: stretch;
  width: 48px;
  min-height: 48px;
  flex: 0 0 auto;
  place-items: center;
  overflow: hidden;
  border: 1px solid transparent;
  border-radius: 14px;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    background 0.18s ease,
    color 0.18s ease,
    border-color 0.18s ease;
}

.mic-btn:hover:not(:disabled) {
  background: var(--color-accent-soft);
  color: var(--color-text-secondary);
}

.mic-btn:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

.mic-btn:disabled {
  cursor: progress;
  opacity: 0.6;
}

.mic-btn.is-unavailable {
  color: var(--color-text-muted);
  opacity: 0.55;
}

.mic-btn.is-on {
  border-color: color-mix(in srgb, var(--color-accent) 40%, transparent);
  background: var(--color-accent-soft-hover);
  color: var(--color-accent);
}

.mic-btn.is-speaking {
  color: var(--color-text-on-accent);
  background: var(--color-accent);
}

.mic-btn__icon {
  position: relative;
  z-index: 1;
  width: 20px;
  height: 20px;
  fill: currentColor;
}

/* 输入电平：从底部升起的软填充，随 --level(0..1) 变化 */
.mic-btn__level {
  position: absolute;
  inset: auto 0 0;
  height: calc(var(--level, 0) * 100%);
  background: color-mix(in srgb, var(--color-accent) 28%, transparent);
  transition: height 0.08s linear;
  pointer-events: none;
}

/* ── 她在说话 pill（P3B-18 speaking 状态 + cancel-speaking 入口）── */
.speaking-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  min-height: 28px;
  padding: 4px 12px 4px 8px;
  border: 1px solid color-mix(in srgb, var(--color-accent) 30%, transparent);
  border-radius: var(--radius-full);
  background: var(--color-accent-soft);
  color: var(--color-accent);
  font-size: var(--font-size-xs);
  font-weight: 500;
  cursor: pointer;
  transition: background 0.18s ease;
}

.speaking-pill:hover {
  background: var(--color-accent-soft-hover);
}

.speaking-pill__wave {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 12px;
}

.speaking-pill__wave i {
  display: block;
  width: 3px;
  height: 100%;
  border-radius: 2px;
  background: currentColor;
  transform-origin: bottom;
  animation: speaking-wave 0.9s ease-in-out infinite;
}

.speaking-pill__wave i:nth-child(2) {
  animation-delay: 0.15s;
}

.speaking-pill__wave i:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes speaking-wave {
  0%,
  100% {
    transform: scaleY(0.35);
  }
  50% {
    transform: scaleY(1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .composer.is-listening {
    animation: none;
  }

  .speaking-pill__wave i {
    animation: none;
    transform: scaleY(0.7);
  }
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
    flex-basis: calc(100% - 150px);
  }

  .send-btn,
  .stop-btn {
    min-width: 70px;
  }

  .mic-btn {
    width: 44px;
  }
}
</style>
