<script setup lang="ts">
// P2-31: MemoryEnableGuide -- memory.enabled=false 时的引导态（替换整页）。
// 依据：S-006 §1.2、S-012 §3.3（引导态消费 enabled:false）。
// 引导用户去设置开启记忆功能。

import { useRouter } from 'vue-router'

const router = useRouter()
// 设置是模态抽屉，由 settingsUi store 控制；此处发全局事件让 ChatShell 打开设置
// 简化：返回聊天页后用户可从菜单进设置。未来可接 settingsUi.open('memory')
const emit = defineEmits<{ (e: 'open-settings'): void }>()
</script>

<template>
  <div class="enable-guide">
    <div class="guide-card" role="status">
      <div class="guide-illustration" aria-hidden="true">
        <svg viewBox="0 0 120 120" class="memory-blob">
          <circle cx="60" cy="60" r="50" fill="var(--color-accent-soft)" />
          <path
            d="M45 55c0-8.3 6.7-15 15-15s15 6.7 15 15-6.7 15-15 15"
            stroke="var(--color-accent)"
            stroke-width="3"
            fill="none"
            stroke-linecap="round"
          />
          <circle cx="52" cy="52" r="3" fill="var(--color-accent)" />
          <circle cx="68" cy="52" r="3" fill="var(--color-accent)" />
          <path
            d="M55 68c2 2 8 2 10 0"
            stroke="var(--color-accent)"
            stroke-width="2"
            fill="none"
            stroke-linecap="round"
          />
        </svg>
      </div>
      <h2 class="guide-title">她还没有开始记住你</h2>
      <p class="guide-desc">开启记忆功能后，她会记住你告诉过她的事，并在以后的对话中自然地提起。</p>
      <div class="privacy-note">
        <span class="privacy-icon">🔒</span>
        <span>所有记忆只保存在你的电脑上，不会上传到任何地方。</span>
      </div>
      <div class="guide-actions">
        <button class="primary-btn" @click="emit('open-settings')">去设置开启</button>
        <button class="secondary-btn" @click="router.push('/')">回到聊天</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.enable-guide {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-lg);
  background: var(--color-bg);
}

.guide-card {
  max-width: 420px;
  width: 100%;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-2xl) var(--spacing-xl);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
}

.guide-illustration {
  width: 120px;
  height: 120px;
}

.memory-blob {
  width: 100%;
  height: 100%;
}

.guide-title {
  font-size: var(--font-size-xl);
  font-weight: 600;
  color: var(--color-text);
}

.guide-desc {
  color: var(--color-text-secondary);
  line-height: 1.7;
  font-size: var(--font-size-base);
}

.privacy-note {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-xs) var(--spacing-sm);
  background: var(--color-accent-soft);
  border: 1px solid var(--color-accent-soft-hover);
  border-radius: var(--radius-full);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.privacy-icon {
  font-size: var(--font-size-sm);
}

.guide-actions {
  display: flex;
  gap: var(--spacing-sm);
  justify-content: center;
  margin-top: var(--spacing-sm);
  flex-wrap: wrap;
}

.primary-btn {
  padding: var(--spacing-sm) var(--spacing-lg);
  border-radius: var(--radius);
  background: var(--color-accent);
  color: var(--color-text-on-accent);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}

.primary-btn:hover {
  background: var(--color-accent-hover);
  box-shadow: var(--shadow-md);
}

.secondary-btn {
  padding: var(--spacing-sm) var(--spacing-lg);
  border-radius: var(--radius);
  background: var(--color-surface);
  color: var(--color-text);
  border: 1px solid var(--color-border);
}

.secondary-btn:hover {
  background: var(--color-bg-tertiary);
}

@media (max-width: 480px) {
  .guide-card {
    padding: var(--spacing-xl) var(--spacing-lg);
  }

  .guide-actions {
    flex-direction: column;
    width: 100%;
  }

  .primary-btn,
  .secondary-btn {
    width: 100%;
  }
}
</style>
