<script setup lang="ts">
// P2-31: MemoryDetailDrawer -- 右侧抽屉：全文 + evidence 溯源 + pin/删除/恢复。
// 依据：S-006 §1.2/§1.3/§1.4（删除需确认、<700px 降级全屏、Esc 关闭）。
// DmaeHistoryChart 延后到 P2-32/F5-002（S-012 §3.1）。功能版（视觉待前端模型美化）。

import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useMemoryStore } from '../../stores/memory'

const memoryStore = useMemoryStore()
const { state } = storeToRefs(memoryStore)

const detail = computed(() => state.value.selectedDetail)
const isSoftDeleted = computed(() => detail.value?.lifecycleState === 'soft_deleted')

const stateMeta = computed(() => {
  const map: Record<string, { label: string; colorVar: string; bgVar: string }> = {
    active: { label: '活跃', colorVar: '--color-state-active', bgVar: '--color-state-active-bg' },
    dormant: {
      label: '休眠',
      colorVar: '--color-state-dormant',
      bgVar: '--color-state-dormant-bg'
    },
    archived: {
      label: '归档',
      colorVar: '--color-state-archived',
      bgVar: '--color-state-archived-bg'
    },
    soft_deleted: {
      label: '已删除',
      colorVar: '--color-state-deleted',
      bgVar: '--color-state-deleted-bg'
    }
  }
  return detail.value ? (map[detail.value.lifecycleState] ?? null) : null
})

async function togglePin(): Promise<void> {
  if (!detail.value) return
  const ok = await memoryStore.setPinned(detail.value.id, !detail.value.isPinned)
  // 不乐观更新：event 回流后列表/详情刷新。但详情需手动重新拉取以反映新 pin 状态
  if (ok) await memoryStore.openDetail(detail.value.id)
}

async function onSoftDelete(): Promise<void> {
  if (!detail.value) return
  if (!confirm('她会忘记这件事。确定删除吗？')) return
  const ok = await memoryStore.softDelete(detail.value.id)
  if (ok) memoryStore.closeDetail()
}

async function onRestore(): Promise<void> {
  if (!detail.value) return
  const ok = await memoryStore.restore(detail.value.id)
  if (ok) await memoryStore.openDetail(detail.value.id)
}

function close(): void {
  memoryStore.closeDetail()
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') close()
}
</script>

<template>
  <transition name="drawer-fade">
    <div
      v-if="detail"
      class="drawer-overlay"
      tabindex="-1"
      @click.self="close"
      @keydown="onKeydown"
    >
      <aside class="drawer" role="dialog" aria-label="记忆详情" aria-modal="true">
        <header class="drawer-header">
          <div class="drawer-title-group">
            <h2 class="drawer-title">记忆详情</h2>
            <span
              v-if="stateMeta"
              class="state-badge"
              :style="{
                color: `var(${stateMeta.colorVar})`,
                background: `var(${stateMeta.bgVar})`
              }"
            >
              <span class="state-dot" :style="{ background: `var(${stateMeta.colorVar})` }"></span>
              <span>{{ stateMeta.label }}</span>
            </span>
          </div>
          <button class="close-btn" aria-label="关闭" @click="close">
            <svg class="close-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M18 6L6 18M6 6l12 12"
                stroke="currentColor"
                stroke-width="2"
                fill="none"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </header>

        <div class="drawer-body">
          <section class="detail-section main-section">
            <p class="detail-content">{{ detail.content }}</p>

            <div class="detail-meta">
              <span v-if="detail.isPinned" class="pin-mark">📌 已固定</span>
              <span class="type-tag">{{ detail.type }}</span>
            </div>

            <div class="detail-stats">
              <div
                class="stat-item"
                :title="`激活值 ${detail.activation.toFixed(1)}`"
                :aria-label="`激活值 ${detail.activation.toFixed(1)}`"
              >
                <span class="stat-label">激活</span>
                <span class="stat-value">{{ detail.activation.toFixed(1) }}</span>
              </div>
              <div class="stat-item">
                <span class="stat-label">重要度</span>
                <span class="stat-value">{{ detail.importance }}</span>
              </div>
              <div class="stat-item">
                <span class="stat-label">置信度</span>
                <span class="stat-value">{{ (detail.confidence * 100).toFixed(0) }}%</span>
              </div>
              <div class="stat-item">
                <span class="stat-label">引用</span>
                <span class="stat-value">{{ detail.accessCount }} 次</span>
              </div>
            </div>
          </section>

          <section v-if="detail.triggerText" class="detail-section">
            <h3 class="section-title">
              <span class="section-icon">✦</span>
              触发文本
            </h3>
            <p class="trigger-text">{{ detail.triggerText }}</p>
          </section>

          <section class="detail-section">
            <h3 class="section-title">
              <span class="section-icon">🔗</span>
              溯源
            </h3>
            <div v-if="detail.evidenceIds.length === 0" class="no-evidence">无证据引用</div>
            <ul v-else class="evidence-list" role="list">
              <li v-for="eid in detail.evidenceIds" :key="eid" class="evidence-item">
                <span class="evidence-id">{{ eid.slice(0, 14) }}…</span>
              </li>
            </ul>
          </section>
        </div>

        <footer class="drawer-footer">
          <button
            v-if="!isSoftDeleted"
            class="action-btn"
            :class="{ active: detail.isPinned }"
            @click="togglePin"
          >
            <span class="btn-icon">{{ detail.isPinned ? '✕' : '📌' }}</span>
            <span>{{ detail.isPinned ? '取消固定' : '固定' }}</span>
          </button>
          <button v-if="!isSoftDeleted" class="action-btn danger" @click="onSoftDelete">
            <span class="btn-icon">🗑</span>
            <span>删除</span>
          </button>
          <button v-if="isSoftDeleted" class="action-btn" @click="onRestore">
            <span class="btn-icon">↩</span>
            <span>恢复</span>
          </button>
        </footer>
      </aside>
    </div>
  </transition>
