import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'
import { CSP_HEADER_VALUE } from './src/main/security/csp'

/**
 * V-01：生产环境 file:// 下 webRequest.onHeadersReceived 不会触发
 *（Electron 官方确认：file:// 不是 HTTP 协议，没有响应头可改，见
 * electron/electron#23485 / #37762），csp.ts 的 header 注入对打包后的
 * 主文档无效。因此构建时向 index.html 注入 <meta> CSP 作为生产兜底。
 *
 * apply:'build' —— 开发环境不注入：dev 走 http://localhost，header 已生效，
 * 且 dev CSP 放宽了 ws://（HMR 需要），注入严格 meta 会打断 HMR。
 *
 * 单一事实来源：策略字符串复用 csp.ts 的 CSP_HEADER_VALUE，不另抄一份。
 * 我们的策略未使用 meta 不支持的指令（frame-ancestors/report-uri/sandbox），可安全内联。
 */
function injectCspMeta(): Plugin {
  return {
    name: 'inject-csp-meta',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return {
          html,
          tags: [
            {
              tag: 'meta',
              attrs: {
                'http-equiv': 'Content-Security-Policy',
                content: CSP_HEADER_VALUE
              },
              injectTo: 'head'
            }
          ]
        }
      }
    }
  }
}

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          'live2d-stage': resolve('src/preload/live2d-stage.ts')
        }
      }
    }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [vue(), injectCspMeta()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          live2d: resolve('src/renderer/live2d.html')
        }
      }
    }
  }
})
