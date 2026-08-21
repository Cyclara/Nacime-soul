<script setup lang="ts">
// P2-31: L2MemoryList -- 状态筛选 Tab + 搜索框 + 列表 + 分页。
// 依据：S-006 §1.2、S-006 §1.4（空态人格化"你们还没有共同记忆"、方向键导航）。
// 功能版（视觉待前端模型美化）。

import { ref, computed, watch, useTemplateRef, onBeforeUnmount } from 'vue'
import { storeToRefs } from 'pinia'
import { useMemoryStore } from '../../stores/memory'
import L2MemoryItem from './L2MemoryItem.vue'
import type { L2MemoryView } from '@shared/memory/types'

const memoryStore = useMemoryStore()
const { state } = storeToRefs(memoryStore)

const TABS: Array<{ key: L2MemoryView['lifecycleState'] | 'all'; label: string }> = [
  { key: 'active', label: '活跃' },
  { key: 'dormant', label: '休眠' },
  { key: 'archived', label: '归档' },
  { key: 'soft_deleted', label: '已删除' }
]

const activeTab = ref<L2MemoryView['lifecycleState'] | 'all'>('active')
const searchInput = ref('')
const listRef = useTemplateRef<HTMLUListElement>('itemList')

const pageSize = 50

// 重置 offset 并 loadL2（Tab/搜索共用）
function loadList(): void {
  void memoryStore.loadL2({
    state: activeTab.value === 'all' ? undefined : activeTab.value,
    search: searchInput.value.trim() || undefined,
    offset: 0,
    limit: pageSize
  })
}

// 切换 Tab：立即加载
watch(activeTab, () => loadList())

// M-30：搜索 150ms 防抖（旧实现每字符触发一次 loadL2 = 一次 IPC + LIKE 查询）
let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(searchInput, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(loadList, 150)
})

onBeforeUnmount(() => {
  if (searchTimer) clearTimeout(searchTimer)
})

// C-β：store 已累计前页，下一 offset 就是当前唯一条目数；不能再叠加 query.offset。
const hasMore = computed(() => state.value.l2Items.length < state.value.l2Total)

function loadMore(): void {
  void memoryStore.loadL2({
    offset: state.value.l2Items.length,
    limit: pageSize
  })
}

function onOpen(id: string): void {
  void memoryStore.openDetail(id)
}

// 方向键导航（S-006 §1.4）
function focusItem(index: number): void {
  const items = listRef.value?.querySelectorAll('[data-memory-item]')
  if (!items || index < 0 || index >= items.length) return
  ;(items[index] as HTMLElement).focus()
}

function onListKeydown(e: KeyboardEvent): void {
  const items = listRef.value?.querySelectorAll('[data-memory-item]')
  if (!items || items.length === 0) return

  const active = document.activeElement
  let currentIndex = Array.from(items).findIndex((item) => item === active)
  if (currentIndex === -1) currentIndex = 0

  if (e.key === 'ArrowDown') {
    e.preventDefault()
    focusItem(Math.min(currentIndex + 1, items.length - 1))
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    focusItem(Math.max(currentIndex - 1, 0))
  } else if (e.key === 'Home') {
    e.preventDefault()
    focusItem(0)
  } else if (e.key === 'End') {
    e.preventDefault()
    focusItem(items.length - 1)
  }
}
</script>

<template>
  <section class="l2-list" aria-label="记忆列表">
    <div class="list-controls">
      <div class="tabs" role="tablist" aria-label="记忆状态筛选">
        <button
          v-for="tab in TABS"
          :key="tab.key"
          class="tab"
          :class="{ active: activeTab === tab.key }"
          role="tab"
          :aria-selected="activeTab === tab.key"
          @click="activeTab = tab.key"
        >
          {{ tab.label }}
        </button>
      </div>
      <div class="search-box">
        <svg class="search-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2" fill="none" />
          <path
            d="M20 20l-4.3-4.3"
            stroke="currentColor"
            stroke-width="2"
            fill="none"
            stroke-linecap="round"
          />
        </svg>
        <input
          v-model="searchInput"
          class="search-input"
          type="search"
          placeholder="搜索记忆..."
          aria-label="搜索记忆"
        />
      </div>
    </div>

    <div v-if="state.l2Items.length === 0 && !state.loading" class="l2-empty" role="status">
      <span class="empty-icon" aria-hidden="true">🍃</span>
      <p v-if="activeTab === 'soft_deleted'" class="empty-text">回收站是空的</p>
      <template v-else>
        <p class="empty-text">你们还没有共同记忆</p>
        <p class="empty-hint">多聊聊，她会记住的。</p>
      </template>
    </div>

    <ul
      v-else
      ref="itemList"
      class="item-list"
      role="list"
      aria-label="记忆条目"
      @keydown="onListKeydown"
    >
      <L2MemoryItem
        v-for="(item, index) in state.l2Items"
        :key="item.id"
        :item="item"
        :style="{ '--i': index }"
        :tabindex="index === 0 ? 0 : -1"
        data-memory-item
        @open="onOpen"
        @keydown.enter.prevent="onOpen(item.id)"
      />
    </ul>

    <div v-if="hasMore" class="load-more">
      <button class="load-more-btn" @click="loadMore">加载更多（{{ state.l2Total }} 条）</button>
    </div>
  </section>
