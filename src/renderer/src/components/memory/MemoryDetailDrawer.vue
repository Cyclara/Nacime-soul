<script setup lang="ts">
// P2-31: MemoryDetailDrawer -- 右侧抽屉：全文 + evidence 溯源 + pin/删除/恢复。
// 依据：S-006 §1.2/§1.3/§1.4（删除需确认、<700px 降级全屏、Esc 关闭）。
// DmaeHistoryChart 延后到 P2-32/F5-002（S-022 §3.1）。功能版（视觉待前端模型美化）。
// M-14：补齐焦点管理（打开移焦到关闭按钮、Tab 圈闭、Esc 关闭、关闭恢复焦点），
//       修复旧实现 Esc 处理器挂在 overlay 上、而焦点停留在背景导致 Esc 失效的问题。
// M-44：内联编辑（功能版）——编辑草稿取 rawContent（显示 content 已做人称转换，
//       直接编辑显示值会把"你…"写回库污染原文）；保存后等 event 回流 + 重新拉详情。

import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue'
import { storeToRefs } from 'pinia'
import { useMemoryStore } from '../../stores/memory'

const memoryStore = useMemoryStore()
const { state } = storeToRefs(memoryStore)

const overlayRef = ref<HTMLElement | null>(null)
const closeBtnRef = ref<HTMLButtonElement | null>(null)
let previousFocus: HTMLElement | null = null
let active = false

const detail = computed(() => state.value.selectedDetail)
const isSoftDeleted = computed(() => detail.value?.lifecycleState === 'soft_deleted')

// M-44：内联编辑状态（功能版）
const editing = ref(false)
const editDraft = ref('')
const saving = ref(false)

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

function focusableElements(): HTMLElement[] {
  if (!overlayRef.value) return []
  return Array.from(
    overlayRef.value.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    )
  )
}

function onDocumentKeydown(e: KeyboardEvent): void {
  if (!active) return
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
    return
  }
  if (e.key !== 'Tab') return
  const focusable = focusableElements()
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

