<script setup lang="ts">
// P2-44: 聊天记录搜索（DeepSeek 式）——顶栏放大镜 + 浮层结果面板。
// 依据：2026-08-23 用户验收需求：
//   - 放大镜放聊天头部左侧（Nacime 标题旁，用户截图红圈位）
//   - 点击出浮层：输入即搜（200ms 防抖），结果=正文片段 + 右侧时间戳
//   - 关键词加粗 + 淡蓝底（不过度抢眼；v-for <mark> 渲染，不用 v-html 防注入）
//   - 点击结果：滚动定位到那条消息并高亮，3 秒内高亮自动消失
//   - 搜索范围=全部会话（跨会话命中先 hydrate 目标会话再滚动）
//
// 已知边界：跳转依赖消息已渲染（data-message-id）；list 上限 500 条，
// 超出加载窗口的命中会在面板内提示而不静默失败。

import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useChatStore } from '../../stores/chat'
import type { ChatSearchHit } from '@shared/chat/types'
import { formatSearchTime, queryToNeedles, splitByNeedles } from '../../utils/search-highlight'

const chatStore = useChatStore()

const visible = ref(false)
const query = ref('')
const results = ref<ChatSearchHit[]>([])
const searching = ref(false)
/** 跳转目标不在当前加载窗口时的面板内提示 */
const missHint = ref(false)
const inputRef = ref<HTMLInputElement | null>(null)

const needles = computed(() => queryToNeedles(query.value))
/** 打开面板时取一次"现在"，供结果行时间戳分档（今天/今年/跨年） */
const now = ref(Date.now())

let debounceTimer: number | undefined
/** 竞态守卫：只接受最后一次查询的响应 */
let searchSeq = 0

watch(query, (value) => {
  window.clearTimeout(debounceTimer)
  missHint.value = false
  const trimmed = value.trim()
  if (!trimmed) {
    searchSeq++
    results.value = []
    searching.value = false
    return
  }
  searching.value = true
  debounceTimer = window.setTimeout(() => void runSearch(trimmed), 200)
})

async function runSearch(q: string): Promise<void> {
  const seq = ++searchSeq
  const hits = await chatStore.searchMessages(q, 50)
  if (seq !== searchSeq) return // 期间已有更新的查询，丢弃过期响应
  results.value = hits
  searching.value = false
}

function open(): void {
  visible.value = true
  now.value = Date.now()
  void nextTick(() => inputRef.value?.focus())
}

function close(): void {
  visible.value = false
  query.value = ''
  results.value = []
  searching.value = false
  missHint.value = false
  searchSeq++ // 作废进行中的响应
}

/** 用户要求：高亮 3 秒内自动消失 */
const FLASH_MS = 3000

async function jump(hit: ChatSearchHit): Promise<void> {
  // 跨会话命中：先切到目标会话（hydrate 会重载消息列表）
  if (hit.sessionId !== chatStore.state.sessionId) {
    await chatStore.hydrate(hit.sessionId)
  }
  await nextTick()
  const el = document.querySelector(`[data-message-id="${CSS.escape(hit.messageId)}"]`)
  if (!el) {
    // 目标超出当前加载窗口（list 上限 500 条）：提示而非静默失败
    missHint.value = true
    return
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' })
  el.classList.add('highlight-flash')
  window.setTimeout(() => el.classList.remove('highlight-flash'), FLASH_MS)
  close()
}

onBeforeUnmount(() => {
  window.clearTimeout(debounceTimer)
})
</script>

<template>
  <button
    class="search-trigger"
    type="button"
    aria-label="搜索聊天记录"
    title="搜索聊天记录"
    @click="open"
  >
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2" />
      <line
        x1="16.4"
        y1="16.4"
        x2="21"
        y2="21"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
      />
    </svg>
  </button>

  <Teleport to="body">
    <div v-if="visible" class="search-overlay" @click.self="close">
      <div class="search-panel" role="dialog" aria-label="搜索聊天记录">
        <div class="search-input-row">
          <svg class="input-icon" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2" />
            <line
              x1="16.4"
              y1="16.4"
              x2="21"
              y2="21"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
          <input
            ref="inputRef"
            v-model="query"
            class="search-input"
            type="text"
            placeholder="搜索聊天记录"
            maxlength="128"
            @keydown.esc="close"
          />
          <button
            v-if="query"
            class="clear-btn"
            type="button"
            aria-label="清空"
            title="清空"
            @click="query = ''"
          >
            ×
          </button>
        </div>
        <div class="search-results">
          <p v-if="missHint" class="hint">这条消息在更早的历史里，超出了当前加载范围</p>
          <p v-else-if="query.trim() && !searching && results.length === 0" class="hint">
            没有找到相关记录
          </p>
          <button
            v-for="hit in results"
            :key="hit.messageId"
            class="result-item"
            type="button"
            @click="jump(hit)"
          >
            <span class="result-snippet">
              <template v-for="(part, i) in splitByNeedles(hit.snippet, needles)" :key="i">
                <mark v-if="part.hit">{{ part.text }}</mark>
                <template v-else>{{ part.text }}</template>
              </template>
            </span>
            <span class="result-time">{{ formatSearchTime(hit.createdAt, now) }}</span>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 顶栏触发按钮：ghost 图标，融入头部左侧身份区 */
.search-trigger {
  display: grid;
  width: 30px;
  height: 30px;
  padding: 0;
  place-items: center;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    background 0.18s ease,
    color 0.18s ease;
}

.search-trigger:hover {
  background: var(--color-accent-soft);
  color: var(--color-text);
}

.search-trigger svg {
  width: 16px;
  height: 16px;
}

/* 浮层：透明背板吃点击关闭，面板锚在头部下方（DeepSeek 式下拉面版） */
.search-overlay {
  position: fixed;
  z-index: 60;
  inset: 0;
  background: transparent;
}

.search-panel {
  display: flex;
  flex-direction: column;
  width: min(720px, 92vw);
  max-height: 70vh;
  margin: 72px auto 0;
  overflow: hidden;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-xl);
  background: var(--color-surface-elevated);
  box-shadow: var(--shadow-lg);
  animation: panel-in 0.18s ease;
}

@keyframes panel-in {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.search-input-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--color-border-subtle);
}

.input-icon {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  color: var(--color-text-muted);
}

.search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--color-text);
  font-family: var(--font-family-body);
  font-size: var(--font-size-base);
}

.search-input::placeholder {
  color: var(--color-text-tertiary);
}

.clear-btn {
  display: grid;
  width: 22px;
  height: 22px;
  padding: 0;
  place-items: center;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
}

.clear-btn:hover {
  background: var(--color-accent-soft);
  color: var(--color-text);
}

.search-results {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

.hint {
  padding: 28px 18px;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  text-align: center;
}

.result-item {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 10px 12px;
  border: none;
  border-radius: var(--radius-lg);
  background: transparent;
  cursor: pointer;
  font-family: var(--font-family-body);
  text-align: left;
  transition: background 0.15s ease;
}

.result-item:hover {
  background: var(--color-accent-soft);
}

.result-snippet {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.55;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 关键词：加粗为主（DeepSeek 式），淡蓝底为辅——不盖过原本字迹 */
.result-snippet mark {
  padding: 0 1px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--color-info) 14%, transparent);
  color: var(--color-text);
  font-weight: 600;
}

.result-time {
  flex-shrink: 0;
  color: var(--color-text-tertiary);
  font-size: var(--font-size-xs);
}
</style>
