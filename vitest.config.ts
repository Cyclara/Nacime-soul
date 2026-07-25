import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve('src/shared'),
      '@renderer': path.resolve('src/renderer/src')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.integration.test.ts'],
    exclude: ['node_modules', 'out', 'dist', 'tests/e2e'],
    coverage: {
      provider: 'istanbul',
      all: true,
      include: ['src/**/*.ts'],
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
