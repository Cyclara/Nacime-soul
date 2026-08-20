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
import { createMetrics, configureMetrics } from './observability/metrics'
import { createTracer, configureTracer } from './observability/tracer'
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
import { AppError, isAppError, type PublicAppError } from '@shared/errors'

// Prompt
import { createFilePromptLoader } from './prompts/loader'

// Chat
import { createChatService, type ProviderFactoryResult } from './chat/service'
import { createSQLiteSessionStore } from './chat/sqlite-session-store'
import { createIdempotencyLedger } from './chat/idempotency-ledger'
import { openMemoryDb } from './memory/db'

// Memory 基础设施（Phase 2：P2-10~15 接线）
import { setupMemoryInfrastructure } from './memory/setup'
import type { PromptContextAssembler } from './prompts/context-assembler'

// 窗口
import { createChatWindow } from './windows/create-chat-window'

// 迁移（F5-013：启动链第一个数据触碰者）
import { createMigrationRunner } from './migrations/runner'
import { MIGRATIONS } from './migrations/registry'

// IPC
import { configureIpcGuard } from './ipc/register'
import { registerAppHandlers } from './ipc/handlers/app'
import { registerWindowHandlers, attachWindowStateListeners } from './ipc/handlers/window'
import { registerConfigHandlers } from './ipc/handlers/config'
import { registerChatHandlers } from './ipc/handlers/chat'
import { registerDebugHandlers } from './ipc/handlers/debug'
import { registerMemoryHandlers } from './ipc/handlers/memory'
import { registerGrowthHandlers } from './ipc/handlers/growth'
import { registerDmaeHandlers } from './ipc/handlers/dmae'

// 应用启动时间（CrashGuard 的 uptime 计算需要，在一切初始化前捕获）
const appStartTime = Date.now()

// M-47（2026-08-20 根因修复）：开发模式下立即钉死 app 身份，必须在任何
// safeStorage/getPath/singleInstanceLock 使用之前。
// 背景（探针实证）：Electron 43 的 safeStorage 加密上下文绑定 app.name——
// `electron out/main/index.js` 启动时名为 "Electron"（app 路径是文件，无
// package.json 可读），`electron .` 启动时名为 "nacime-soul"；两种姿势产出
// 互不解密的两个加密上下文。在 "Electron" 身份下封存的 API key 换到
// "nacime-soul" 身份实例里全部解不开（用户视角："API key 又没了"）。
// 同一漂移还移动 userData/logs（M-36 日志目录漂移，同根因），且两种身份的
// singleInstanceLock 锁文件各自独立，曾允许双实例并发写同一数据目录。
// 钉死后两种启动姿势身份一致：加密上下文、userData、日志目录、单实例锁全部稳定。
// 打包版身份由 electron-builder productName（Nacime-soul）决定，不在此干预。
if (!app.isPackaged) {
  app.setName('nacime-soul')
}

let mainWindow: BrowserWindow | null = null
// P2-43：SessionStore 独立 WAL 连接，before-quit 显式关闭（Windows 文件锁）。
let sessionDb: ReturnType<typeof openMemoryDb> | null = null
// M-28：幂等账本防抖写盘的退出前 flush（避免最后一批记录因 quit 丢失）
let idempotencyLedgerRef: { flushNow(): void } | null = null
// memoryInfra 在 whenReady 内创建，before-quit 时清理（需提升到模块作用域）
let memoryInfra: {
  cleanup: () => void
  contextAssembler: PromptContextAssembler | null
  services: import('./memory/setup').MemoryServices | null
} = {
  cleanup: () => {},
  contextAssembler: null,
  services: null
}

// === 0. 单实例锁（审计 B-4）===
// 必须在 whenReady 之前：双开会让两个进程并发写同一个 memory.db / config.json /
// dmae-state.json，SQLite 与原子写都挡不住"两个 writer 各自持有内存状态"，
// 结果是记忆丢失或库损坏。第二实例直接退出并把焦点还给已有窗口。
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // 用户再次点击图标/命令行启动：聚焦已有窗口而不是开新的
    const existing = BrowserWindow.getAllWindows()[0]
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.show()
      existing.focus()
    }
  })
}

