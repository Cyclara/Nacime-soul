<script setup lang="ts">
// P3A-29/31：连接成功后的第一次见面。固定 opening 不进 SessionStore；用户选项才发一条真实 user message。
import { onBeforeUnmount, onMounted, ref } from 'vue'

defineProps<{ visible?: boolean }>()
const emit = defineEmits<{ startChat: [text: string] }>()

const opening = [
  '……你好。',
  '我是纳辞弥。名字有点绕，叫我 Nacime 也行。',
  '我现在对你的事知道得很少，所以不想装作已经很熟。我们慢慢来，好吗？'
]
const choices = [
  { id: 'share-day', label: '聊聊今天', text: '那就从今天开始吧。' },
  { id: 'ask-nacime', label: '先认识你', text: '我想先听你说说自己。' },
  { id: 'quiet-start', label: '随便待会儿', text: '我一时不知道说什么，我们先随便待会儿吧。' }
] as const
const freeInput = ref('')
const hint = ref('想说什么都可以。')
let idleTimer: ReturnType<typeof setTimeout> | null = null

function choose(text: string): void {
  emit('startChat', text)
}
function sendFreeInput(): void {
  const text = freeInput.value.trim()
  if (text.length === 0) return
  choose(text)
}
function armIdleHint(): void {
  idleTimer = setTimeout(() => {
    hint.value = '不知道说什么也没关系，可以先选“随便待会儿”。'
  }, 10_000)
}
onMounted(armIdleHint)
onBeforeUnmount(() => {
  if (idleTimer !== null) clearTimeout(idleTimer)
})
</script>

<template>
  <section class="first-conversation" aria-labelledby="first-conversation-title">
    <div class="conversation-seal" aria-hidden="true">N</div>
    <p class="conversation-kicker">第一次见面</p>
    <h2 id="first-conversation-title">先不用急着了解彼此。</h2>
    <div class="opening" aria-label="纳辞弥的开场">
      <p v-for="line in opening" :key="line" class="opening-line">{{ line }}</p>
    </div>
    <p class="conversation-hint" role="status" aria-live="polite">{{ hint }}</p>
    <div class="conversation-choices" aria-label="第一次对话入口">
      <button
        v-for="choice in choices"
        :key="choice.id"
        type="button"
        class="choice"
        @click="choose(choice.text)"
      >
        <span>{{ choice.label }}</span
        ><span aria-hidden="true">↗</span>
      </button>
    </div>
    <form class="free-input" @submit.prevent="sendFreeInput">
      <label for="first-conversation-input">或者，直接说你想说的</label>
      <div class="free-input__row">
        <input
          id="first-conversation-input"
          v-model="freeInput"
          maxlength="20000"
          placeholder="从一句话开始…"
        />
        <button type="submit" aria-label="发送第一句话" :disabled="!freeInput.trim()">→</button>
      </div>
    </form>
  </section>
</template>

<style scoped>
.first-conversation {
  display: grid;
  width: min(100%, 39rem);
  gap: 0.9rem;
  margin: auto;
  padding: clamp(1.5rem, 5vw, 3rem);
  border: 1px solid var(--color-border-subtle);
  border-radius: 1.6rem;
  background:
    radial-gradient(circle at 100% 0, var(--color-companion-soft), transparent 35%),
    var(--color-surface-translucent);
  box-shadow: var(--shadow-lg);
}
.conversation-seal {
  display: grid;
  width: 3rem;
  height: 3rem;
  place-items: center;
  border: 1px solid color-mix(in srgb, var(--color-companion) 38%, var(--color-border));
  border-radius: 1rem 1rem 1rem 0.3rem;
  background: var(--color-companion-soft);
  color: var(--color-companion);
  font-family: var(--font-family-display);
  font-size: 1.35rem;
}
.conversation-kicker {
  margin: 0.2rem 0 0;
  color: var(--color-companion);
  font-size: 0.72rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}
.first-conversation h2 {
  margin: 0;
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: clamp(1.35rem, 3vw, 1.8rem);
  font-weight: 600;
}
.opening {
  display: grid;
  gap: 0.5rem;
  margin: 0.45rem 0;
}
.opening-line {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 0.93rem;
  line-height: 1.65;
}
.opening-line:last-child {
  color: var(--color-text);
}
.conversation-hint {
  min-height: 1.3rem;
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.76rem;
}
.conversation-choices {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.5rem;
}
.choice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 2.7rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 0.75rem;
  background: var(--color-surface);
  color: var(--color-text-secondary);
  cursor: pointer;
  font: inherit;
  font-size: 0.76rem;
  text-align: left;
  transition: 160ms ease;
}
.choice:hover {
  border-color: var(--color-companion);
  background: var(--color-companion-soft);
  color: var(--color-text);
  transform: translateY(-1px);
}
.choice:focus-visible,
.free-input button:focus-visible,
.free-input input:focus-visible {
  outline: 2px solid var(--color-companion);
  outline-offset: 2px;
}
.free-input {
  display: grid;
  gap: 0.4rem;
  margin-top: 0.35rem;
}
.free-input label {
  color: var(--color-text-muted);
  font-size: 0.72rem;
}
.free-input__row {
  display: flex;
  gap: 0.45rem;
}
.free-input input {
  min-width: 0;
  flex: 1;
  min-height: 2.6rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 0.75rem;
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  font: inherit;
  font-size: 0.8rem;
}
.free-input button {
  width: 2.6rem;
  border: 0;
  border-radius: 0.75rem;
  background: var(--color-accent);
  color: var(--color-text-on-accent);
  cursor: pointer;
  font-size: 1.1rem;
}
.free-input button:disabled {
  cursor: not-allowed;
  opacity: 0.4;
}
@media (max-width: 560px) {
  .conversation-choices {
    grid-template-columns: 1fr;
  }
}
@media (prefers-reduced-motion: reduce) {
  .choice:hover {
    transform: none;
  }
}
</style>