</template>

<style scoped>
.l2-list {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  background: color-mix(in srgb, var(--color-bg) 92%, transparent);
}

.list-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  padding: 13px clamp(14px, 3vw, 28px);
  border-bottom: 1px solid var(--color-border-subtle);
  background: color-mix(in srgb, var(--color-bg-secondary) 72%, transparent);
}

.tabs {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--color-surface) 72%, transparent);
}

.tab {
  min-height: 32px;
  padding: 5px 11px;
  border: 1px solid transparent;
  border-radius: var(--radius-full);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: 500;
}

.tab:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
}

.tab.active {
  border-color: color-mix(in srgb, var(--color-accent) 25%, transparent);
  background: var(--color-accent);
  box-shadow:
    inset 0 1px rgba(255, 255, 255, 0.2),
    var(--shadow-sm);
  color: var(--color-text-on-accent);
}

.search-box {
  position: relative;
  min-width: 190px;
  flex: 1;
}

.search-icon {
  position: absolute;
  top: 50%;
  left: 12px;
  width: 15px;
  height: 15px;
  color: var(--color-text-muted);
  pointer-events: none;
  transform: translateY(-50%);
}

.search-input {
  width: 100%;
  min-height: 38px;
  padding: 8px 12px 8px 37px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: var(--color-surface-translucent);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  user-select: text;
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease,
    box-shadow 0.15s ease;
}

.search-input::placeholder {
  color: var(--color-text-muted);
}

.search-input:hover {
  border-color: var(--color-border);
}

.search-input:focus {
  border-color: color-mix(in srgb, var(--color-accent) 54%, var(--color-border));
  background: var(--color-bg-secondary);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
}

.l2-empty {
  display: flex;
  min-height: 260px;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: var(--spacing-2xl) var(--spacing-md);
  color: var(--color-text-secondary);
  text-align: center;
}

.empty-icon {
  position: relative;
  display: block;
  width: 54px;
  height: 54px;
  margin-bottom: 12px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 18px 18px 18px 7px;
  background: var(--color-surface-translucent);
  color: transparent;
  font-size: 0;
  box-shadow: var(--shadow-sm);
}

.empty-icon::before,
.empty-icon::after {
  position: absolute;
  content: '';
  border-radius: var(--radius-full);
  background: var(--color-sage);
  transform-origin: bottom center;
}

.empty-icon::before {
  bottom: 13px;
  left: 26px;
  width: 2px;
  height: 26px;
  transform: rotate(-18deg);
}

.empty-icon::after {
  top: 15px;
  left: 18px;
  width: 18px;
  height: 10px;
  border-radius: 100% 0 100% 0;
  background: var(--color-sage);
  transform: rotate(-28deg);
}

.empty-text {
  color: var(--color-text-secondary);
  font-family: var(--font-family-display);
  font-size: var(--font-size-lg);
}

.empty-hint {
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  line-height: 1.55;
}

.item-list {
  flex: 1;
  margin: 0;
  padding: 8px clamp(8px, 2vw, 18px) 18px;
  overflow-y: auto;
  outline: none;
  list-style: none;
}

.load-more {
  padding: 12px var(--spacing-md);
  border-top: 1px solid var(--color-border-subtle);
  background: color-mix(in srgb, var(--color-bg-secondary) 76%, transparent);
  text-align: center;
}

.load-more-btn {
  min-height: 36px;
  padding: 6px 18px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.load-more-btn:hover {
  border-color: color-mix(in srgb, var(--color-accent) 28%, var(--color-border));
  background: var(--color-accent-soft);
  color: var(--color-text);
}

@media (max-width: 640px) {
  .list-controls {
    flex-direction: column;
    align-items: stretch;
    padding-inline: 12px;
  }

  .tabs {
    width: 100%;
    justify-content: space-between;
  }

  .tab {
    flex: 1;
    text-align: center;
  }
}
</style>
