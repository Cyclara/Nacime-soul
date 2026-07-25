<script setup lang="ts">
// P1-24B: 思考过程显示块
// 依据：S-001 P1-24、S-002 §3.2、S-003 §3.8
//
// 设计要点：
//   - 仅 assistant 消息可能含 reasoning
//   - 可展开/折叠，默认展开（跟随 ui.chat.showReasoning）
//   - 流式过程中显示“思考中…”动画
//   - 内容用纯文本展示（reasoning 通常已是自然语言，不需要 Markdown）
//   - 参考 cc-haha ThinkingBlock 的交互模式

import { ref, computed } from 'vue'

const props = defineProps<{
  content: string
  isStreaming: boolean
}>()

const expanded = ref(true)

const hasContent = computed(() => props.content.trim().length > 0)
const label = computed(() => {
  if (props.isStreaming) return '思考中'
  return hasContent.value ? '思考过程' : '已思考'
})

function toggle(): void {
  expanded.value = !expanded.value
}
</script>

<template>
  <div class="reasoning-block">
    <button type="button" class="reasoning-toggle" :aria-expanded="expanded" @click="toggle">
      <span class="reasoning-caret">{{ expanded ? '▾' : '▸' }}</span>
      <span class="reasoning-label">{{ label }}</span>
      <span v-if="isStreaming" class="reasoning-dots" />
    </button>

    <div v-if="expanded && hasContent" class="reasoning-content" data-testid="reasoning-content">
      <pre>{{ content }}</pre>
    </div>
  </div>
</template>

<style scoped>
.reasoning-block {
  margin-top: var(--spacing-xs);
}
.reasoning-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) var(--spacing-sm);
  background: transparent;
  color: var(--color-text-tertiary);
  font-size: var(--font-size-sm);
  border-radius: var(--radius);
}
.reasoning-toggle:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
}
.reasoning-caret {
  font-size: 10px;
}
.reasoning-label {
  font-weight: 500;
}
.reasoning-dots::after {
  content: '';
  animation: reasoning-dots 1.4s steps(4, end) infinite;
}
@keyframes reasoning-dots {
  0% {
    content: '';
  }
  25% {
    content: '.';
  }
  50% {
    content: '..';
  }
  75% {
    content: '...';
  }
}
.reasoning-content {
  margin-top: var(--spacing-xs);
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius);
  background: var(--color-bg-tertiary);
  border-left: 2px solid var(--color-accent);
}
.reasoning-content pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  line-height: 1.5;
}
</style>
