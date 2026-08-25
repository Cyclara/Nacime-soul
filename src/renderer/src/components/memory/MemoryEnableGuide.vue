<script setup lang="ts">
// P2-31: MemoryEnableGuide -- memory.enabled=false 时的引导态（替换整页）。
// 依据：S-006 §1.2、S-022 §3.3（引导态消费 enabled:false）。
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
  display: flex;
  min-height: 0;
  flex: 1;
  align-items: center;
  justify-content: center;
  overflow-y: auto;
  padding: clamp(18px, 4vw, 48px);
  background:
    radial-gradient(circle at 50% 30%, var(--color-companion-soft), transparent 38%), transparent;
}

.guide-card {
  position: relative;
  display: flex;
  width: min(100%, 540px);
  flex-direction: column;
  align-items: center;
  gap: 15px;
  margin-block: auto;
  padding: clamp(30px, 5vw, 52px);
  overflow: hidden;
  border: 1px solid var(--color-border-subtle);
  border-radius: 28px;
  background: var(--color-surface-translucent);
  box-shadow:
    var(--shadow-lg),
    inset 0 1px rgba(255, 255, 255, 0.04);
  text-align: center;
  backdrop-filter: blur(20px) saturate(112%);
}

.guide-card::before {
  position: absolute;
  top: -88px;
  right: -70px;
  width: 210px;
  height: 210px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 50%;
  background: radial-gradient(circle, var(--color-accent-soft), transparent 66%);
  content: '';
  pointer-events: none;
}

.guide-illustration {
  position: relative;
  z-index: 1;
  width: 112px;
  height: 112px;
  margin-bottom: 2px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 38px 38px 38px 14px;
  background:
    radial-gradient(circle at 35% 30%, var(--color-companion-soft), transparent 44%),
    var(--color-bg-tertiary);
  box-shadow:
    var(--shadow-md),
    inset 0 1px rgba(255, 255, 255, 0.05);
}

.memory-blob {
  width: 100%;
  height: 100%;
  filter: saturate(0.75);
}

.guide-title {
  position: relative;
  z-index: 1;
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: clamp(24px, 3.2vw, 30px);
  font-weight: 600;
  letter-spacing: 0.01em;
}

.guide-desc {
  position: relative;
  z-index: 1;
  max-width: 38ch;
  color: var(--color-text-secondary);
  font-size: var(--font-size-base);
  line-height: 1.78;
}

.privacy-note {
  position: relative;
  z-index: 1;
  display: inline-flex;
  align-items: flex-start;
  gap: 7px;
  max-width: 100%;
  padding: 8px 11px;
  border: 1px solid color-mix(in srgb, var(--color-sage) 24%, var(--color-border));
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--color-sage) 8%, transparent);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  line-height: 1.55;
  text-align: left;
}

.privacy-icon {
  filter: grayscale(1);
  font-size: 12px;
  opacity: 0.72;
}

.guide-actions {
  position: relative;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 9px;
  margin-top: 8px;
}

.primary-btn,
.secondary-btn {
  min-height: 44px;
  padding: 9px 20px;
  border-radius: var(--radius-full);
  font-weight: 600;
}

.primary-btn {
  background: var(--color-accent);
  box-shadow:
    inset 0 1px rgba(255, 255, 255, 0.22),
    var(--shadow-sm);
  color: var(--color-text-on-accent);
}

.primary-btn:hover {
  background: var(--color-accent-hover);
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}

.secondary-btn {
  border: 1px solid var(--color-border-subtle);
  background: var(--color-surface);
  color: var(--color-text-secondary);
}

.secondary-btn:hover {
  border-color: var(--color-border);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
}

@media (max-width: 480px) {
  .enable-guide {
    align-items: flex-start;
    padding: 12px;
  }

  .guide-card {
    padding: 28px 20px;
  }

  .guide-actions {
    width: 100%;
    flex-direction: column;
  }

  .primary-btn,
  .secondary-btn {
    width: 100%;
  }
}
</style>
