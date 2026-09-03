<script setup lang="ts">
// P3B-18（S-006-补充 §1.2.1 TtsProviderCard + EarlyPlaybackSettings）：
// 语音朗读开关 / provider 与音色状态 / 「提前朗读」开关 / 语音输入发送模式 / 试听。
//
// 纪律：写配置只走既有 config store patch→save（tts 域 + ui.onboarding.voiceSendMode），
// 试听/取消走 voice store（→ voice:test-tts / cancel-speaking）；组件不拼 IPC。
// 音色不在这里选：Edge 占位是 dev/test 专用（生产资格门拒绝），GPT-SoVITS 的音色库
// 配置面待冻结——先把 voiceId 当一个可填的字段暴露，空 = 纯文字（裁定二）。
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useConfigStore } from '../../stores/config'
import { useVoiceStore } from '../../stores/voice'

const config = useConfigStore()
const voice = useVoiceStore()
const { state: configState } = storeToRefs(config)

const saveError = ref<string | null>(null)
const testText = ref('你好呀，我在这里。')

const draft = computed(() => configState.value.draft?.tts ?? null)
const enabled = computed(() => draft.value?.enabled === true)
const earlyPlayback = computed(() => draft.value?.earlyPlaybackEnabled === true)
const voiceId = computed(() => draft.value?.voiceId ?? '')
const providerId = computed(() => draft.value?.provider ?? voice.state.tts?.providerId ?? '')
const providerOptions = computed(() => voice.state.tts?.providers ?? [])
const voiceOptions = computed(() =>
  (voice.state.tts?.voices ?? []).filter((option) => option.providerId === providerId.value)
)
const currentProvider = computed(() =>
  providerOptions.value.find((provider) => provider.id === providerId.value)
)
const sendMode = computed<'draft' | 'send'>(
  () => configState.value.draft?.ui.onboarding.voiceSendMode ?? 'draft'
)

const providerLabel = computed(() => {
  const option = currentProvider.value
  if (option !== undefined) return option.displayName
  if (providerId.value === 'edge') return '系统语音（开发占位）'
  if (providerId.value === 'gpt-sovits') return 'GPT-SoVITS（未发现本地整合包）'
  return providerId.value.length > 0 ? providerId.value : '未设置'
})

/** 三态状态点：可播 / 只有文字 / 关闭。 */
const status = computed<{ tone: 'ok' | 'warn' | 'off'; text: string }>(() => {
  const snapshot = voice.state.tts
  if (!enabled.value) return { tone: 'off', text: '语音朗读已关闭' }
  if (snapshot === null) return { tone: 'warn', text: '正在读取状态…' }
  if (currentProvider.value?.state === 'starting') {
    return { tone: 'warn', text: '正在加载 GPT-SoVITS 定制音色，第一次可能需要几分钟…' }
  }
  if (currentProvider.value?.state === 'failed') {
    return { tone: 'warn', text: 'GPT-SoVITS 启动失败；聊天仍会保留文字' }
  }
  if (providerId.value === 'gpt-sovits' && currentProvider.value === undefined) {
    return { tone: 'warn', text: '没有发现完整的本地 GPT-SoVITS 整合包' }
  }
  if (!snapshot.voiceConfigured) return { tone: 'warn', text: '还没有设置音色，只会显示文字' }
  if (!snapshot.hostAvailable) return { tone: 'warn', text: '播放通道还没准备好（角色窗口未就绪）' }
  if (snapshot.lastDegradedReason !== null) {
    return { tone: 'warn', text: `上一轮没能发声（${degradedCopy(snapshot.lastDegradedReason)}）` }
  }
  return { tone: 'ok', text: snapshot.speaking ? '正在说话' : '可以发声' }
})

function degradedCopy(reason: string): string {
  switch (reason) {
    case 'voice-missing':
      return '未设置音色'
    case 'provider-unhealthy':
      return '语音引擎不可用'
    case 'playback-host-unavailable':
      return '播放通道不可用'
    case 'chat-render-ack-timeout':
      return '文字未及时上屏'
    case 'synthesis-error':
      return '合成失败'
    case 'queue-overflow':
      return '回复过长'
    default:
      return '已退回文字'
  }
}

async function persist(): Promise<void> {
  saveError.value = null
  const ok = await config.save()
  if (!ok) saveError.value = '设置没有保存成功，请重试'
  else await voice.hydrateTts()
}

async function toggleEnabled(): Promise<void> {
  config.patch('tts', { enabled: !enabled.value })
  await persist()
}

