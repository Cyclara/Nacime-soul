<script setup lang="ts">
// P3A-26：透明 stage 的实体错误遮罩。错误文案按固定错误码选择，不显示 stack/绝对路径。
import type { Live2dLoadErrorCode } from '@shared/live2d/types'

defineProps<{ code: string | null }>()
const emit = defineEmits<{ retry: [] }>()

const copy: Record<Live2dLoadErrorCode, string> = {
  FILE_NOT_FOUND: '没有找到模型文件。',
  MOC3_NOT_FOUND: '模型数据文件不完整。',
  MODEL_JSON_INVALID: '模型索引文件无法读取。',
  WEBGL_UNSUPPORTED: '当前环境不支持图形渲染。',
  TEXTURE_TOO_LARGE: '模型贴图超出设备限制。',
  CUBISM_PARSE_ERROR: '模型格式暂时无法解析。',
  TEXTURE_UPLOAD_FAILED: '贴图上传到显卡时失败了。'
}

// 遮罩只在「用户模型 → 重试一次 → Mao → Hiyori」整条降级链耗尽后才出现，此时再放一个
// 「切换到默认模型」按钮是骗人——默认模型刚刚已经失败过。而 stage preload 只有
// ready/report/onCommand 三项（P3A-05 刻意收窄），不该为一句引导扩大它的能力面。
// 所以恢复入口 = 就地重试 + 指向聊天窗口里已有的模型管理位置。
const guidance: Record<Live2dLoadErrorCode, string> = {
  FILE_NOT_FOUND: '可以在聊天窗口的「设置 → 角色」里重新导入或换一个模型。',
  MOC3_NOT_FOUND: '可以在聊天窗口的「设置 → 角色」里重新导入或换一个模型。',
  MODEL_JSON_INVALID: '可以在聊天窗口的「设置 → 角色」里重新导入或换一个模型。',
  CUBISM_PARSE_ERROR: '可以在聊天窗口的「设置 → 角色」里换一个模型。',
  TEXTURE_TOO_LARGE: '可以在聊天窗口的「设置 → 角色」里换一个更轻的模型。',
  WEBGL_UNSUPPORTED: '可以检查显卡驱动是否为最新；在此期间文字聊天不受影响。',
  TEXTURE_UPLOAD_FAILED: '可以检查显卡驱动，或在「设置 → 角色」里换一个更轻的模型。'
}

function message(code: string | null): string {
  return code !== null && code in copy ? copy[code as Live2dLoadErrorCode] : 'Live2D 暂时没有显示出来。'
}

function hint(code: string | null): string {
  return code !== null && code in guidance
    ? guidance[code as Live2dLoadErrorCode]
    : '可以在聊天窗口的「设置 → 角色」里换一个模型。'
}
</script>

<template>
  <aside class="error-overlay" role="alert" aria-live="assertive">
    <div class="error-overlay__mark" aria-hidden="true">!</div>
    <div class="error-overlay__copy">
      <strong>她暂时没能出现</strong>
      <p>{{ message(code) }}</p>
      <p class="error-overlay__hint">{{ hint(code) }}</p>
      <small v-if="code">错误码：{{ code }}</small>
    </div>
    <button type="button" @click="emit('retry')">再试一次</button>
  </aside>
</template>

<style scoped>
.error-overlay { position: absolute; inset: 50% 1rem auto; display: flex; align-items: center; gap: 0.7rem; max-width: 25rem; margin: 0 auto; padding: 0.85rem; border: 1px solid rgb(255 139 139 / 52%); border-radius: 0.9rem; background: rgb(35 22 31 / 92%); box-shadow: 0 0.8rem 2.2rem rgb(0 0 0 / 38%); color: rgb(255 235 235 / 94%); transform: translateY(-50%); backdrop-filter: blur(0.8rem); -webkit-app-region: no-drag; }
.error-overlay__mark { display: grid; width: 1.8rem; height: 1.8rem; flex: 0 0 auto; place-items: center; border: 1px solid rgb(255 139 139 / 55%); border-radius: 50%; color: rgb(255 167 167); font-weight: 700; }
.error-overlay__copy { min-width: 0; flex: 1; }
.error-overlay__copy strong { display: block; font-size: 0.8rem; }
.error-overlay__copy p { margin: 0.2rem 0 0; color: rgb(255 235 235 / 74%); font-size: 0.72rem; line-height: 1.4; }
.error-overlay__copy p.error-overlay__hint { color: rgb(255 235 235 / 58%); }
.error-overlay__copy small { display: block; margin-top: 0.2rem; color: rgb(255 235 235 / 48%); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.62rem; }
.error-overlay button { flex: 0 0 auto; min-height: 2rem; padding: 0.35rem 0.6rem; border: 1px solid rgb(255 167 167 / 46%); border-radius: 0.55rem; background: transparent; color: rgb(255 235 235 / 92%); cursor: pointer; font: inherit; font-size: 0.7rem; }
.error-overlay button:hover { background: rgb(255 139 139 / 16%); }
.error-overlay button:focus-visible { outline: 2px solid rgb(255 190 190); outline-offset: 2px; }
</style>
