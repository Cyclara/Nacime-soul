// src/test/fixtures/ivf-worker-stub.ts
// vitest 专用 stub：electron-vite 的 `?modulePath` 只在构建时生效，
// vitest（纯 Node + Vite 转译）不认识该后缀。生产 build 时由 electron-vite
// 注入真实打包后的 worker 路径；测试环境 worker 源码 .ts 无法被 Node 直接加载，
// 因此测试统一注入同步 kmeansBuilder，本 stub 只提供一个不存在的路径兜底。
// 依据：F5-003 §5（kmeans 必须 worker_thread）+ electron-vite worker 文档。
const stubWorkerPath = '/__vitest__/ivf-worker.js'
export default stubWorkerPath
