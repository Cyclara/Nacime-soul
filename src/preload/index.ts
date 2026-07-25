// src/preload/index.ts
// Preload 入口：暴露 typed window.companion API
// 依据：S-001 P1-17、S-003 §3.7
//
// 安全红线：
//   - 不暴露原始 ipcRenderer
//   - 不暴露通用 invoke(channel: string)
//   - 仅暴露 contextBridge 白名单 API
//   - contextIsolation 关闭时不暴露任何 API

import { contextBridge } from 'electron'
import { companionApi } from './api'

// 使用 contextBridge 暴露 typed API 到 renderer
// 仅在 contextIsolation 开启时暴露（生产环境始终开启）
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('companion', companionApi)
  } catch (error) {
    console.error('Failed to expose companion API:', error)
  }
} else {
  // contextIsolation 关闭时，不暴露任何 API
  // 这是安全红线：生产环境不应该走到这里
  console.error('contextIsolation is disabled — companion API NOT exposed')
}
