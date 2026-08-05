// scripts/run-vitest-electron.mjs
// Phase 2 起：记忆系统引入 better-sqlite3（原生模块）。postinstall 的 electron-rebuild
// 把它编译为 Electron 的 Node ABI（NODE_MODULE_VERSION 148），而系统 Node（147）无法加载。
// 用 ELECTRON_RUN_AS_NODE=1 让 Vitest 跑在 Electron 自带的 Node 运行时里，复用同一个原生
// 二进制——测试与生产同 ABI，无需为测试单独重编译，也避免与 dev/build 之间来回切 ABI。
//
// 用法：node scripts/run-vitest-electron.mjs <vitest 参数...>
//   npm test          -> node scripts/run-vitest-electron.mjs run
//   npm run test:coverage -> node scripts/run-vitest-electron.mjs run --coverage
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

const require = createRequire(import.meta.url)
/** electron 包在 Node 里 require 时返回其可执行文件的绝对路径 */
const electronPath = require('electron')
/** vitest CLI 入口（vitest/vitest.mjs），从包根定位，不依赖 exports 子路径 */
const vitestCli = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs')

const res = spawnSync(electronPath, [vitestCli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  // 子进程 fork 出来的 vitest worker 会继承本环境，ELECTRON_RUN_AS_NODE 随之生效
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
})

if (res.error) {
  console.error('[run-vitest-electron] 无法启动 Electron 运行 Vitest:', res.error)
  process.exit(1)
}
process.exit(res.status ?? 1)