app.whenReady().then(async () => {
  // 未拿到单实例锁时 app.quit() 已调用，whenReady 仍可能触发一次，直接返回避免初始化
  if (!gotSingleInstanceLock) return

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

  // === 1b. MetricsRegistry + TurnTracer（P2-26/27 全局单例）===
  // F5-011 §5：metrics/tracer 单例，debug:get-snapshot 通过 getMetrics()/getTracer() 拉取
  configureMetrics(createMetrics())
  configureTracer(createTracer())
  // app.uptimeSec gauge 在 snapshot 时由 debug handler 算（uptimeSec 字段已含），不在这里设
  logger.info('application starting', {
    scope: 'main',
    tags: { version: app.getVersion(), platform: process.platform, arch: process.arch }
  })

  // === 2. ConfigStore + SecretStore ===
  // E2E 测试支持：COMPANION_USER_DATA 环境变量指定临时 userData 目录
  // M-16：配置/密钥 setup 包 try/catch——旧实现 setup() 抛错（如磁盘满/被锁、
  // M-15 的超前版本拒绝）会直接让 whenReady 链 reject，应用无窗口静默"僵尸进程"。
  const userDataPath = process.env['COMPANION_USER_DATA'] ?? app.getPath('userData')
  let configStore: ReturnType<typeof createConfigStore>
  let secretStore: ReturnType<typeof createSecretStore>
  try {
    configStore = createConfigStore({
      configPath: join(userDataPath, 'config.json'),
      logger: getLogger('config')
    })
    const configDiag = configStore.setup()
    logger.info('config loaded', {
      scope: 'main',
      tags: { status: configDiag.status, healed: String(configDiag.healed) }
    })

    secretStore = createSecretStore({
      secretsPath: join(userDataPath, 'secrets.json'),
      safeStorage,
      logger: getLogger('secret')
    })
    secretStore.setup()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    logger.fatal('config setup failed; refusing to start', {
      scope: 'main',
      code: isAppError(e) ? e.code : 'CFG_INVALID',
      detail: message
    })
    dialog.showErrorBox(
      '配置加载失败',
      `应用无法启动。\n\n原因: ${message}\n\n原配置文件已保留。请反馈此问题。`
    )
    app.exit(1)
    return
  }

  // === 2.5 迁移框架（F5-013：启动链第一个数据触碰者，在任何 memory Store 打开前）===
  // Phase 2 Batch A 已实现迁移框架代码，此处接线到启动流程。
  // 失败时拒绝启动（F5-013 §3 降级保护 + dry-run 失败恢复备份）。
  const dataDir = join(userDataPath, 'data')
  const dbPath = join(dataDir, 'memory.db')
  const migrationRunner = createMigrationRunner({
    dbPath,
    dataDir,
    migrations: MIGRATIONS,
    jsonStores: [
      { kind: 'l0', filePath: join(dataDir, 'l0-profile.json') },
      { kind: 'l1', filePath: join(dataDir, 'l1-state.json') },
      { kind: 'dmae', filePath: join(dataDir, 'dmae-state.json') }
    ],
    logger: getLogger('migrate'),
    appVersion: app.getVersion()
  })
  try {
    const migrationReport = await migrationRunner.run()
    logger.info('migrations applied', {
      scope: 'migrate',
      tags: {
        ok: String(migrationReport.ok),
        ran: migrationReport.ran.join(',') || 'none'
      },
      metrics: { durationMs: migrationReport.durationMs }
    })
    if (!migrationReport.ok) {
      // dry-run 失败或真跑失败（已恢复备份）：拒绝启动
      dialog.showErrorBox(
        '数据迁移失败',
        '应用无法启动，数据已恢复到迁移前状态。\n\n请反馈此问题，或从 data-backups/ 目录恢复。'
      )
      app.exit(1)
      return
    }
  } catch (e) {
    logger.fatal('migration failed; refusing to start', {
      scope: 'migrate',
      code: 'MEM_MIGRATE_FAIL',
      detail: e instanceof Error ? e.message : String(e)
    })
    dialog.showErrorBox(
      '数据迁移失败',
      `应用无法启动。\n\n原因: ${e instanceof Error ? e.message : String(e)}`
    )
    app.exit(1)
    return
  }

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

  // M-07：向 renderer 推送 app-error 事件（companion:event:app-error）。
  // 此前该通道在 main 侧无任何发射点，主进程内部错误永远到不了 UI。
  function sendAppError(error: PublicAppError): void {
    const wc = mainWindow?.webContents
    if (!wc || wc.isDestroyed()) return
    wc.send('companion:event:app-error', error)
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
      // 重建窗口后重新挂载 maximize/unmaximize 监听（修复前只挂初始窗口，重建后事件失效）
      attachWindowStateListeners(mainWindow)
      return mainWindow
    },
    showCrashDialog: (reason: string) => {
      dialog.showErrorBox(
        '应用遇到严重错误',
        `应用遇到不可恢复的错误，需要退出。\n\n原因: ${reason}\n\n请重新启动应用。`
      )
    },
    // M-07：main 内部错误（未处理 rejection 等）推送到 renderer 显示横幅
    onAppError: sendAppError
  })
  crashGuard.install()
  logger.info('crash guard installed', { scope: 'main' })

  // === 6. ChatService（providerFactory 注入 createSecureFetch - P1-09B Layer 2）===
  // __dirname 在 electron-vite 打包后始终为 out/main/（无论 E2E 还是打包后）。
  // resources/prompts/ 与 out/ 同级，所以向上两级。
  // 这与 create-chat-window.ts 用 __dirname 找 preload/renderer 同理。
  const promptsDir = join(__dirname, '../../resources/prompts')
  const promptLoader = createFilePromptLoader(promptsDir)
  // P2-43：SQLite SessionStore（接替内存实现，S-001 P1-24 遗留合同兑现）。
  // 构造时同步完成中断修复（streaming->failed），ChatService 接受请求前不见尸体轮次。
  // 独立 WAL 连接（与 memoryInfra 各自持连接；单写者 = main 进程）。
  sessionDb = openMemoryDb({ dbPath, logger: getLogger('memory') })
  const sessionStore = createSQLiteSessionStore({
    db: sessionDb,
    logger: getLogger('chat')
  })
  // P2-43：clientRequestId 跨重启幂等账本（缓存定性：损坏/缺失不拦启动）
  const idempotencyLedger = createIdempotencyLedger({
    filePath: join(dataDir, 'chat-idempotency.json'),
    logger: getLogger('chat')
  })
  idempotencyLedgerRef = idempotencyLedger

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
      // M-34：区分"没配过"与"存了但读不出（旧格式残留）"——指引文案不同
      const unreadable = secretStore.has('modelApiKey')
      throw new AppError({
        code: 'LLM_AUTH',
        userMessage: unreadable
          ? '已保存的 API Key 无法读取（可能是旧版本写入的格式），请在设置中重新输入并保存'
          : '未配置 API Key，请在设置中添加',
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

  // === 6.5 Memory 基础设施（Phase 2：P2-10~15 接线）===
  // 必须在 ChatService 之前创建：ChatService 需要 contextAssembler 接入动态 Prompt 层。
  // 创建全部 memory Store / Service / Hook 并注册 extraction hook 到 turn.end。
  // memory.enabled=false 时全旁路（setup 内部检查）。
  // memory.enabled=true 但无 API Key 时：embedding 走 pending 路径，extraction 不注册。
  // P2-29：getWebContents 闭包读取最新 mainWindow（CrashGuard 重建后仍能广播 memory-updated）
  // P2-36：seedsDir 与 promptsDir 同层（resources/ 下），__dirname 向上两级。
  // P2-41：growthMilestonesPath 同层（resources/growth/milestones.json）。
  memoryInfra = await setupMemoryInfrastructure({
    dbPath,
    dataDir,
    seedsDir: join(__dirname, '../../resources/seeds'),
    growthMilestonesPath: join(__dirname, '../../resources/growth/milestones.json'),
    configStore,
    secretStore,
    sessionStore,
    logger: getLogger('memory'),
    isDev: is.dev,
    getWebContents: () => mainWindow?.webContents ?? null
  })

  // === 6.6 ChatService（providerFactory 注入 createSecureFetch - P1-09B Layer 2）===
  // P2-18: 动态 Prompt 接线（S-011 §1.6）
  // getMemoryConfig 返回当前 memory 配置；memory.enabled=true 但 dynamicPrompt 缺失时
  // ChatService 会抛 CFG_INVALID（S-011 §1.2 合同）
  const chatService = createChatService({
    logger: getLogger('chat'),
    promptLoader,
    sessionStore,
    providerFactory,
    getMemoryConfig: () => configStore.get().memory,
    idempotencyLedger,
    ...(memoryInfra.contextAssembler
      ? { dynamicPrompt: { contextAssembler: memoryInfra.contextAssembler } }
      : {})
  })

  // === 7. IPC handler 注册 ===
  registerAppHandlers({ logger: getLogger('app') })
  registerConfigHandlers({
    configStore,
    secretStore,
    logger: getLogger('config'),
    // P1-09B Layer 2：测试连接与正式聊天走同一套 secureFetch（审计 B-1）。
    // 每次调用时读当前 config.security，反映运行时配置变更。
    createTestFetch: () =>
      createSecureFetch(
        {
          isDev: is.dev,
          allowHttpLocalhostInDev: configStore.get().security.allowHttpLocalhostInDev
        },
        getLogger('network')
      )
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
  // P2-29: memory + growth IPC handler（12 invoke）
  // memory.enabled=false 时 services=null，handler 返回 disabled 信封
  registerMemoryHandlers({
    logger: getLogger('memory-ipc'),
    services: memoryInfra.services,
    getMemoryConfig: () => configStore.get().memory
  })
  registerGrowthHandlers({
    logger: getLogger('growth-ipc'),
    getMemoryConfig: () => configStore.get().memory,
    services: memoryInfra.services
  })
  // P2-32: DMAE 面板 handler（5 invoke）。dmae.enabled=false 时 diagnostics=null
  registerDmaeHandlers({
    logger: getLogger('dmae-ipc'),
    diagnostics: memoryInfra.services?.dmaeDiagnostics ?? null,
    getMemoryConfig: () => configStore.get().memory,
    // M-26：mute-anomaly 写异常静音配置
    configStore
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
      // macOS 关窗重开（activate）后同样需要重新挂载状态监听
      attachWindowStateListeners(mainWindow)
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// app 退出前清理记忆基础设施（关闭 DB、停止队列消费者、terminate worker）
app.on('before-quit', () => {
  memoryInfra.cleanup()
  idempotencyLedgerRef?.flushNow() // M-28：防抖写盘的最后一批落盘
  if (sessionDb?.open) sessionDb.close()
  sessionDb = null
})
