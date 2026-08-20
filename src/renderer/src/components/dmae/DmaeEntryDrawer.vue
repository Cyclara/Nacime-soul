<script setup lang="ts">
// P2-32: DmaeEntryDrawer -- 单条记忆详情抽屉（工程档公式分解）。
// 验收④⑤：单条曲线 + 公式分解各项数值与 engine.ts 手算一致。
// 依据：F5-002 §3.1 wireframe（entry inspector）、F5-002-补充 §1.4 C。
// M-14：补齐焦点管理（打开移焦、Tab 圈闭、Esc 关闭、关闭恢复焦点），
//       修复旧实现 Esc 挂 panel 上、焦点在背景时 Esc 失效的问题。

import { computed, ref, watch, nextTick, onBeforeUnmount } from 'vue'
import type { DmaeTurnExplanation } from '../../../../main/memory/dmae/diagnostics'
import type { DensityMode } from '../../stores/dmae'

const props = defineProps<{
  memoryId: string | null
  explanation: DmaeTurnExplanation | null
  loading: boolean
  density: DensityMode
}>()

const emit = defineEmits<{
  close: []
}>()

const overlayRef = ref<HTMLElement | null>(null)
const closeBtnRef = ref<HTMLButtonElement | null>(null)
let previousFocus: HTMLElement | null = null
let active = false

const isOpen = computed(() => props.memoryId !== null)

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
    emit('close')
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