async function toggleEarlyPlayback(): Promise<void> {
  config.patch('tts', { earlyPlaybackEnabled: !earlyPlayback.value })
  await persist()
}

async function selectProvider(event: Event): Promise<void> {
  const nextProvider = (event.target as HTMLSelectElement).value
  const firstVoice = voice.state.tts?.voices.find((item) => item.providerId === nextProvider)
  config.patch('tts', {
    provider: nextProvider,
    // GPT-SoVITS 的 discovered voice 可以安全自动选；Edge 不猜系统 voice（裁定二）。
    voiceId: firstVoice?.id ?? (nextProvider === providerId.value ? voiceId.value : '')
  })
  await persist()
}

async function selectVoice(event: Event): Promise<void> {
  config.patch('tts', { voiceId: (event.target as HTMLSelectElement).value })
  await persist()
}

async function setSendMode(mode: 'draft' | 'send'): Promise<void> {
  const onboarding = configState.value.draft?.ui.onboarding
  const ui = configState.value.draft?.ui
  if (!onboarding || !ui) return
  // patch 只做一层浅合并：ui.onboarding 整体替换，其余 ui 字段保持
  config.patch('ui', { onboarding: { ...onboarding, voiceSendMode: mode } })
  await persist()
}

let voiceIdTimer: ReturnType<typeof setTimeout> | null = null
function onVoiceIdInput(event: Event): void {
  const value = (event.target as HTMLInputElement).value
  config.patch('tts', { voiceId: value })
  if (voiceIdTimer !== null) clearTimeout(voiceIdTimer)
  voiceIdTimer = setTimeout(() => {
    voiceIdTimer = null
    void persist()
  }, 600)
}

async function onTest(): Promise<void> {
  if (voice.state.testingTts) {
    await voice.cancelSpeaking()
    return
  }
  await voice.testTts(testText.value)
}

let statusTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  void voice.hydrateTts()
  // GPT-SoVITS 冷启动状态没有额外 event 通道；设置页打开期间低频拉快照，ready 后
  // 状态自然变 running。只传 metadata，不传文本/路径。
  statusTimer = setInterval(() => {
    if (providerId.value === 'gpt-sovits' && enabled.value) void voice.hydrateTts()
  }, 1_500)
})

onBeforeUnmount(() => {
  if (voiceIdTimer !== null) clearTimeout(voiceIdTimer)
  if (statusTimer !== null) clearInterval(statusTimer)
  voiceIdTimer = null
  statusTimer = null
})
</script>

