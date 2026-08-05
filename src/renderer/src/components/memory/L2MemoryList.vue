<script setup lang="ts">
// P2-31: L2MemoryList -- 状态筛选 Tab + 搜索框 + 列表 + 分页。
// 依据：S-006 §1.2、S-006 §1.4（空态人格化"你们还没有共同记忆"、方向键导航）。
// 功能版（视觉待前端模型美化）。

import { ref, computed, watch, useTemplateRef } from 'vue'
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

// 切换 Tab 或搜索 -> 重置 offset 并 loadL2
watch([activeTab, searchInput], () => {
  void memoryStore.loadL2({
    state: activeTab.value === 'all' ? undefined : activeTab.value,
    search: searchInput.value.trim() || undefined,
    offset: 0,
    limit: pageSize
  })
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
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--color-bg);
}

.list-controls {
  display: flex;
  gap: var(--spacing-md);
  padding: var(--spacing-md) var(--spacing-lg);
  border-bottom: 1px solid var(--color-border);
  flex-wrap: wrap;
  background: var(--color-bg-secondary);
}

.tabs {
  display: inline-flex;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs);
  background: var(--color-surface);
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
}

.tab {
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  border: 1px solid transparent;
}

.tab:hover {
  color: var(--color-text);
  background: var(--color-bg-tertiary);
}

.tab.active {
  background: var(--color-accent);
  color: var(--color-text-on-accent);
  border-color: var(--color-accent-hover);
  box-shadow: var(--shadow-sm);
}

.search-box {
  flex: 1;
  min-width: 160px;
  position: relative;
}

.search-icon {
  position: absolute;
  left: var(--spacing-sm);
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  color: var(--color-text-muted);
  pointer-events: none;
}

.search-input {
  width: 100%;
  padding: var(--spacing-xs) var(--spacing-sm) var(--spacing-xs) 36px;
  border-radius: var(--radius);
  border: 1px solid var(--color-border);
  background: var(--color-bg);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  transition:
    border-color 0.15s ease,
    background-color 0.15s ease;
}

.search-input::placeholder {
  color: var(--color-text-muted);
}

.search-input:hover {
  border-color: var(--color-text-muted);
}

.search-input:focus {
  border-color: var(--color-accent);
  background: var(--color-bg-secondary);
}

.l2-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-xs);
  color: var(--color-text-secondary);
  padding: var(--spacing-2xl) var(--spacing-md);
  text-align: center;
}

.empty-icon {
  font-size: var(--font-size-2xl);
  opacity: 0.6;
  margin-bottom: var(--spacing-sm);
}

.empty-text {
  font-size: var(--font-size-lg);
  font-style: italic;
}

.empty-hint {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.item-list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  flex: 1;
  outline: none;
}

.load-more {
  padding: var(--spacing-md);
  text-align: center;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
}

.load-more-btn {
  padding: var(--spacing-xs) var(--spacing-lg);
  border-radius: var(--radius);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: var(--font-size-sm);
  border: 1px solid var(--color-border);
}

.load-more-btn:hover {
  background: var(--color-bg-tertiary);
  border-color: var(--color-text-muted);
}

@media (max-width: 640px) {
  .list-controls {
    flex-direction: column;
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