</template>

<style scoped>
.drawer-fade-enter-active,
.drawer-fade-leave-active {
  transition: opacity 0.2s ease;
}

.drawer-fade-enter-active .drawer,
.drawer-fade-leave-active .drawer {
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

.drawer-fade-enter-from,
.drawer-fade-leave-to {
  opacity: 0;
}

.drawer-fade-enter-from .drawer,
.drawer-fade-leave-to .drawer {
  transform: translateX(100%);
}

@media (prefers-reduced-motion: reduce) {
  .drawer-fade-enter-active,
  .drawer-fade-leave-active,
  .drawer-fade-enter-active .drawer,
  .drawer-fade-leave-active .drawer {
    transition: none;
  }
}

.drawer-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.35);
  display: flex;
  justify-content: flex-end;
  z-index: 100;
  backdrop-filter: blur(2px);
}

.drawer {
  width: 460px;
  max-width: 100%;
  background: var(--color-bg-secondary);
  display: flex;
  flex-direction: column;
  box-shadow: var(--shadow-drawer);
  outline: none;
}

@media (max-width: 700px) {
  .drawer {
    width: 100%;
    height: 100%;
    border-radius: 0;
  }

  .drawer-overlay {
    align-items: stretch;
  }
}

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-md) var(--spacing-lg);
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.drawer-title-group {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  min-width: 0;
}

.drawer-title {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-text);
}

.state-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
  font-weight: 500;
  flex-shrink: 0;
}

.state-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.close-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: var(--radius);
  color: var(--color-text-secondary);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
}

.close-btn:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.close-icon {
  width: 16px;
  height: 16px;
}

.drawer-body {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-lg);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
}

.detail-section {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.main-section {
  padding: var(--spacing-md);
  background: var(--color-bg);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
}

.section-title {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.section-icon {
  color: var(--color-accent);
}

.detail-content {
  font-size: var(--font-size-lg);
  line-height: 1.7;
  color: var(--color-text);
  word-break: break-word;
}

.detail-meta {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  font-size: var(--font-size-sm);
  flex-wrap: wrap;
}

.pin-mark {
  color: var(--color-accent);
  font-weight: 500;
}

.type-tag {
  padding: 2px 8px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  background: var(--color-surface);
}

.detail-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--spacing-sm);
  margin-top: var(--spacing-xs);
  padding-top: var(--spacing-sm);
  border-top: 1px solid var(--color-border-subtle);
}

.stat-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.stat-label {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.stat-value {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
}

.trigger-text {
  font-size: var(--font-size-base);
  color: var(--color-text-secondary);
  font-style: italic;
  line-height: 1.6;
  padding: var(--spacing-sm);
  background: var(--color-bg-tertiary);
  border-radius: var(--radius);
  border-left: 3px solid var(--color-accent-soft-hover);
}

.evidence-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.evidence-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.evidence-item::before {
  content: '#';
  color: var(--color-text-muted);
}

.no-evidence {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  font-style: italic;
  padding: var(--spacing-sm);
}

.drawer-footer {
  display: flex;
  gap: var(--spacing-sm);
  padding: var(--spacing-md) var(--spacing-lg);
  border-top: 1px solid var(--color-border);
  background: var(--color-bg);
  flex-shrink: 0;
}

.action-btn {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm);
  border-radius: var(--radius);
  background: var(--color-surface);
  color: var(--color-text);
  font-size: var(--font-size-base);
  border: 1px solid var(--color-border);
}

.action-btn:hover {
  background: var(--color-bg-tertiary);
  border-color: var(--color-text-muted);
}

.action-btn.active {
  background: var(--color-accent-soft);
  border-color: var(--color-accent);
  color: var(--color-accent);
}

.action-btn.danger {
  color: var(--color-error);
  border-color: var(--color-error-border);
  background: var(--color-error-bg);
}

.action-btn.danger:hover {
  background: var(--color-error-bg);
  border-color: var(--color-error);
}

.btn-icon {
  font-size: var(--font-size-sm);
}

@media (max-width: 480px) {
  .detail-stats {
    grid-template-columns: repeat(2, 1fr);
  }
}
</style>