watch(detail, async (val) => {
  // M-44：切换详情时退出编辑态（草稿不跨记忆残留）
  editing.value = false
  saving.value = false
  if (val) {
    if (!active) {
      active = true
      previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
      document.addEventListener('keydown', onDocumentKeydown)
    }
    await nextTick()
    closeBtnRef.value?.focus()
  } else {
    if (active) {
      active = false
      document.removeEventListener('keydown', onDocumentKeydown)
      previousFocus?.focus()
      previousFocus = null
    }
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onDocumentKeydown)
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

// === M-44：内联编辑 ===

function startEdit(): void {
  if (!detail.value) return
  // 草稿取原始 content（rawContent）：显示值已做人称转换（"伙伴…"->"你…"），
  // 从显示值起草会把翻译后的文本写回库，污染原文与 prompt 注入语义。
  editDraft.value = detail.value.rawContent
  editing.value = true
}

function cancelEdit(): void {
  editing.value = false
  editDraft.value = ''
}

async function saveEdit(): Promise<void> {
  if (!detail.value || saving.value) return
  const content = editDraft.value.trim()
  if (content.length === 0) return // 空内容由 main 侧拒绝；这里直接不交
  saving.value = true
  try {
    const ok = await memoryStore.updateContent(detail.value.id, content)
    if (ok) {
      editing.value = false
      // event 回流刷新列表；详情手动重拉以立即反映新内容 + editedAt 标记
      await memoryStore.openDetail(detail.value.id)
    }
  } finally {
    saving.value = false
  }
}

function close(): void {
  memoryStore.closeDetail()
}
</script>

<template>
  <transition name="drawer-fade">
    <div v-if="detail" ref="overlayRef" class="drawer-overlay" tabindex="-1" @click.self="close">
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
          <button ref="closeBtnRef" class="close-btn" aria-label="关闭" @click="close">
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
            <template v-if="!editing">
              <p class="detail-content">{{ detail.content }}</p>
            </template>
            <template v-else>
              <textarea
                v-model="editDraft"
                class="edit-textarea"
                rows="4"
                maxlength="500"
                aria-label="编辑记忆内容"
                @keydown.esc.stop="cancelEdit"
              ></textarea>
              <p v-if="detail.rawContent !== detail.content" class="edit-hint">
                这是她记下的原文，保存后这里会自动换成「你」的说法
              </p>
              <div class="edit-actions">
                <button class="edit-btn primary" :disabled="saving" @click="saveEdit">
                  {{ saving ? '保存中…' : '保存' }}
                </button>
                <button class="edit-btn" :disabled="saving" @click="cancelEdit">取消</button>
              </div>
            </template>

            <div class="detail-meta">
              <span v-if="detail.isPinned" class="pin-mark">📌 已固定</span>
              <span
                v-if="detail.editedAt"
                v-tooltip="`编辑于 ${new Date(detail.editedAt).toLocaleString()}`"
                class="edited-mark"
                >✎ 已编辑</span
              >
              <span class="type-tag">{{ detail.type }}</span>
            </div>

            <div class="detail-stats">
              <div
                v-tooltip="`激活值 ${detail.activation.toFixed(1)}`"
                class="stat-item"
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
            v-if="!isSoftDeleted && !editing"
            class="action-btn"
            :class="{ active: detail.isPinned }"
            @click="togglePin"
          >
            <span class="btn-icon">{{ detail.isPinned ? '✕' : '📌' }}</span>
            <span>{{ detail.isPinned ? '取消固定' : '固定' }}</span>
          </button>
          <button v-if="!isSoftDeleted && !editing" class="action-btn" @click="startEdit">
            <span class="btn-icon">✎</span>
            <span>编辑</span>
          </button>
          <button v-if="!isSoftDeleted && !editing" class="action-btn danger" @click="onSoftDelete">
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

.drawer-overlay {
  position: fixed;
  z-index: 100;
  inset: 0;
  display: flex;
  justify-content: flex-end;
  background: rgba(12, 10, 14, 0.5);
  backdrop-filter: blur(5px);
}

.drawer {
  display: flex;
  width: min(480px, 100%);
  max-width: 100%;
  flex-direction: column;
  border-left: 1px solid var(--color-border-subtle);
  background:
    radial-gradient(circle at 100% 0%, var(--color-accent-soft), transparent 30%),
    var(--color-bg-secondary);
  box-shadow: var(--shadow-drawer);
  outline: none;
}

.drawer-header {
  display: flex;
  min-height: 70px;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  padding: 13px 18px 13px 22px;
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-surface-translucent);
  backdrop-filter: blur(14px);
}

.drawer-title-group {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 9px;
}

.drawer-title {
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: var(--font-size-xl);
  font-weight: 600;
}

.state-badge {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 5px;
  min-height: 23px;
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, currentColor 18%, transparent);
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
  font-weight: 550;
}

.state-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.close-btn {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border: 1px solid var(--color-border-subtle);
  border-radius: 50%;
  background: var(--color-surface);
  color: var(--color-text-secondary);
}

.close-btn:hover {
  border-color: var(--color-border);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.close-icon {
  width: 16px;
  height: 16px;
}

.drawer-body {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 18px;
  overflow-y: auto;
  padding: 20px 22px 28px;
}

.detail-section {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.main-section {
  padding: 17px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background:
    linear-gradient(145deg, var(--color-companion-soft), transparent 48%), var(--color-surface);
  box-shadow:
    inset 0 1px rgba(255, 255, 255, 0.03),
    var(--shadow-sm);
}

.section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.section-icon {
  color: var(--color-companion);
}

.detail-content {
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: var(--font-size-lg);
  line-height: 1.72;
  word-break: break-word;
  user-select: text;
}

.detail-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-xs);
}

.pin-mark {
  filter: grayscale(1);
  color: var(--color-accent);
  font-weight: 500;
}

