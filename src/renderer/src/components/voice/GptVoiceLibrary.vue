<script setup lang="ts">
// P3V-18/20：本地音色库 + 从本机导入。首次设置与设置页复用同一张卡。
//
// 路径红线：三个文件由 main 原生 dialog 挑选并暂存在 main；本组件只拿得到**文件名**
// 用于回显，永远看不到目录。首版不分发任何角色音色，只做本机导入。
//
// 诚实纪律：提示词（参考音频里到底说了什么）必须用户自己填——绝不从文件名猜。

import { computed, ref } from 'vue'
import {
  GPT_VOICE_LANGS,
  GPT_VOICE_VERSIONS,
  type GptVoiceFileKind
} from '@shared/voice/gpt-runtime-types'
import { useConfigStore } from '../../stores/config'
import { useVoiceStore } from '../../stores/voice'

const config = useConfigStore()
const voice = useVoiceStore()

const FILE_FIELDS: readonly { kind: GptVoiceFileKind; label: string; hint: string }[] = [
  { kind: 'gpt-weights', label: 'GPT 权重', hint: '.ckpt' },
  { kind: 'sovits-weights', label: 'SoVITS 权重', hint: '.pth' },
  { kind: 'ref-audio', label: '参考音频', hint: '3–10 秒的干净人声' }
]

const LANG_LABELS: Readonly<Record<string, string>> = {
  zh: '中文',
  ja: '日语',
  en: '英语',
  ko: '韩语',
  yue: '粤语',
  auto: '自动判断',
  auto_yue: '自动判断（含粤语）',
  all_zh: '整段按中文',
  all_ja: '整段按日语',
  all_ko: '整段按韩语',
  all_yue: '整段按粤语'
}

const formOpen = ref(false)
const displayName = ref('')
const version = ref('v2Pro')
const promptText = ref('')
const promptLang = ref('zh')
const defaultTextLang = ref('zh')
const importing = ref(false)
const saveError = ref<string | null>(null)

const voices = computed(() => voice.gptVoices)
const staged = computed(() => voice.state.gptVoiceStagedFiles)
/** 有音色但这一轮没有可用运行环境：如实说清「只会显示文字」，不假装能发声。 */
const voicelessNotice = computed(
  () => voices.value.length > 0 && !voice.gptRuntimeReady && voice.state.gptRuntime !== null
)
const missingFiles = computed(() =>
  FILE_FIELDS.filter((field) => staged.value[field.kind] === null)
)
const currentVoiceId = computed(() => config.state.draft?.tts.voiceId ?? '')

const canImport = computed(
  () =>
    !importing.value &&
    missingFiles.value.length === 0 &&
    displayName.value.trim().length > 0 &&
    promptText.value.trim().length > 0
)

/** 按不上「导入」时说清还差什么，而不是让按钮无声地灰着。 */
const importBlockReason = computed<string | null>(() => {
  if (missingFiles.value.length > 0) {
    return `还差：${missingFiles.value.map((field) => field.label).join('、')}`
  }
  if (displayName.value.trim().length === 0) return '给这个音色起个名字。'
  if (promptText.value.trim().length === 0) {
    return '请填写参考音频里实际说的那句话——这句话对不上，合成出来的声音会跑偏。'
  }
  return null
})

function langLabel(code: string): string {
  return LANG_LABELS[code] ?? code
}

function fileName(kind: GptVoiceFileKind): string {
  return staged.value[kind] ?? '未选择'
}

function pick(kind: GptVoiceFileKind): void {
  void voice.pickGptVoiceFile(kind)
}

function toggleForm(): void {
  formOpen.value = !formOpen.value
  saveError.value = null
}

async function submit(): Promise<void> {
  if (!canImport.value) return
  importing.value = true
  saveError.value = null
  try {
    const ok = await voice.importGptVoice({
      displayName: displayName.value.trim(),
      version: version.value,
      promptText: promptText.value.trim(),
      promptLang: promptLang.value,
      defaultTextLang: defaultTextLang.value
    })
    if (!ok) return
    displayName.value = ''
    promptText.value = ''
    formOpen.value = false
    // 音色列表也在语音朗读卡里出现，导入后立刻回读一次，避免那边还是旧列表
    await voice.hydrateTts()
  } finally {
    importing.value = false
  }
}

/** 设为当前音色：写 config `tts.voiceId`（唯一真源），绝不由程序替用户自动挑。 */
async function useVoice(voiceId: string): Promise<void> {
  saveError.value = null
  const option = voice.state.tts?.voices.find((item) => item.id === voiceId)
  config.patch('tts', { provider: option?.providerId ?? 'gpt-sovits', voiceId })
  const ok = await config.save()
  if (!ok) {
    saveError.value = '没有保存成功，请重试'
    return
  }
  await voice.hydrateTts()
}

async function remove(voiceId: string): Promise<void> {
  const ok = await voice.deleteGptVoice(voiceId)
  if (ok) await voice.hydrateTts()
}
</script>

