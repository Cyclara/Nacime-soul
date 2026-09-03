// src/renderer/src/stores/settings-ui.ts
// P2-46: 设置抽屉的纯 renderer UI 状态。
// 依据：S-002 §3.4、S-002-补充 §3.3、S-006 §1.1。
// 只保存抽屉开关与当前 section；配置草稿/持久化仍由 config store 独占。

import { ref } from 'vue'
import { defineStore } from 'pinia'

export type SettingsSection =
  'model' | 'memory' | 'appearance' | 'live2d' | 'voice' | 'security' | 'about' | 'advanced'

type VisibleSettingsSection = SettingsSection

function visibleSection(section: SettingsSection): VisibleSettingsSection {
  // advanced 保留在冻结类型合同中；C0-5 起仅开发构建可见（F5-001 dev-only 高级分区，
  // S-005-补充 §1.6），生产构建一律回落 appearance。
  if (section === 'advanced' && !import.meta.env.DEV) {
    return 'appearance'
  }
  return section
}

export const useSettingsUiStore = defineStore('settings-ui', () => {
  const activeSection = ref<SettingsSection>('appearance')
  const isOpen = ref(false)

  function open(section: SettingsSection = 'appearance'): void {
    activeSection.value = visibleSection(section)
    isOpen.value = true
  }

  function close(): void {
    isOpen.value = false
  }

  function navigate(section: SettingsSection): void {
    activeSection.value = visibleSection(section)
  }

  return { activeSection, isOpen, open, close, navigate }
})
