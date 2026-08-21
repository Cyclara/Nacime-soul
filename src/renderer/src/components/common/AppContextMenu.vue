<script setup lang="ts">
// 验收反馈⑤：主题化右键菜单（替代 M-38 main 侧原生菜单——原生菜单纯黑不贴主题）。
//
// 菜单集合（沿用 M-38 验收标准）：
//   - 输入框（textarea/文本类 input）：剪切/复制/粘贴（按选中可用）+ 全选
//   - 只读区域有选中文本：复制 + 全选
//   - 无选中且非输入框：不弹空菜单
//
// 行为说明：
//   - 剪贴板走 navigator.clipboard（异步）；粘贴总是可用，空剪贴板时点击无操作
//   - 输入框改值用 setRangeText + 派发 input 事件，v-model/@input 链路（Composer draft）正常感知
//   - 关闭：点菜单外 / Esc / 滚动 / 窗口失焦 / 尺寸变化

import { onMounted, onBeforeUnmount, ref } from 'vue'

interface MenuItem {
  id: 'cut' | 'copy' | 'paste' | 'selectAll'
  label: string
  enabled: boolean
}

const visible = ref(false)
const x = ref(0)
const y = ref(0)
const items = ref<MenuItem[]>([])

/** 本次菜单作用的输入框（只读区域菜单时为 null） */
let editableTarget: HTMLInputElement | HTMLTextAreaElement | null = null

const MENU_WIDTH = 124
const ITEM_HEIGHT = 32
const MENU_PADDING = 10
const VIEWPORT_GAP = 8

function isTextEditable(el: EventTarget | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (el instanceof HTMLTextAreaElement) return true
  return el instanceof HTMLInputElement && /^(text|search|url|tel|password)$/.test(el.type)
}

function close(): void {
  visible.value = false
  editableTarget = null
}

function onContextMenu(e: MouseEvent): void {
  const sel = window.getSelection()
  const next: MenuItem[] = []
  editableTarget = null

  if (isTextEditable(e.target)) {
    const el = e.target
    const hasSelection = (el.selectionStart ?? 0) !== (el.selectionEnd ?? 0)
    next.push(
      { id: 'cut', label: '剪切', enabled: hasSelection },
      { id: 'copy', label: '复制', enabled: hasSelection },
      { id: 'paste', label: '粘贴', enabled: true },
      { id: 'selectAll', label: '全选', enabled: el.value.length > 0 }
    )
    editableTarget = el
  } else if (sel && !sel.isCollapsed && sel.toString().length > 0) {
    next.push(
      { id: 'copy', label: '复制', enabled: true },
      { id: 'selectAll', label: '全选', enabled: true }
    )
  }

  // 无选中且非输入框：不弹空菜单（交给浏览器默认——Electron 里即什么都不弹）
  if (next.length === 0) return

  e.preventDefault()
  items.value = next
  // 防溢出：贴边时向左/向上收
  const menuH = next.length * ITEM_HEIGHT + MENU_PADDING
  x.value = Math.max(
    VIEWPORT_GAP,
    Math.min(e.clientX, window.innerWidth - MENU_WIDTH - VIEWPORT_GAP)
  )
  y.value = Math.max(VIEWPORT_GAP, Math.min(e.clientY, window.innerHeight - menuH - VIEWPORT_GAP))
  visible.value = true
}

/** 输入框改值并通知 Vue 链路（v-model/@input 都监听 input 事件） */
function replaceEditableRange(
  el: HTMLInputElement | HTMLTextAreaElement,
  text: string,
  start: number,
  end: number,
  caret: 'start' | 'end' | 'select'
): void {
  el.setRangeText(text, start, end, caret)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function run(id: MenuItem['id']): Promise<void> {
  const el = editableTarget
  const sel = window.getSelection()
  try {
    if (el) {
      const start = el.selectionStart ?? 0
      const end = el.selectionEnd ?? 0
      if (id === 'cut' || id === 'copy') {
        await navigator.clipboard.writeText(el.value.slice(start, end))
        if (id === 'cut') replaceEditableRange(el, '', start, end, 'select')
      } else if (id === 'paste') {
        const text = await navigator.clipboard.readText()
        if (text.length > 0) replaceEditableRange(el, text, start, end, 'end')
      } else if (id === 'selectAll') {
        el.focus()
        el.setSelectionRange(0, el.value.length)
      }
    } else if (sel) {
      if (id === 'copy') {
        await navigator.clipboard.writeText(sel.toString())
      } else if (id === 'selectAll') {
        sel.selectAllChildren(document.body)
      }
    }
  } finally {
    close()
  }
}

function onGlobalPointerDown(e: PointerEvent): void {
  if (!visible.value) return
  if (e.target instanceof HTMLElement && e.target.closest('.app-context-menu')) return
  close()
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && visible.value) {
    e.stopPropagation()
    close()
  }
}

onMounted(() => {
  window.addEventListener('contextmenu', onContextMenu)
  window.addEventListener('pointerdown', onGlobalPointerDown, true)
  window.addEventListener('keydown', onKeyDown, true)
  window.addEventListener('blur', close)
  window.addEventListener('resize', close)
  // capture：菜单打开时页面滚动（聊天列表）也关闭
  window.addEventListener('scroll', close, true)
})

onBeforeUnmount(() => {
  window.removeEventListener('contextmenu', onContextMenu)
  window.removeEventListener('pointerdown', onGlobalPointerDown, true)
  window.removeEventListener('keydown', onKeyDown, true)
  window.removeEventListener('blur', close)
  window.removeEventListener('resize', close)
  window.removeEventListener('scroll', close, true)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="app-context-menu"
      :style="{ left: `${x}px`, top: `${y}px` }"
      role="menu"
      @contextmenu.stop.prevent
    >
      <button
        v-for="item in items"
        :key="item.id"
        class="app-context-menu-item"
        :disabled="!item.enabled"
        role="menuitem"
        type="button"
        @click="run(item.id)"
      >
        {{ item.label }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
/* 安静贴主题：浮层表面 + 细边 + 中影，hover 只是一层淡淡的主题色 */
.app-context-menu {
  position: fixed;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  min-width: 124px;
  padding: 5px;
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius);
  box-shadow: var(--shadow-md);
  animation: context-menu-in 0.12s ease-out;
}

.app-context-menu-item {
  padding: 6px 12px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
}

.app-context-menu-item:hover:not(:disabled) {
  background: var(--color-accent-soft);
}

.app-context-menu-item:active:not(:disabled) {
  background: var(--color-accent-soft-hover);
}

.app-context-menu-item:disabled {
  color: var(--color-text-muted);
  cursor: default;
}

.app-context-menu-item:focus-visible {
  outline: 1px solid var(--color-border-focus, var(--color-accent));
  outline-offset: -1px;
}

@keyframes context-menu-in {
  from {
    opacity: 0;
    transform: translateY(-2px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
