// src/preload/index.d.ts
// Preload 类型声明
//
// window.companion 的完整类型定义在 src/shared/global.d.ts（CompanionApi 接口）。
// 模板原有的 window.electron / window.api 声明已移除：
// preload 只通过 contextBridge 暴露 window.companion，不暴露 window.electron 或 window.api。

export {}
