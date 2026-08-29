<script setup lang="ts">
// P3A-24/25：Live2D 功能设置区。视觉样式使用项目既有 token，不改 store/IPC 合同。
import { onMounted, onBeforeUnmount } from 'vue'
import { useLive2dStore } from '../../stores/live2d'
import { useConfigStore } from '../../stores/config'
import { createLive2dSettingsOrchestrator } from '../../orchestrators/live2d-settings'
import CurrentModelCard from '../live2d/CurrentModelCard.vue'
import Live2dPreviewControls from '../live2d/Live2dPreviewControls.vue'
import ModelList from '../live2d/ModelList.vue'
import ModelImportDropzone from '../live2d/ModelImportDropzone.vue'
import ModelValidationResult from '../live2d/ModelValidationResult.vue'

const live2d = useLive2dStore()
const config = useConfigStore()
const orchestrator = createLive2dSettingsOrchestrator({ config, live2d })
let unsubscribe: (() => void) | null = null

onMounted(async () => {
  await live2d.hydrate()
  unsubscribe = live2d.subscribe()
})
onBeforeUnmount(() => {
  unsubscribe?.()
  unsubscribe = null
  // 关掉设置面板时收回未保存的取景预览，stage 回到已落盘构图。
  orchestrator.endPreview()
})
</script>

<template>
  <section class="live2d-settings" aria-labelledby="live2d-settings-title">
    <header class="live2d-settings__header">
      <div>
        <p class="live2d-settings__kicker">她的存在感</p>
        <h2 id="live2d-settings-title">Live2D 形象</h2>
        <p class="live2d-settings__intro">让她安静地待在桌面上。模型出问题时，文字聊天仍然可以继续。</p>
      </div>
      <span class="live2d-settings__spark" aria-hidden="true">✦</span>
    </header>

    <CurrentModelCard />
    <Live2dPreviewControls :orchestrator="orchestrator" />
    <ModelList />
    <ModelImportDropzone />
    <ModelValidationResult :error="live2d.state.lastError" :warnings="live2d.currentModel?.warnings" />
  </section>
</template>

<style scoped>
.live2d-settings { display: grid; gap: 0.8rem; max-width: 38rem; padding: 0.25rem 0; color: var(--color-text-primary, white); }
.live2d-settings__header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; padding: 0.25rem 0 0.35rem; }
.live2d-settings__kicker { margin: 0 0 0.3rem; color: rgb(193 177 255 / 82%); font-size: 0.7rem; letter-spacing: 0.12em; text-transform: uppercase; }
.live2d-settings h2 { margin: 0; color: var(--color-text-primary, white); font-size: 1.35rem; letter-spacing: -0.02em; }
.live2d-settings__intro { max-width: 29rem; margin: 0.45rem 0 0; color: var(--color-text-secondary, rgb(255 255 255 / 62%)); font-size: 0.78rem; line-height: 1.55; }
.live2d-settings__spark { display: grid; width: 2.5rem; height: 2.5rem; place-items: center; border: 1px solid rgb(193 177 255 / 20%); border-radius: 0.8rem; background: rgb(193 177 255 / 9%); color: rgb(219 211 255); font-size: 1.15rem; }
</style>
