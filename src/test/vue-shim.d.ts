// src/test/vue-shim.d.ts
// M-31：让 tsconfig.test.json（纯 tsc）能解析 .vue 导入。
// 渲染进程的 vue-tsc 原生处理 .vue；但测试类型检查走普通 tsc，
// 需要这个通用 shim（组件导入只用于挂载测试，不需要精确的 SFC 类型）。
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const component: DefineComponent<Record<string, unknown>, Record<string, unknown>, any>
  export default component
}