<template>
  <section class="voice-library" aria-labelledby="voice-library-title">
    <header class="voice-library__header">
      <div>
        <p class="voice-library__eyebrow">她的声音</p>
        <h3 id="voice-library-title">本地音色</h3>
      </div>
      <span class="voice-library__count">
        {{ voices.length > 0 ? `${voices.length} 个可用` : '还没有音色' }}
      </span>
    </header>

    <p class="voice-library__description">
      Nacime 不附带来源不明的角色音色。把你自己的 GPT 权重、SoVITS 权重和一段参考音频
      从本机导入即可；文件留在原处，不会被复制或上传。
    </p>

    <ul v-if="voices.length > 0" class="voice-library__list">
      <li v-for="item in voices" :key="item.id" class="voice-library__item">
        <div class="voice-library__item-copy">
          <div class="voice-library__item-head">
            <strong>{{ item.displayName }}</strong>
            <span v-if="item.current || item.id === currentVoiceId" class="voice-library__badge">
              当前音色
            </span>
            <span v-if="item.source === 'discovered'" class="voice-library__badge">
              来自你的安装
            </span>
          </div>
          <small>
            {{ item.version }} · 参考音频{{ langLabel(item.promptLang) }} · 默认{{
              langLabel(item.defaultTextLang)
            }}
          </small>
          <small v-if="item.state === 'missing-files'" class="voice-library__missing">
            权重或参考音频不在原来的位置了，现在发不出声；接回磁盘后会自动恢复。
          </small>
        </div>

        <div class="voice-library__item-actions">
          <button
            v-if="item.state === 'ready' && !(item.current || item.id === currentVoiceId)"
            type="button"
            class="voice-library__button"
            @click="useVoice(item.id)"
          >
            设为当前音色
          </button>
          <button
            v-if="item.source === 'imported'"
            type="button"
            class="voice-library__button voice-library__button--quiet"
            @click="remove(item.id)"
          >
            删除
          </button>
        </div>
      </li>
    </ul>

    <p v-if="voicelessNotice" class="voice-library__notice" role="status">
      音色已经在这里了，但这一轮还没有可用的 GPT-SoVITS 运行环境，她只会显示文字。
    </p>

    <p v-if="saveError" class="voice-library__error" role="alert">{{ saveError }}</p>
    <p v-if="voice.state.gptRuntimeNotice" class="voice-library__notice" role="status">
      {{ voice.state.gptRuntimeNotice }}
    </p>

    <button
      type="button"
      class="voice-library__button voice-library__button--quiet voice-library__toggle"
      :aria-expanded="formOpen"
      aria-controls="voice-import-form"
      @click="toggleForm"
    >
      {{ formOpen ? '收起导入表单' : '从本机导入音色' }}
    </button>

    <form
      v-show="formOpen"
      id="voice-import-form"
      class="voice-library__form"
      @submit.prevent="submit"
    >
      <div class="voice-library__files">
        <div v-for="field in FILE_FIELDS" :key="field.kind" class="voice-library__file">
          <div class="voice-library__file-copy">
            <strong>{{ field.label }}</strong>
            <small>{{ field.hint }}</small>
          </div>
          <span
            class="voice-library__file-name"
            :class="{ 'voice-library__file-name--empty': staged[field.kind] === null }"
            :title="fileName(field.kind)"
          >
            {{ fileName(field.kind) }}
          </span>
          <button
            type="button"
            class="voice-library__button voice-library__button--quiet"
            @click="pick(field.kind)"
          >
            选择文件
          </button>
        </div>
      </div>

      <div class="voice-library__fields">
        <label class="voice-library__field">
          <span>音色名称</span>
          <input v-model="displayName" type="text" maxlength="40" placeholder="例如：奈奈 · 日常" />
        </label>

        <label class="voice-library__field">
          <span>模型版本</span>
          <select v-model="version">
            <option v-for="item in GPT_VOICE_VERSIONS" :key="item" :value="item">{{ item }}</option>
          </select>
        </label>

        <label class="voice-library__field">
          <span>参考音频语言</span>
          <select v-model="promptLang">
            <option v-for="item in GPT_VOICE_LANGS" :key="item" :value="item">
              {{ langLabel(item) }}
            </option>
          </select>
        </label>

        <label class="voice-library__field">
          <span>默认朗读语言</span>
          <select v-model="defaultTextLang">
            <option v-for="item in GPT_VOICE_LANGS" :key="item" :value="item">
              {{ langLabel(item) }}
            </option>
          </select>
        </label>
      </div>

      <label class="voice-library__field voice-library__field--wide">
        <span>参考音频里说的那句话</span>
        <textarea
          v-model="promptText"
          rows="2"
          maxlength="200"
          placeholder="一字不差地写下参考音频的内容"
        />
        <small> 必须与音频完全对应。文件名里的时间戳不算内容，Nacime 不会替你猜这句话。 </small>
      </label>

      <div class="voice-library__form-footer">
        <p v-if="importBlockReason" class="voice-library__blocked" role="status">
          {{ importBlockReason }}
        </p>
        <button type="submit" class="voice-library__button" :disabled="!canImport">
          {{ importing ? '正在导入…' : '导入这个音色' }}
        </button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.voice-library {
  display: grid;
  gap: 0.65rem;
  padding: 0.9rem 1rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-surface-elevated);
}