/* M-44：编辑标记 + 内联编辑（2026-08-21 视觉 polish：focus 光晕/进入过渡/徽标对齐 tag 体系） */
@keyframes edit-in {
  from {
    opacity: 0;
    transform: translateY(4px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.detail-content {
  animation: edit-in 0.18s ease;
}

.edited-mark {
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, var(--color-companion) 34%, transparent);
  border-radius: var(--radius-full);
  background: var(--color-companion-soft);
  color: var(--color-companion);
  font-weight: 550;
}

.edit-textarea {
  width: 100%;
  min-height: 96px;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: var(--font-size-base);
  line-height: 1.6;
  resize: vertical;
  transition:
    border-color 0.18s ease,
    background-color 0.18s ease,
    box-shadow 0.18s ease;
  animation: edit-in 0.18s ease;
}

.edit-textarea:focus {
  border-color: color-mix(in srgb, var(--color-accent) 55%, var(--color-border));
  background: var(--color-surface-elevated);
  box-shadow: 0 0 0 3px var(--color-accent-soft);
  outline: none;
}

.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  animation: edit-in 0.18s ease 0.05s backwards;
}

/* 2026-08-21 验收反馈：编辑草稿是 rawContent（第三人称原文），
   与显示值（已转「你」）不一致会让用户困惑——补一句说明 */
.edit-hint {
  margin-top: 6px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}

.edit-btn {
  min-height: 34px;
  padding: 5px 14px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.edit-btn:hover {
  border-color: var(--color-border);
  color: var(--color-text);
}

.edit-btn.primary {
  border-color: color-mix(in srgb, var(--color-accent) 42%, var(--color-border));
  background: var(--color-accent-soft);
  color: var(--color-accent);
  font-weight: 600;
}

.edit-btn.primary:hover {
  border-color: color-mix(in srgb, var(--color-accent) 58%, var(--color-border));
  background: var(--color-accent-soft-hover);
}

.edit-btn:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.type-tag {
  padding: 2px 8px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
}

.detail-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 7px;
  margin-top: 5px;
  padding-top: 12px;
  border-top: 1px solid var(--color-border-subtle);
}

.stat-item {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
  padding: 8px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-bg-tertiary) 62%, transparent);
}

.stat-label {
  color: var(--color-text-muted);
  font-size: 10px;
}

.stat-value {
  color: var(--color-text);
  font-size: var(--font-size-sm);
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

.trigger-text {
  padding: 11px 13px;
  border: 1px solid var(--color-border-subtle);
  border-left: 2px solid color-mix(in srgb, var(--color-companion) 68%, transparent);
  border-radius: 4px var(--radius) var(--radius) 4px;
  background: color-mix(in srgb, var(--color-bg-tertiary) 72%, transparent);
  color: var(--color-text-secondary);
  font-size: var(--font-size-base);
  font-style: italic;
  line-height: 1.65;
}

.evidence-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.evidence-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 9px 10px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: var(--font-size-xs);
}

.evidence-item::before {
  color: var(--color-text-muted);
  content: '#';
}

.no-evidence {
  padding: 9px;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
  font-style: italic;
}

.drawer-footer {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
  padding: 12px 18px 16px;
  border-top: 1px solid var(--color-border-subtle);
  background: var(--color-surface-translucent);
  backdrop-filter: blur(14px);
}

.action-btn {
  display: inline-flex;
  min-height: 42px;
  flex: 1;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 12px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.action-btn:hover {
  border-color: var(--color-border);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.action-btn.active {
  border-color: color-mix(in srgb, var(--color-accent) 42%, var(--color-border));
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.action-btn.danger {
  border-color: var(--color-error-border);
  background: var(--color-error-bg);
  color: var(--color-error);
}

.action-btn.danger:hover {
  border-color: var(--color-error);
  background: color-mix(in srgb, var(--color-error-bg) 78%, var(--color-error) 8%);
}

.btn-icon {
  filter: grayscale(1);
  font-size: var(--font-size-sm);
}

@media (max-width: 700px) {
  .drawer {
    width: 100%;
    height: 100%;
    border-left: 0;
    border-radius: 0;
  }

  .drawer-overlay {
    align-items: stretch;
  }
}

@media (max-width: 600px) {
  .detail-stats {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (prefers-reduced-motion: reduce) {
  .drawer-fade-enter-active,
  .drawer-fade-leave-active,
  .drawer-fade-enter-active .drawer,
  .drawer-fade-leave-active .drawer {
    transition: none;
  }
}
</style>
