// P3G-04：回收站是 main-owned soft_deleted 投影；不与 memory store 互调。

import { reactive } from 'vue'
import { defineStore } from 'pinia'
import type { RecycleBinItem } from '@shared/memory/types'

export const useRecycleBinStore = defineStore('recycle-bin', () => {
  const state = reactive({
    items: [] as RecycleBinItem[],
    total: 0,
    offset: 0,
    limit: 50,
    loading: false,
    error: null as string | null
  })

  async function load(offset = 0): Promise<void> {
    if (!window.companion) return
    state.loading = true
    state.error = null
    try {
      const result = await window.companion.memory.listRecycleBin({ limit: state.limit, offset })
      if (!result.ok) {
        state.error = result.error.message
        return
      }
      state.items = result.data.items
      state.total = result.data.total
      state.offset = offset
    } catch (error) {
      state.error = error instanceof Error ? error.message : '回收站暂时无法加载'
    } finally {
      state.loading = false
    }
  }

  async function restore(memoryId: string): Promise<boolean> {
    if (!window.companion) return false
    const result = await window.companion.memory.restoreFromRecycleBin({ memoryId })
    if (!result.ok) {
      state.error = result.error.message
      return false
    }
    await load(state.offset)
    return true
  }

  async function empty(): Promise<number | null> {
    if (!window.companion) return null
    const result = await window.companion.memory.emptyRecycleBin({ confirm: true })
    if (!result.ok) {
      state.error = result.error.message
      return null
    }
    await load(0)
    return result.data.purged
  }

  return { state, load, restore, empty }
})