<template>
  <section class="tts-card" aria-labelledby="tts-card-title">
    <header class="tts-card__head">
      <div>
        <p class="tts-card__kicker">语音朗读</p>
        <h3 id="tts-card-title">让她把回复说出来</h3>
      </div>
      <button
        type="button"
        class="tts-switch"
        :class="{ 'is-on': enabled }"
        :aria-pressed="enabled"
        aria-label="语音朗读总开关"
        @click="toggleEnabled"
      >
        <span class="tts-switch__track"><span class="tts-switch__thumb" /></span>
        <span class="tts-switch__label">{{ enabled ? '开' : '关' }}</span>
      </button>
    </header>

    <div class="tts-card__status" :data-tone="status.tone" role="status" aria-live="polite">
      <span class="tts-card__dot" aria-hidden="true" />
      <span>{{ status.text }}</span>
    </div>

    <div class="tts-card__grid" :class="{ 'is-disabled': !enabled }">
      <label class="tts-field">
        <span class="tts-field__label">语音引擎</span>
        <select
          v-if="providerOptions.length > 0"
          class="tts-field__input"
          :value="providerId"
          :disabled="!enabled"
          @change="selectProvider"
        >
          <option v-for="provider in providerOptions" :key="provider.id" :value="provider.id">
            {{ provider.displayName }}
          </option>
        </select>
        <span v-else class="tts-field__value">{{ providerLabel }}</span>
        <span class="tts-field__hint">定制音色不可用时只显示文字，不会换成别的声音。</span>
      </label>

      <label class="tts-field">
        <span class="tts-field__label">音色</span>
        <select
          v-if="voiceOptions.length > 0"
          class="tts-field__input"
          :value="voiceId"
          :disabled="!enabled"
          @change="selectVoice"
        >
          <option v-for="option in voiceOptions" :key="option.id" :value="option.id">
            {{ option.displayName }}
          </option>
        </select>
        <input
          v-else
          class="tts-field__input"
          type="text"
          :value="voiceId"
          :disabled="!enabled"
          placeholder="留空 = 只显示文字"
          autocomplete="off"
          spellcheck="false"
          aria-describedby="tts-voice-hint"
          @input="onVoiceIdInput"
        />
        <span id="tts-voice-hint" class="tts-field__hint">
          <template v-if="providerId === 'gpt-sovits'">
            已从本地整合包读取训练权重与参考音频；外部文件不会被 Nacime 修改。
          </template>
          <template v-else>
            系统语音（开发占位）填 Windows 语音名，如「Microsoft Huihui Desktop」。
          </template>
        </span>
      </label>

      <button
        type="button"
        class="tts-toggle-row"
        :class="{ 'is-on': earlyPlayback }"
        :disabled="!enabled"
        :aria-pressed="earlyPlayback"
        @click="toggleEarlyPlayback"
      >
        <span class="tts-toggle-row__text">
          <strong>提前朗读</strong>
          <span> 回复还在生成时，说完一句就先读一句；关掉后等整段回复到齐再读。 </span>
        </span>
        <span class="tts-switch__track" :class="{ 'is-on': earlyPlayback }">
          <span class="tts-switch__thumb" />
        </span>
      </button>

      <fieldset class="tts-sendmode" :disabled="!enabled">
        <legend>语音输入说完之后</legend>
        <label class="tts-sendmode__option" :class="{ 'is-on': sendMode === 'draft' }">
          <input
            type="radio"
            name="voice-send-mode"
            value="draft"
            :checked="sendMode === 'draft'"
            @change="setSendMode('draft')"
          />
          <span>
            <strong>先放进输入框</strong>
            <span>看一眼转写有没有错，按发送才真正说出去（推荐）</span>
          </span>
        </label>
        <label class="tts-sendmode__option" :class="{ 'is-on': sendMode === 'send' }">
          <input
            type="radio"
            name="voice-send-mode"
            value="send"
            :checked="sendMode === 'send'"
            @change="setSendMode('send')"
          />
          <span>
            <strong>直接发送</strong>
            <span>说完就发，不确认——识别错了也会发出去</span>
          </span>
        </label>
      </fieldset>

      <div class="tts-test">
        <input
          v-model="testText"
          class="tts-field__input"
          type="text"
          :disabled="!enabled || voice.state.testingTts"
          maxlength="200"
          aria-label="试听文本"
        />
        <button
          type="button"
          class="tts-test__btn"
          :class="{ 'is-playing': voice.state.testingTts }"
          :disabled="!enabled || testText.trim().length === 0"
          @click="onTest"
        >
          {{ voice.state.testingTts ? '停下' : '试听' }}
        </button>
      </div>
    </div>

    <p v-if="voice.state.ttsError" class="tts-card__error" role="alert">
      {{ voice.state.ttsError }}
    </p>
    <p v-if="saveError" class="tts-card__error" role="alert">{{ saveError }}</p>
  </section>
</template>

<style scoped>
.tts-card {
  display: grid;
  gap: 0.7rem;
  padding: 0.95rem;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.12));
  border-radius: 12px;
  background: var(--color-surface, rgba(255, 255, 255, 0.05));
}

.tts-card__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.tts-card__kicker {
  margin: 0 0 0.15rem;
  color: var(--color-text-tertiary);
  font-size: 0.68rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.tts-card__head h3 {
  margin: 0;
  font-size: 0.98rem;
  font-weight: 600;
}

/* 开关（与 Composer 思考模式开关同族：胶囊 track + 滑动 thumb） */
.tts-switch {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  padding: 0.25rem 0.4rem;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--color-text-muted, rgba(255, 255, 255, 0.6));
  cursor: pointer;
  font-size: 0.78rem;
}

.tts-switch__track {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  flex: 0 0 auto;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.18));
  border-radius: 10px;
  background: var(--color-bg-tertiary, rgba(255, 255, 255, 0.08));
  transition:
    background 0.2s ease,
    border-color 0.2s ease;
}

.tts-switch__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--color-text-muted, rgba(255, 255, 255, 0.6));
  transition:
    left 0.2s ease,
    background 0.2s ease;
}

