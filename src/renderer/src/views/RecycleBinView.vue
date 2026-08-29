<script setup lang="ts">
// P3G-07：回收站只说“整理”，不把实现细节投射为角色台词。
import { onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useRecycleBinStore } from '../stores/recycle-bin'

const router = useRouter()
const recycleBin = useRecycleBinStore()

function back(): void { void router.push('/memory') }
async function restore(memoryId: string): Promise<void> { await recycleBin.restore(memoryId) }
async function empty(): Promise<void> {
  if (window.confirm('清空回收站后，这些记忆会被归入冷存储，确定继续吗？')) await recycleBin.empty()
}

onMounted(() => { void recycleBin.load() })
</script>

<template>
  <main class="recycle-bin-view">
    <header class="header">
      <button type="button" class="back" @click="back">← 记忆</button>
      <div><h1>回收站</h1><p>这里暂存已整理的记忆，你可以恢复或在确认后清空。</p></div>
      <button type="button" class="empty" :disabled="recycleBin.state.total === 0" @click="empty">清空回收站</button>
    </header>
    <p v-if="recycleBin.state.error" role="alert" class="error">{{ recycleBin.state.error }}</p>
    <p v-else-if="recycleBin.state.loading" role="status">正在查看整理中的记忆…</p>
    <p v-else-if="recycleBin.state.items.length === 0" class="empty-copy">这里暂时没有需要整理的记忆。</p>
    <ul v-else class="list">
      <li v-for="item in recycleBin.state.items" :key="item.id">
        <div><p>{{ item.content }}</p><small>{{ item.type }} · 重要度 {{ item.importance }}</small></div>
        <button type="button" @click="restore(item.id)">恢复</button>
      </li>
    </ul>
  </main>
</template>

<style scoped>
.recycle-bin-view { min-height: 100%; padding: clamp(1.25rem, 4vw, 3rem); background: var(--color-bg); color: var(--color-text); }
.header { display: flex; align-items: start; gap: 1rem; max-width: 900px; margin: 0 auto 1.5rem; }
.header div { flex: 1; } h1 { margin: 0; font-family: var(--font-family-display); } p { color: var(--color-text-secondary); line-height: 1.6; }
.back, .empty, li button { min-height: 2.4rem; padding: 0.45rem 0.75rem; border: 1px solid var(--color-border); border-radius: var(--radius); background: var(--color-surface); color: var(--color-text); cursor: pointer; font: inherit; }
.empty { border-color: var(--color-error-border); color: var(--color-error); } .empty:disabled { opacity: .45; cursor: not-allowed; }
.list { display: grid; gap: .65rem; max-width: 900px; margin: auto; padding: 0; list-style: none; }
.list li { display: flex; justify-content: space-between; gap: 1rem; padding: 1rem; border: 1px solid var(--color-border-subtle); border-radius: var(--radius-lg); background: var(--color-surface-translucent); }
.list p { margin: 0; color: var(--color-text); } small { color: var(--color-text-muted); } .error { max-width: 900px; margin: auto; color: var(--color-error); } .empty-copy { max-width: 900px; margin: 5rem auto; text-align: center; }
</style>
