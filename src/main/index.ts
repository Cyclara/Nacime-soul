// src/main/index.ts
// P1-25: main 入口 - 接通 ChatService + 全部 IPC handler + 全部安全基础设施
// 依据：S-001 P1-25、S-003 §3.6/§3.7、F5-011 §5
//
// 初始化顺序：
//   1. Logger（electron-log sink + errorBuffer）
//   2. ConfigStore + SecretStore（setup）
//   3. 网络出口策略 Layer 1（installGlobalAgentGuard - P1-09B）
//   4. Hook 系统（注册 sanitize-message hook）
//   5. CrashGuard（P1-14 - 崩溃捕获 + renderer 重建熔断）
//   6. ChatService（providerFactory 注入 createSecureFetch - P1-09B Layer 2）
//   7. IPC handler 注册（app/window/config/chat/debug）
//   8. 窗口创建 + IPC guard

import { app, BrowserWindow, safeStorage, dialog } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log/main'

// 安全
import { installGlobalAgentGuard, createSecureFetch } from './security/network-policy'

// 可观测性
import { configureLogger, getLogger, createElectronLogSink } from './observability/logger'
import { createErrorBuffer } from './observability/error-buffer'
import { createCrashGuard } from './observability/crash-guard'
import { setHookRunnerLogger } from './hooks/runner'

// 配置与密钥
import { createConfigStore } from './config/store'
import { createSecretStore } from './security/secret-store'

// Hooks
import { registerHook } from './hooks/registry'
import { sanitizeMessageHook } from './hooks/builtin/sanitize-message'

// LLM
import { createProvider } from './llm/provider'
import { createFauxProvider } from './llm/providers/faux'
import { AppError } from '@shared/errors'

// Prompt
import { createFilePromptLoader } from './prompts/loader'

// Chat
import { createChatService, type ProviderFactoryResult } from './chat/service'
import { createMemorySessionStore } from './chat/session-store'

// 窗口
import { createChatWindow } from './windows/create-chat-window'

// IPC
import { configureIpcGuard } from './ipc/register'
import { registerAppHandlers } from './ipc/handlers/app'
import { registerWindowHandlers } from './ipc/handlers/window'
import { registerConfigHandlers } from './ipc/handlers/config'
import { registerChatHandlers } from './ipc/handlers/chat'
import { registerDebugHandlers } from './ipc/handlers/debug'

// 应用启动时间（CrashGuard 的 uptime 计算需要，在一切初始化前捕获）
const appStartTime = Date.now()

let mainWindow: BrowserWindow | null = null

