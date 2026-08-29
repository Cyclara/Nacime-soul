<script setup lang="ts">
// F5-001 C0-5：高级分区（仅开发构建）。S-005-补充 §1.6：
// 不新增普通用户可见的 persona 设置页；合规审查入口只存在于 dev-only Advanced 子区。
// 生产构建即使导航状态异常落到这里也不渲染任何内容（纵深防御，settings-ui store 已先行拦截）。
import PersonaComplianceSettings from './PersonaComplianceSettings.vue'

const isDev = import.meta.env.DEV
</script>

<template>
  <PersonaComplianceSettings v-if="isDev" />
</template>
