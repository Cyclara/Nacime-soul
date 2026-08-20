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
  margin-top: 9px;
  padding-top: 7px;
  border-top: 1px solid var(--color-border-subtle);
}

.reasoning-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 28px;
  padding: 3px 8px 3px 5px;
  border-radius: var(--radius-full);
  color: var(--color-text-tertiary);
  font-size: var(--font-size-xs);
}

.reasoning-toggle:hover {
  background: var(--color-accent-soft);
  color: var(--color-text-secondary);
}

.reasoning-caret {
  display: grid;
  width: 18px;
  height: 18px;
  place-items: center;
  border-radius: 50%;
  background: var(--color-accent-soft);
  color: var(--color-accent);
  font-size: 9px;
}

.reasoning-label {
  font-weight: 500;
  letter-spacing: 0.015em;
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
  margin-top: 5px;
  padding: 10px 13px;
  border: 1px solid var(--color-border-subtle);
  border-left: 2px solid color-mix(in srgb, var(--color-accent) 70%, transparent);
  border-radius: 4px var(--radius) var(--radius) 4px;
  background: color-mix(in srgb, var(--color-bg-tertiary) 74%, transparent);
  user-select: text;
}

.reasoning-content pre {
  margin: 0;
  color: var(--color-text-secondary);
  font-family: inherit;
  font-size: var(--font-size-sm);
  line-height: 1.58;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
