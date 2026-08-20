import { defineConfig } from 'vitest/config'
import vue from '@vitejs/plugin-vue'
import path from 'node:path'

export default defineConfig({
  plugins: [vue()], // M-31：组件测试需要转换 .vue SFC
  resolve: {
    alias: [
      { find: '@shared', replacement: path.resolve('src/shared') },
      { find: '@renderer', replacement: path.resolve('src/renderer/src') },
      // electron-vite 的 `?modulePath` worker 后缀只在构建时生效（apply:'build'），
      // vitest 环境不处理它；映射到测试 stub，避免源码里的 worker import 在测试中崩。
      // 生产构建仍由 electron-vite 注入真实 worker bundle 路径（F5-003 §5 worker_thread）。
      {
        find: /\.\/ivf-worker\?modulePath$/,
        replacement: path.resolve('src/test/fixtures/ivf-worker-stub.ts')
      }
    ]
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.integration.test.ts', 'tests/evals/**/*.test.ts'],
    exclude: ['node_modules', 'out', 'dist', 'tests/e2e'],
    coverage: {
      provider: 'istanbul',
      all: true,
      include: ['src/**/*.ts'],
      // 此阈值（lines 75% / branches 70%）仅覆盖纯逻辑层。
      // 以下 exclude 的文件因 Electron 运行时依赖（app/BrowserWindow/ipcMain/session）
      // 无法在 vitest 纯 Node 环境加载，由 E2E 测试（tests/e2e/）覆盖，不计入此阈值。
      // 误读「75% = 全项目覆盖率」会高估实际覆盖范围。
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.integration.test.ts',
        'src/**/*.d.ts',
        // Electron 依赖文件：需要 Electron 运行时（app/BrowserWindow/ipcMain/session），
        // 由 E2E 测试覆盖（tests/e2e/），不在 vitest 单元测试范围。
        'src/main/index.ts',
        'src/main/windows/**',
        'src/main/security/csp.ts',
        'src/main/security/navigation.ts',
        'src/main/security/window-config.ts',
        'src/main/observability/crash-guard.ts',
        'src/main/ipc/register.ts',
        'src/main/ipc/handlers/app.ts',
        'src/main/ipc/handlers/window.ts',
        'src/main/ipc/handlers/debug.ts',
        'src/preload/index.ts',
        'src/renderer/src/main.ts',
        'src/renderer/src/App.vue',
        'src/renderer/src/orchestrators/**',
        'src/renderer/src/views/**',
        'src/renderer/src/components/**'
      ],
      thresholds: {
        lines: 75,
        branches: 70
      }
    }
  }
})