.voice-library__header,
.voice-library__item,
.voice-library__file,
.voice-library__form-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.voice-library h3,
.voice-library p,
.voice-library ul {
  margin: 0;
}

.voice-library__eyebrow {
  color: var(--color-text-tertiary);
  font-size: 0.64rem;
  font-weight: 650;
  letter-spacing: 0.07em;
  text-transform: uppercase;
}

.voice-library h3 {
  margin-top: 0.1rem;
  color: var(--color-text);
  font-size: 0.88rem;
}

.voice-library__count {
  color: var(--color-text-muted);
  font-size: 0.68rem;
  white-space: nowrap;
}

.voice-library__description {
  color: var(--color-text-secondary);
  font-size: 0.74rem;
  line-height: 1.55;
}

.voice-library__list {
  display: grid;
  gap: 0.35rem;
  padding: 0;
  list-style: none;
}

.voice-library__item {
  padding: 0.55rem 0.65rem;
  border-radius: var(--radius);
  background: var(--color-bg-tertiary);
}

.voice-library__item-copy {
  display: grid;
  gap: 0.15rem;
  min-width: 0;
}

.voice-library__item-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}

.voice-library__item-head strong {
  color: var(--color-text);
  font-size: 0.78rem;
}

.voice-library__badge {
  padding: 0.1rem 0.4rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  color: var(--color-text-secondary);
  font-size: 0.62rem;
}

.voice-library__item-copy small {
  color: var(--color-text-muted);
  font-size: 0.66rem;
  line-height: 1.5;
}

.voice-library__missing {
  color: var(--color-warning) !important;
}

.voice-library__item-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.35rem;
}

.voice-library__toggle {
  justify-self: start;
}

.voice-library__form {
  display: grid;
  gap: 0.65rem;
  padding: 0.75rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius);
  background: var(--color-bg-tertiary);
}

.voice-library__files {
  display: grid;
  gap: 0.35rem;
}

.voice-library__file-copy {
  display: grid;
  gap: 0.1rem;
  min-width: 0;
}

.voice-library__file-copy strong {
  color: var(--color-text);
  font-size: 0.72rem;
}

.voice-library__file-copy small,
.voice-library__file-name {
  color: var(--color-text-muted);
  font-size: 0.64rem;
}

.voice-library__file-name {
  overflow: hidden;
  flex: 1 1 auto;
  max-width: 16rem;
  color: var(--color-text);
  font-family: ui-monospace, 'Cascadia Mono', monospace;
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.voice-library__file-name--empty {
  color: var(--color-text-muted);
  font-family: inherit;
}

.voice-library__fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  gap: 0.5rem;
}

.voice-library__field {
  display: grid;
  gap: 0.2rem;
  min-width: 0;
}

.voice-library__field > span {
  color: var(--color-text-secondary);
  font-size: 0.68rem;
}

.voice-library__field small {
  color: var(--color-text-muted);
  font-size: 0.63rem;
  line-height: 1.5;
}

.voice-library__field input,
.voice-library__field select,
.voice-library__field textarea {
  min-height: 2.1rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface);
  color: var(--color-text);
  font-family: inherit;
  font-size: 0.74rem;
}

.voice-library__field textarea {
  resize: vertical;
}

.voice-library__form-footer {
  flex-wrap: wrap;
  gap: 0.5rem;
}

.voice-library__blocked {
  flex: 1 1 12rem;
  color: var(--color-warning);
  font-size: 0.68rem;
  line-height: 1.5;
}

.voice-library__error {
  color: var(--color-error);
  font-size: 0.7rem;
}

.voice-library__notice {
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--color-warning-border);
  border-radius: var(--radius);
  background: var(--color-warning-bg);
  color: var(--color-warning);
  font-size: 0.7rem;
  line-height: 1.5;
}

.voice-library__button {
  min-height: 2.1rem;
  padding: 0.4rem 0.7rem;
  border: 1px solid transparent;
  border-radius: var(--radius);
  background: var(--color-accent);
  color: var(--color-text-on-accent);
  font-size: 0.72rem;
  font-weight: 650;
  white-space: nowrap;
}

.voice-library__button:hover:not(:disabled) {
  background: var(--color-accent-hover);
}

.voice-library__button--quiet {
  border-color: var(--color-border);
  background: transparent;
  color: var(--color-text-secondary);
}

.voice-library__button--quiet:hover:not(:disabled) {
  background: var(--color-accent-soft-hover);
  color: var(--color-text);
}

.voice-library__button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

@media (max-width: 640px) {
  .voice-library__header,
  .voice-library__item,
  .voice-library__file {
    align-items: flex-start;
    flex-direction: column;
  }

  .voice-library__file-name {
    max-width: 100%;
    text-align: left;
  }

  .voice-library__item-actions {
    justify-content: flex-start;
  }
}
</style>