.tts-switch.is-on .tts-switch__track,
.tts-switch__track.is-on {
  border-color: color-mix(in srgb, var(--color-accent, #7c6cf0) 50%, transparent);
  background: color-mix(in srgb, var(--color-accent, #7c6cf0) 24%, transparent);
}

.tts-switch.is-on .tts-switch__thumb,
.tts-switch__track.is-on .tts-switch__thumb {
  left: 18px;
  background: var(--color-accent, #7c6cf0);
}

.tts-switch.is-on .tts-switch__label {
  color: var(--color-accent, #7c6cf0);
  font-weight: 600;
}

/* 状态行：色点 + 文案，三态 */
.tts-card__status {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: var(--color-text-secondary);
  font-size: 0.8rem;
}

.tts-card__dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.4;
}

.tts-card__status[data-tone='ok'] .tts-card__dot {
  background: #4cd964;
  box-shadow: 0 0 0.45rem rgba(76, 217, 100, 0.55);
  opacity: 1;
}

.tts-card__status[data-tone='warn'] .tts-card__dot {
  background: #ffb347;
  opacity: 1;
}

.tts-card__grid {
  display: grid;
  gap: 0.75rem;
}

/* 总开关关闭时仍保持说明文字可读，只让交互控件自己的 disabled 样式表达不可操作。 */
.tts-card__grid.is-disabled .tts-field__value,
.tts-card__grid.is-disabled .tts-field__hint,
.tts-card__grid.is-disabled .tts-field__label,
.tts-card__grid.is-disabled .tts-toggle-row__text,
.tts-card__grid.is-disabled .tts-sendmode {
  color: var(--color-text-secondary);
}

.tts-field {
  display: grid;
  gap: 0.25rem;
}

.tts-field__label {
  color: var(--color-text-tertiary);
  font-size: 0.72rem;
  letter-spacing: 0.04em;
}

.tts-field__value {
  font-size: 0.86rem;
  font-weight: 500;
}

.tts-field__hint {
  color: var(--color-text-muted);
  font-size: 0.72rem;
  line-height: 1.4;
}

.tts-field__input {
  min-width: 0;
  padding: 0.45rem 0.6rem;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.16));
  border-radius: 8px;
  background: var(--color-bg-tertiary, rgba(255, 255, 255, 0.06));
  color: inherit;
  font: inherit;
  font-size: 0.86rem;
}

.tts-field__input:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--color-accent, #7c6cf0) 60%, transparent);
  outline-offset: 1px;
}

.tts-field__input:disabled {
  color: var(--color-text-secondary);
  opacity: 0.78;
}

/* 提前朗读：整行可点的开关 */
.tts-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  border-radius: 10px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
  transition: background 0.18s ease;
}

.tts-toggle-row:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.04);
}

.tts-toggle-row:disabled {
  cursor: not-allowed;
}

.tts-toggle-row__text {
  display: grid;
  gap: 0.15rem;
}

.tts-toggle-row__text strong {
  font-size: 0.86rem;
  font-weight: 600;
}

.tts-toggle-row__text span {
  font-size: 0.72rem;
  line-height: 1.4;
  color: var(--color-text-muted);
}

/* 发送模式 */
.tts-sendmode {
  display: grid;
  gap: 0.4rem;
  margin: 0;
  padding: 0.55rem 0.7rem 0.65rem;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  border-radius: 10px;
}

.tts-sendmode legend {
  padding: 0 0.3rem;
  font-size: 0.72rem;
  letter-spacing: 0.04em;
  color: var(--color-text-muted);
}

.tts-sendmode__option {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  padding: 0.35rem 0.4rem;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.18s ease;
}

.tts-sendmode__option:hover {
  background: rgba(255, 255, 255, 0.04);
}

.tts-sendmode__option.is-on {
  background: color-mix(in srgb, var(--color-accent, #7c6cf0) 12%, transparent);
}

.tts-sendmode__option input {
  margin-top: 0.2rem;
  accent-color: var(--color-accent, #7c6cf0);
}

.tts-sendmode__option > span {
  display: grid;
  gap: 0.1rem;
}

.tts-sendmode__option strong {
  font-size: 0.84rem;
  font-weight: 600;
}

.tts-sendmode__option span span {
  font-size: 0.72rem;
  line-height: 1.4;
  color: var(--color-text-muted);
}

/* 试听 */
.tts-test {
  display: flex;
  gap: 0.5rem;
}

.tts-test .tts-field__input {
  flex: 1;
}

.tts-test__btn {
  flex: 0 0 auto;
  min-width: 4.2rem;
  padding: 0.45rem 0.9rem;
  border: 1px solid transparent;
  border-radius: 8px;
  background: var(--color-accent, #7c6cf0);
  color: #fff;
  cursor: pointer;
  font: inherit;
  font-size: 0.84rem;
  font-weight: 600;
  transition: background 0.18s ease;
}

.tts-test__btn:hover:not(:disabled) {
  filter: brightness(1.08);
}

.tts-test__btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.tts-test__btn.is-playing {
  background: var(--color-danger, #ff7a7a);
}

.tts-card__error {
  margin: 0;
  font-size: 0.78rem;
  color: var(--color-danger, #ff7a7a);
}
</style>