app.whenReady().then(() => {
  // === 1. Logger ===
  log.transports.file.resolvePathFn = () => join(app.getPath('logs'), 'main.log')
  const errorBuffer = createErrorBuffer()
  configureLogger({
    sink: createElectronLogSink(log),
    minLevel: is.dev ? 'debug' : 'info',
    errorBuffer
  })
  const logger = getLogger('main')
  setHookRunnerLogger(getLogger('hooks'))
  logger.info('application starting', {
    scope: 'main',
    tags: { version: app.getVersion(), platform: process.platform, arch: process.arch }
  })

  // === 2. ConfigStore + SecretStore ===
  // E2E 测试支持：COMPANION_USER_DATA 环境变量指定临时 userData 目录
  const userDataPath = process.env['COMPANION_USER_DATA'] ?? app.getPath('userData')
  const configStore = createConfigStore({
    configPath: join(userDataPath, 'config.json'),
    logger: getLogger('config')
  })
  const configDiag = configStore.setup()
  logger.info('config loaded', {
    scope: 'main',
    tags: { status: configDiag.status, healed: String(configDiag.healed) }
  })

  const secretStore = createSecretStore({
    secretsPath: join(userDataPath, 'secrets.json'),
    safeStorage,
    logger: getLogger('secret')
  })
  secretStore.setup()

  // === 3. 网络出口策略 Layer 1（P1-09B: globalAgent 钩子）===
  // 拦截直接用 IP 访问私网的 http/https 请求（含第三方库的请求）。
  // Layer 2（createSecureFetch）在下方 providerFactory 中注入每个 provider。
  // 两层都要：现代 fetch（undici）不走 Node globalAgent，缺一层都会留下空洞（技术分析 §7.3）。
  const securityConfig = configStore.get().security
  installGlobalAgentGuard(
    { isDev: is.dev, allowHttpLocalhostInDev: securityConfig.allowHttpLocalhostInDev },
    getLogger('network')
  )
  logger.info('network policy Layer 1 installed (globalAgent guard)', { scope: 'main' })

  // === 4. Hook 系统（注册 sanitize hook）===
  registerHook(sanitizeMessageHook)

  // === 5. CrashGuard（P1-14: 崩溃捕获 + renderer 重建熔断）===
  // 安装在窗口创建前，以捕获初始化期间的崩溃。
  // createChatWindow 回调在 renderer 崩溃后自动重建窗口并重新配置 IPC guard。
  const trustedOrigins = new Set<string>()
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    trustedOrigins.add(new URL(process.env['ELECTRON_RENDERER_URL']).origin)
  } else {
    trustedOrigins.add('file://')
  }

  /** 为窗口配置 IPC guard（初始创建和 CrashGuard 重建时都要调用） */
  function setupWindowIpcGuard(win: BrowserWindow): void {
    configureIpcGuard(
      {
        trustedOrigins,
        trustedWebContentsIds: new Set([win.webContents.id])
      },
      getLogger('ipc')
    )
  }

  const crashGuard = createCrashGuard({
    logger: getLogger('crash'),
    errorBuffer,
    userDataPath,
    appVersion: app.getVersion(),
    startTime: appStartTime,
    createWindow: () => {
      // renderer 崩溃后重建窗口：更新 mainWindow 引用 + 重新配置 IPC guard
      // （新窗口的 webContents.id 与旧窗口不同，必须更新 trustedWebContentsIds）
      mainWindow = createChatWindow()
      setupWindowIpcGuard(mainWindow)
      return mainWindow
    },
    showCrashDialog: (reason: string) => {
      dialog.showErrorBox(
        '应用遇到严重错误',
        `应用遇到不可恢复的错误，需要退出。\n\n原因: ${reason}\n\n请重新启动应用。`
      )
    }
  })
  crashGuard.install()
  logger.info('crash guard installed', { scope: 'main' })

  // === 6. ChatService（providerFactory 注入 createSecureFetch - P1-09B Layer 2）===
  // __dirname 在 electron-vite 打包后始终为 out/main/（无论 E2E 还是打包后）。
  // resources/prompts/ 与 out/ 同级，所以向上两级。
  // 这与 create-chat-window.ts 用 __dirname 找 preload/renderer 同理。
  const promptsDir = join(__dirname, '../../resources/prompts')
  const promptLoader = createFilePromptLoader(promptsDir)
  const sessionStore = createMemorySessionStore()

  // Phase 1 默认 contextWindow。
  // DeepSeek V4 Flash/Pro 上下文长度 1M（1,048,576 tokens），最大输出 384K。
  // 来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing（2026-07-15 实测）
  // 技术分析 §2.7 要求 PromptBudgeter 是 Provider 无关的（接收 modelCapabilities 参数），
  // 此处仅是 Phase 1 默认值；Phase 2+ 按 provider/model 精确检测能力。
  // maxOutputTokens 用 config.model.maxTokens（用户配置的回复上限，默认 2048），
  // 非 DeepSeek V4 的 384K 能力上限——那是模型能力，此值是产品决策。
  const DEFAULT_CONTEXT_WINDOW = 1_048_576 // 1M tokens

  const providerFactory = (): ProviderFactoryResult => {
    // E2E 测试模式：用 Faux Provider 避免真实 API 调用
    if (process.env['COMPANION_TEST_MODE'] === 'faux') {
      const faux = createFauxProvider()
      faux.setResponses([{ type: 'text', text: '你好！我是 Nacime，很高兴认识你。' }])
      return {
        provider: faux,
        capabilities: {
          contextWindow: DEFAULT_CONTEXT_WINDOW,
          maxOutputTokens: configStore.get().model.maxTokens
        }
      }
    }
    const config = configStore.get()
    const apiKey = secretStore.get('modelApiKey')
    if (!apiKey) {
      throw new AppError({
        code: 'LLM_AUTH',
        userMessage: '未配置 API Key，请在设置中添加',
        severity: 'error',
        retryable: false
      })
    }
    // P1-09B Layer 2: 每次创建 provider 时用当前安全配置生成 secureFetch。
    // secureFetch 在请求前及每次重定向后复验 URL，拒绝私网/环回/链路本地地址。
    // 读取当前 config.security 以反映运行时配置变更（allowHttpLocalhostInDev 等）。
    const secureFetch = createSecureFetch(
      {
        isDev: is.dev,
        allowHttpLocalhostInDev: config.security.allowHttpLocalhostInDev
      },
      getLogger('network')
    )
    const provider = createProvider(
      { config: config.model, apiKey, fetchFn: secureFetch },
      { logger: getLogger('llm') }
    )
    return {
      provider,
      capabilities: {
        contextWindow: DEFAULT_CONTEXT_WINDOW,
        maxOutputTokens: config.model.maxTokens
      }
    }
  }

  const chatService = createChatService({
    logger: getLogger('chat'),
    promptLoader,
    sessionStore,
    providerFactory
  })

  // === 7. IPC handler 注册 ===
  registerAppHandlers({ logger: getLogger('app') })
  registerConfigHandlers({
    configStore,
    secretStore,
    logger: getLogger('config')
  })
  registerChatHandlers({
    chatService,
    logger: getLogger('chat')
  })
  registerDebugHandlers({
    logger: getLogger('debug'),
    errorBuffer,
    startTime: appStartTime,
    logFilePath: join(app.getPath('logs'), 'main.log')
  })

  // === 8. 窗口创建 ===
  // appId 与 electron-builder.yml 保持一致（S-005 §3.11 占位值，发布前由用户确认替换）
  electronApp.setAppUserModelId('com.nacime-soul.app')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  mainWindow = createChatWindow()
  setupWindowIpcGuard(mainWindow)

  // window handler 需要 getMainWindow（窗口可能被 CrashGuard 重建）
  registerWindowHandlers({
    getMainWindow: () => mainWindow,
    logger: getLogger('window')
  })

  logger.info('application ready', { scope: 'main' })

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createChatWindow()
      setupWindowIpcGuard(mainWindow)
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