watch(isOpen, async (open) => {
  if (open) {
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

function termLabel(name: DmaeTurnExplanation['terms'][number]['name']): string {
  const map: Record<string, string> = {
    Ru: '用户命中奖励 Ru',
    Rm_raw: '模型命中奖励（clamp 前）',
    Rm_clamped: '模型命中奖励（clamp 后）',
    Decay: '遗忘衰减 Decay',
    Floor: 'Floor 复活',
    Clamp: '最终钳制'
  }
  return map[name] ?? name
}
</script>

<template>
  <transition name="drawer-slide">
    <div v-if="isOpen" ref="overlayRef" class="drawer-overlay" @click.self="emit('close')">
      <div class="drawer-panel" role="dialog" aria-label="记忆引擎详情" aria-modal="true">
        <header class="drawer-header">
          <h2 class="drawer-title">记忆详情</h2>
          <button ref="closeBtnRef" class="drawer-close" aria-label="关闭" @click="emit('close')">
            ×
          </button>
        </header>

        <div v-if="loading" class="drawer-loading">加载公式分解中…</div>

        <div v-else-if="explanation" class="drawer-body">
          <!-- 基本信息 -->
          <section class="detail-section">
            <dl class="detail-grid">
              <div class="detail-row">
                <dt>记忆 ID</dt>
                <dd class="mono">{{ explanation.memoryId }}</dd>
              </div>
              <div class="detail-row">
                <dt>重要度</dt>
                <dd>
                  {{ explanation.importance
                  }}{{ explanation.importance >= 10 ? '（永久豁免）' : '' }}
                </dd>
              </div>
              <div class="detail-row">
                <dt>轮次</dt>
                <dd>#{{ explanation.turn }}</dd>
              </div>
            </dl>
          </section>

          <!-- 状态变化 -->
          <section class="detail-section">
            <h3 class="subsection-title">本轮变化</h3>
            <div class="state-change">
              <span class="state-before">
                {{ explanation.before.state }}
                <span class="state-val">{{ Math.round(explanation.before.activation) }}</span>
              </span>
              <span v-if="explanation.before.state !== explanation.after.state" class="state-arrow"
                >→</span
              >
              <span class="state-after">
                {{ explanation.after.state }}
                <span class="state-val">{{ Math.round(explanation.after.activation) }}</span>
              </span>
            </div>
            <div class="hit-flags">
              <span :class="['hit-flag', { on: explanation.userHit }]"
                >用户命中 {{ explanation.userHit ? '✓' : '✗' }}</span
              >
              <span :class="['hit-flag', { on: explanation.modelHit }]"
                >模型命中 {{ explanation.modelHit ? '✓' : '✗' }}</span
              >
            </div>
          </section>

          <!-- 公式分解（验收⑤：各项数值与 engine.ts 手算一致） -->
          <section v-if="density === 'engineering'" class="detail-section">
            <h3 class="subsection-title">公式分解</h3>
            <table class="formula-table">
              <thead>
                <tr>
                  <th>项</th>
                  <th>公式</th>
                  <th>值</th>
                  <th>生效</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(term, i) in explanation.terms"
                  :key="i"
                  :class="{ 'term-applied': term.applied }"
                >
                  <td class="term-name">{{ termLabel(term.name) }}</td>
                  <td class="term-formula">{{ term.formula }}</td>
                  <td class="term-value">{{ term.value.toFixed(2) }}</td>
                  <td class="term-applied-flag">{{ term.applied ? '✓' : '-' }}</td>
                </tr>
              </tbody>
            </table>
          </section>

          <!-- 叙事档简化说明 -->
          <section v-else class="detail-section">
            <h3 class="subsection-title">这轮发生了什么</h3>
            <p class="simple-explain">
              <template v-if="explanation.userHit && explanation.modelHit">
                你和她在这一轮都提到了这件事。
              </template>
              <template v-else-if="explanation.userHit"> 你在这一轮提到了这件事。 </template>
              <template v-else-if="explanation.modelHit"> 她在这一轮主动想起了这件事。 </template>
              <template v-else> 这一轮没有人提到这件事，它在慢慢淡去。 </template>
              <template v-if="explanation.before.state !== explanation.after.state">
                状态从「{{ explanation.before.state }}」变成了「{{ explanation.after.state }}」。
              </template>
            </p>
          </section>
        </div>

        <div v-else class="drawer-empty">
          <p>该记忆暂无公式分解数据。</p>
          <p class="empty-hint">可能是因为它最近没有被采样记录。</p>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.drawer-overlay {
  position: fixed;
  z-index: 100;
  inset: 0;
  display: flex;
  justify-content: flex-end;
  background: rgba(12, 10, 14, 0.52);
  backdrop-filter: blur(5px);
}

.drawer-panel {
  display: flex;
  width: min(540px, 92vw);
  height: 100%;
  flex-direction: column;
  overflow: hidden;
  border-left: 1px solid var(--color-border-subtle);
  background:
    radial-gradient(circle at 100% 0%, var(--color-accent-soft), transparent 28%),
    var(--color-bg-secondary);
  box-shadow: var(--shadow-drawer);
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

.drawer-title {
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: var(--font-size-xl);
  font-weight: 600;
}

.drawer-close {
  display: grid;
  width: 40px;
  height: 40px;
  place-items: center;
  border: 1px solid var(--color-border-subtle);
  border-radius: 50%;
  background: var(--color-surface);
  color: var(--color-text-secondary);
  font-size: 1.25rem;
}

.drawer-close:hover {
  border-color: var(--color-border);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

.drawer-body {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
  padding: 18px 20px 28px;
}

.detail-section {
  padding: 15px;
  overflow-x: auto;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: color-mix(in srgb, var(--color-surface) 80%, transparent);
  box-shadow: inset 0 1px rgba(255, 255, 255, 0.025);
}

.detail-section:first-child {
  background:
    linear-gradient(145deg, var(--color-companion-soft), transparent 58%), var(--color-surface);
}

.detail-grid {
  display: grid;
  gap: 8px;
}

.detail-row {
  display: grid;
  grid-template-columns: minmax(90px, 0.42fr) minmax(0, 1fr);
  align-items: baseline;
  gap: 12px;
  padding-bottom: 7px;
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--font-size-sm);
}

.detail-row:last-child {
  padding-bottom: 0;
  border-bottom: 0;
}

.detail-row dt {
  color: var(--color-text-muted);
}

.detail-row dd {
  min-width: 0;
  color: var(--color-text);
  text-align: right;
  overflow-wrap: anywhere;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: var(--font-size-xs);
}

.subsection-title {
  margin-bottom: 11px;
  color: var(--color-text-secondary);
  font-family: var(--font-family-display);
  font-size: var(--font-size-lg);
  font-weight: 600;
}

.state-change {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  font-size: var(--font-size-sm);
}

.state-before,
.state-after {
  display: inline-flex;
  min-height: 34px;
  align-items: baseline;
  gap: 7px;
  padding: 6px 10px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: var(--color-bg-tertiary);
}

.state-after {
  border-color: color-mix(in srgb, var(--color-accent) 25%, var(--color-border));
  background: var(--color-accent-soft);
}

.state-val {
  color: var(--color-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-weight: 650;
}

.state-arrow {
  color: var(--color-text-muted);
}

.hit-flags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.hit-flag {
  min-height: 24px;
  padding: 3px 8px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.hit-flag.on {
  border-color: color-mix(in srgb, var(--color-accent) 20%, transparent);
  background: var(--color-accent-soft);
  color: var(--color-accent);
}

.formula-table {
  width: 100%;
  min-width: 460px;
  border-collapse: separate;
  border-spacing: 0;
  font-size: var(--font-size-xs);
}

.formula-table th {
  padding: 7px 8px;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-muted);
  font-weight: 600;
  text-align: left;
}

.formula-table td {
  padding: 8px;
  border-bottom: 1px solid var(--color-border-subtle);
  color: var(--color-text-secondary);
}

.formula-table tbody tr:last-child td {
  border-bottom: 0;
}

.term-name {
  color: var(--color-text) !important;
  white-space: nowrap;
}

.term-formula {
  color: var(--color-text-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  word-break: break-all;
}

.term-value {
  color: var(--color-text) !important;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.term-applied {
  background: color-mix(in srgb, var(--color-accent-soft) 56%, transparent);
}

.term-applied-flag {
  color: var(--color-accent) !important;
  text-align: center;
}

.simple-explain {
  color: var(--color-text-secondary);
  font-size: var(--font-size-base);
  line-height: 1.75;
  user-select: text;
}

.drawer-loading,
.drawer-empty {
  display: flex;
  min-height: 240px;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 24px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  text-align: center;
}

.empty-hint {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.drawer-slide-enter-active,
.drawer-slide-leave-active {
  transition: opacity 0.25s ease;
}

.drawer-slide-enter-active .drawer-panel,
.drawer-slide-leave-active .drawer-panel {
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
}

.drawer-slide-enter-from,
.drawer-slide-leave-to {
  opacity: 0;
}

.drawer-slide-enter-from .drawer-panel,
.drawer-slide-leave-to .drawer-panel {
  transform: translateX(100%);
}

@media (max-width: 700px) {
  .drawer-panel {
    width: 100%;
  }
}

@media (max-width: 480px) {
  .detail-row {
    grid-template-columns: 1fr;
    gap: 3px;
  }

  .detail-row dd {
    text-align: left;
  }
}

@media (prefers-reduced-motion: reduce) {
  .drawer-slide-enter-active,
  .drawer-slide-leave-active,
  .drawer-slide-enter-active .drawer-panel,
  .drawer-slide-leave-active .drawer-panel {
    transition: none;
  }
}
</style>
