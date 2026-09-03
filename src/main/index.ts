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

import {
  app,
  BrowserWindow,
  safeStorage,
  dialog,
  protocol,
  screen,
  session,
  type WebContents
} from 'electron'
import { existsSync, mkdirSync, statfsSync } from 'node:fs'
import { delimiter, join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import log from 'electron-log/main'

// 安全
import {
  installGlobalAgentGuard,
  createSecureFetch,
  createLocalServiceOriginRegistry
} from './security/network-policy'

// 可观测性
import { configureLogger, getLogger, createElectronLogSink } from './observability/logger'
import { createErrorBuffer } from './observability/error-buffer'
import { createCrashGuard } from './observability/crash-guard'
import { installStreamErrorTolerance } from './observability/stream-error-tolerance'
import { createMetrics, configureMetrics, getMetrics } from './observability/metrics'
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
import { searchMessages as searchChatMessages } from './chat/search'
import { createIdempotencyLedger } from './chat/idempotency-ledger'
import { openMemoryDb } from './memory/db'

// 合规（P3C1-07 用户反馈 + P3C1-08 基础设施接线：gate/审计/持久化/快照）
import { createComplianceFeedbackService } from './compliance/feedback'
import { setupCompliance, type ComplianceInfrastructure } from './compliance/setup'

// Memory 基础设施（Phase 2：P2-10~15 接线）
import { setupMemoryInfrastructure } from './memory/setup'
import type { PromptContextAssembler } from './prompts/context-assembler'

// 窗口
import { createChatWindow } from './windows/create-chat-window'
import { createLive2dWindow } from './windows/create-live2d-window'
import { Live2dWindowManager } from './windows/live2d-window-manager'
import { trackWindowState, type WindowState } from './windows/window-state'
import { createLive2dModelRegistry } from './live2d/model-registry'
import { createLive2dModelService } from './live2d/model-service'
import { registerLive2dAssetProtocol, LIVE2D_ASSET_SCHEME } from './live2d/asset-protocol'
import {
  CUBISM_CORE_FILE_NAME,
  createCubism2Url,
  createCubismCoreUrl
} from './live2d/cubism-runtime'
import {
  evaluateLive2dPerformance,
  failedLive2dPerformanceChecks
} from '@shared/live2d/performance'
import { createLive2dEmotionHook } from './live2d/emotion-hook'

// 迁移（F5-013：启动链第一个数据触碰者）
import { createMigrationRunner } from './migrations/runner'
import { MIGRATIONS } from './migrations/registry'

// IPC
import { configureIpcGuard, sendEvent, type IpcSenderCapability } from './ipc/register'
import { registerAppHandlers } from './ipc/handlers/app'
import { registerWindowHandlers, attachWindowStateListeners } from './ipc/handlers/window'
import { registerConfigHandlers } from './ipc/handlers/config'
import { registerChatHandlers } from './ipc/handlers/chat'
import { createChatRenderAckTracker } from './voice/playback/ack-gate'
import {
  createMessageChannelStagePort,
  createPlaybackHostManager
} from './voice/playback/stage-host-manager'
import { registerDebugHandlers } from './ipc/handlers/debug'
import { registerMemoryHandlers } from './ipc/handlers/memory'
import { registerGrowthHandlers } from './ipc/handlers/growth'
import { registerDmaeHandlers } from './ipc/handlers/dmae'
import { registerVoiceHandlers } from './ipc/handlers/voice'
import { createAssetRootService } from './voice/asset-root-service'
import { createModelDownloader, createTarExtractor } from './voice/asr/model-downloader'
import { asrEngineDirName } from './voice/asr/download-catalog'
import { totalAsrDownloadBytes } from '@shared/voice/asr-catalog'
import { createAsrEngineManager } from './voice/asr/engine-manager'
import { createNodeSherpaBinding } from './voice/asr/sherpa-binding'
import { createNodeSileroVadBinding } from './voice/vad/silero-binding'
import { createVadProcessor } from './voice/vad/vad-processor'
import { createVoiceListeningService } from './voice/listening-service'
import { createTtsRegistry, type TtsRegistry } from './voice/tts/registry'
import {
  createEdgeTtsProviderFactory,
  EDGE_TTS_CAPABILITIES,
  EDGE_TTS_PROVIDER_ID
} from './voice/tts/edge-provider'
import { runEdgeSapiSynthesis } from './voice/tts/edge-sapi-runner'
import {
  createGptSovitsProviderFactory,
  GPT_SOVITS_CAPABILITIES,
  GPT_SOVITS_PROVIDER_ID
} from './voice/tts/gpt-sovits-provider'
import { createGptSovitsService, type GptSovitsService } from './voice/tts/gpt-sovits-service'
import { createGptRuntimeManager } from './voice/tts/gpt-runtime-manager'
import { createGptRuntimeSourceService } from './voice/tts/gpt-runtime-source'
import { createVoiceProfileRegistry } from './voice/tts/voice-profile-registry'
import { GPT_RUNTIME_INSTALL_DIR_NAME } from './voice/tts/gpt-runtime-catalog'
import { createGpuNameProbe } from './voice/tts/gpu-info'
import { createVoiceOrchestrator, type VoiceOrchestrator } from './voice/orchestrator'
import type { VoiceEvent, VoiceTtsProviderOption } from '@shared/voice/voice-events'
import type { AssetDownloadStatus } from '@shared/voice/asset-root-types'
import type { GptVoiceFileKind } from '@shared/voice/gpt-runtime-types'
import { registerComplianceHandlers } from './ipc/handlers/compliance'
import { registerLive2dStageHandlers } from './ipc/handlers/live2d-stage'
import { registerLive2dHandlers } from './ipc/handlers/live2d'
import { createLive2dModelImporter } from './live2d/model-import'
import { createLive2dPublicState } from './live2d/public-state'
import { createOnboardingResolver } from './onboarding/resolver'
import { createNacimeTray } from './tray/create-tray'

// M-50：自动更新（updater 状态机；enabled 门控打包环境，dev/E2E 不加载 electron-updater）
import { createUpdater } from './updater'

// 应用启动时间（CrashGuard 的 uptime 计算需要，在一切初始化前捕获）
const appStartTime = Date.now()

// P3A-11：必须在 app.whenReady() 前注册为标准/安全 scheme，才能让 stage 的 XHR/纹理
// 请求保持同源语义；实际 file handler 在模型注册表就绪后才绑定 defaultSession。
protocol.registerSchemesAsPrivileged([
  {
    scheme: LIVE2D_ASSET_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true
    }
  }
])

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

// M-35（2026-08-21）：stdout/stderr 写入失败容忍（详见 stream-error-tolerance.ts 头注）。
// 必须在任何日志写入之前安装：dev/管道启动时终端可合法消失（如 `electron . | head -30`
// 收满即退），EPIPE 不应升级成 uncaughtException 让整应用陪葬。
// 首次吞掉时用 log.warn 在文件日志留一句——console transport 走 Node console
// （ignoreErrors 不同步抛错），断管后的异步 'error' 事件已被上面的监听吞掉，
// 文件 transport 不经 stdout 正常落盘，不会打转转；留痕失败也哑火。
installStreamErrorTolerance([process.stdout, process.stderr], (errorCode) => {
  try {
    log.warn(`stdout/stderr write failed (${errorCode}); console output muted, file log continues`)
  } catch {
    /* 留痕失败同样哑火 */
  }
})

let mainWindow: BrowserWindow | null = null
let appIsQuitting = false
// P3A-04：独立 stage 生命周期；不复用 chat CrashGuard，也不把 Pixi 状态塞进 chat window。
let live2dWindowManagerRef: Live2dWindowManager | null = null
// P3B-15：stage PlaybackHost 的 main 侧（TTS 专用 audio port）；before-quit 先于窗口关。
let stagePlaybackHostRef: ReturnType<typeof createPlaybackHostManager> | null = null
// P3B-18：VoiceOrchestrator + TTS registry（before-quit 先停声再 disposeAll provider）。
let voiceOrchestratorRef: VoiceOrchestrator | null = null
let asrEngineManagerRef: ReturnType<typeof createAsrEngineManager> | null = null
let ttsRegistryRef: TtsRegistry | null = null
let gptSovitsServiceRef: GptSovitsService | null = null
let gptSovitsConfigCleanupRef: (() => void) | null = null

let live2dConfigCleanupRef: (() => void) | null = null
let trayRef: { destroy(): void } | null = null
// P2-43：SessionStore 独立 WAL 连接，before-quit 显式关闭（Windows 文件锁）。
let sessionDb: ReturnType<typeof openMemoryDb> | null = null
// M-28：幂等账本防抖写盘的退出前 flush（避免最后一批记录因 quit 丢失）
let idempotencyLedgerRef: { flushNow(): void } | null = null
/**
 * 取聊天窗口的 webContents；窗口不存在或已销毁时返回 null。
 *
 * 必须先 `isDestroyed()` 再读 `.webContents`：BrowserWindow 销毁之后**读取该属性本身**就抛
 * `TypeError: Object has been destroyed`，`?.` 只挡 `null`，挡不住这个。抛出的代价是 main 收到
 * uncaughtException → CrashGuard 弹同步模态框 → 事件循环阻塞、连它自己排的退出定时器都执行
 * 不了，关窗直接变成卡死（2026-08-29 实测复现，栈顶正是 `emitLive2dState`）。
 * `Live2dWindowManager` 早已按同一教训改用建窗时记下的 id；聊天侧这几处是同类漏网。
 */
function chatWebContents(): WebContents | null {
  const window = mainWindow
  if (window === null || window.isDestroyed()) return null
  const contents = window.webContents
  return contents.isDestroyed() ? null : contents
}

/**
 * 聊天窗口是应用的所有者窗口：它退场时，透明 stage 窗口不能独自留在桌面上。
 *
 * Live2D 关闭时，关掉聊天窗口会触发 `window-all-closed` → `app.quit()`；开启时 stage 窗口还在，
 * `window-all-closed` 便永远不会触发，于是桌面上留下一个没有主人的透明窗口——而托盘的
 * 「打开 Nacime」在 mainWindow 已销毁时是 no-op，聊天再也回不来。S-Phase3 §1.9 完成定义第 1 条
 * 明确禁止这种孤儿窗口。让 stage 随最后一个聊天窗口一起退场，既恢复 Live2D 出现之前的行为，
 * 也让「关窗即退出」不再取决于一个渲染开关。
 *
 * 只在**没有存活的聊天窗口**时动手：CrashGuard 重建窗口后 `mainWindow` 指向新窗口，此时旧的
 * 崩溃窗口若被关闭，不能连累 stage（完成定义第 1 条同时点名了「关闭/重建」两种情形）。
 */
function attachChatWindowOwnership(window: BrowserWindow): void {
  window.on('closed', () => {
    const current = mainWindow
    const chatStillAlive = current !== null && current !== window && !current.isDestroyed()
    if (chatStillAlive) return
    live2dWindowManagerRef?.destroy()
  })
}

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

  /**
   * P3A-05：所有可信窗口重建单一 capability map。
   * chat 除 stage-only 通道外可调用既有 API；stage 只可 ready/report-state。窗口关闭必须
   * 删除对应 ID，因此 renderer/HMR 不会继承前一实例权限。
   */
  const senderCapabilities = new Map<number, IpcSenderCapability>()
  function refreshIpcGuard(): void {
    configureIpcGuard(
      {
        trustedOrigins,
        trustedWebContentsIds: new Set(senderCapabilities.keys()),
        senderCapabilities
      },
      getLogger('ipc')
    )
  }

  function registerSenderCapability(webContentsId: number, capability: IpcSenderCapability): void {
    senderCapabilities.set(webContentsId, capability)
    refreshIpcGuard()
  }

  function unregisterSenderCapability(webContentsId: number): void {
    senderCapabilities.delete(webContentsId)
    refreshIpcGuard()
  }

  /** 为 chat window 配置 chat capability（初始创建与 CrashGuard 重建同样调用）。 */
  function setupWindowIpcGuard(win: BrowserWindow): void {
    // `closed` 触发时 BrowserWindow 已销毁，此刻再读 `win.webContents` 会抛
    // "Object has been destroyed"。这一抛的代价有三层：① main 收到 uncaughtException，
    // CrashGuard 弹阻塞式错误框，关窗变成卡死；② 同一事件上**排在后面的监听器全部不再执行**；
    // ③ capability 没删干净，销毁窗口的 webContents id 继续留在 chat 白名单里（P3A-05 要求
    // 「窗口销毁即移除 ID 与能力」）。因此和 Live2dWindowManager 一样，建窗时就把 id 记下来。
    const webContentsId = win.webContents.id
    registerSenderCapability(webContentsId, 'chat')
    win.once('closed', () => unregisterSenderCapability(webContentsId))
  }

  // S-005 §3.7 落地：窗口尺寸/位置持久化（schema/默认值早已就位，此前只建不存）。
  // resize/move/maximize 走防抖写（configStore 内置 250ms 节流合并），close 立即写。
  // 写失败（校验不过/磁盘满）只记日志——窗口状态是顺手度数据，不值得炸启动链。
  function persistWindowState(state: WindowState, immediate: boolean): void {
    configStore.update({ ui: { window: state } }, { immediate }).catch((e: unknown) => {
      getLogger('window').warn('window state persist failed', {
        scope: 'window',
        detail: e instanceof Error ? e.message : String(e)
      })
    })
  }

  /** 创建主窗口并还原上次的尺寸/位置/最大化（崩溃重建与 activate 重开同样走这里） */
  function createMainWindow(): BrowserWindow {
    const win = createChatWindow({ windowState: configStore.get().ui.window })
    trackWindowState(win, persistWindowState)
    return win
  }

  // P3A-08/11：registry 放 userData/data（用户导入模型），内置模型和许可随 app resources。
  // 打包 out/main/index.js 的资源根与开发源码根同为 __dirname 向上两级。
  const bundledLive2dRoot = join(__dirname, '../../resources/live2d')
  const userLive2dRoot = join(dataDir, 'live2d/models')
  mkdirSync(userLive2dRoot, { recursive: true })
  const live2dRegistry = createLive2dModelRegistry({
    registryPath: join(dataDir, 'live2d/registry.json'),
    builtinModelsRoot: join(bundledLive2dRoot, 'models'),
    userModelsRoot: userLive2dRoot
  })
  const live2dModelService = createLive2dModelService({
    builtinModelsRoot: join(bundledLive2dRoot, 'models'),
    licenseDirectory: join(bundledLive2dRoot, 'licenses'),
    registry: live2dRegistry
  })
  const live2dImporter = createLive2dModelImporter({
    userModelsRoot: userLive2dRoot,
    registry: live2dRegistry
  })
  let emitLive2dState: () => void = () => {}
  const live2dPublicState = createLive2dPublicState({
    listModels: () => live2dModelService.list(),
    selectedModelId: () => {
      const configured = configStore.get().ui.live2d.selectedModelId
      return configured !== undefined && live2dModelService.getRegistered(configured) !== null
        ? configured
        : live2dModelService.selectedModelId()
    },
    loadedModelId: () => live2dWindowManagerRef?.getSnapshot().loadedModelId ?? null,
    window: () =>
      live2dWindowManagerRef?.getSnapshot() ?? {
        stageInstanceId: null,
        status: 'closed',
        visible: false,
        alwaysOnTop: true,
        webContentsId: null,
        loadedModelId: null,
        audioOnly: false
      },
    loading: () => false,
    lastError: () => null,
    zoom: () => configStore.get().ui.live2d.zoom,
    offset: () => ({
      x: configStore.get().ui.live2d.offsetX,
      y: configStore.get().ui.live2d.offsetY
    })
  })
  emitLive2dState = (): void => {
    const wc = chatWebContents()
    if (wc === null) return
    sendEvent(wc, 'companion:event:live2d-state', live2dPublicState.bump())
  }
  const bundledCorePath = join(bundledLive2dRoot, 'cubism', CUBISM_CORE_FILE_NAME)
  registerLive2dAssetProtocol(session.defaultSession, {
    service: live2dModelService,
    cubismCorePath: bundledCorePath,
    cubism2Path: join(bundledLive2dRoot, 'cubism', 'live2d.min.js')
  })
  const builtinSetup = live2dModelService.initializeBuiltins()
  const configuredLive2dModelId = configStore.get().ui.live2d.selectedModelId
  if (
    configuredLive2dModelId !== undefined &&
    live2dRegistry.get(configuredLive2dModelId) !== null
  ) {
    live2dRegistry.select(configuredLive2dModelId)
  } else if (configuredLive2dModelId === undefined && live2dRegistry.getSelected() !== null) {
    // Additive config key: persist the chosen default once, with undefined placeholder already
    // present in defaults so legacy config files cannot silently lose it.
    void configStore.update({
      ui: { live2d: { selectedModelId: live2dRegistry.getSelected()!.id } }
    })
  }
  if (builtinSetup.errors.length > 0) {
    getLogger('live2d').warn('some built-in Live2D models were unavailable', {
      scope: 'live2d',
      metrics: { unavailableModels: builtinSetup.errors.length }
    })
  }

  // P3B-15（F5-007 §1.14）：唯一 PlaybackHost = Live2D stage renderer。main 建
  // MessageChannelMain 专用 port 转交 stage（普通 invoke/event 不承载 PCM）；
  // 每次 stage ready 生成新 generation；stage 销毁/崩溃 -> current 作废 ->
  // 播放侧 host-unavailable（当前轮 text-only），直到下一 stage ready 重建。
  const stagePlaybackHost = createPlaybackHostManager({
    logger: getLogger('tts'),
    createStageChannel: (webContents, generation) =>
      createMessageChannelStagePort(webContents, generation)
  })
  stagePlaybackHostRef = stagePlaybackHost

  // === 5.5 P3V-10：大资源根目录（可自选其他盘）===
  // 默认根 Windows 放 %LOCALAPPDATA%（Roaming 同步不该背 GB 级模型），其余平台
  // userData；偏好持久化在 main 私有 asset-root.json（renderer 拿不到路径）；旧版
  // data/models/asr 一次性迁入。setup 必须先于语音栈（ASR 与 GPT runtime 都用它）：
  // 引擎/下载器的 rootDir 本会话内固定，换根重启生效。
  const assetRootDefault =
    process.platform === 'win32' && typeof process.env['LOCALAPPDATA'] === 'string'
      ? join(process.env['LOCALAPPDATA'], app.getName(), 'assets')
      : join(userDataPath, 'assets')
  const assetRoot = createAssetRootService({
    prefPath: join(userDataPath, 'asset-root.json'),
    defaultRoot: assetRootDefault,
    legacyAsrRoot: join(dataDir, 'models/asr'),
    // P3V-03：当前 ASR 主/备 + 必需 VAD 总下载量；算法来自 shared catalog 单真源。
    // P3V-16/20 接 GPT runtime/音色选择时在这里 additive 相加。
    getTotalRequiredBytes: () => {
      const voice = configStore.get().voice
      const primary = voice.asrPrimaryEngineId ?? voice.asrEngineId
      const fallback = voice.asrFallbackEngineId === '' ? null : voice.asrFallbackEngineId
      return totalAsrDownloadBytes(fallback === null ? [primary] : [primary, fallback])
    }
  })
  await assetRoot.setup()

  // === P3B-18：TTS Registry + VoiceOrchestrator（组合根） ===
  // Edge = dev/test 占位音色（Windows SAPI 本地合成）；packaged-production 由 Registry
  // 资格门拒绝 → 该轮纯文字（裁定二：绝不降级通用音色）。
  const ttsRegistry = createTtsRegistry(getLogger('tts'))
  ttsRegistryRef = ttsRegistry
  ttsRegistry.register({
    id: EDGE_TTS_PROVIDER_ID,
    capabilities: EDGE_TTS_CAPABILITIES,
    factory: createEdgeTtsProviderFactory({
      logger: getLogger('tts'),
      synthesizeToWav: runEdgeSapiSynthesis
    })
  })

  // GPT-SoVITS：只读发现用户现有整合包。P3V-17 起来源有三层优先级——用户指定目录 >
  // Nacime 一键安装 > 环境变量/常见目录扫描（见 gpt-runtime-source）。外部目录绝不改；
  // Nacime 自有 launcher 负责等 api_v2 端口真正 ready 后打印握手。
  // renderer 只见 provider/voice id 与显示名，权重/参考音频绝对路径留在 main。
  const gptRuntimeSource = createGptRuntimeSourceService({
    prefPath: join(userDataPath, 'gpt-runtime-source.json'),
    nacimeInstallRoot: () => join(assetRoot.gptRuntimeRoot(), GPT_RUNTIME_INSTALL_DIR_NAME)
  })
  // 本会话定格：运行中的 api_v2 子进程与已注册 provider 不热切换，改选择重启后生效
  const gptInstallation = gptRuntimeSource.resolveInstallation()
  // P3V-18：多音色注册表 = 安装 custom 配置里的那一个 + 用户导入的若干个。
  // 不做 checkpoint 笛卡尔积；权重/参考音频路径只留在这里。
  const voiceProfiles = createVoiceProfileRegistry({
    storePath: join(userDataPath, 'gpt-voice-profiles.json'),
    installation: () => gptInstallation
  })
  let gptSovitsService: GptSovitsService | null = null
  if (gptInstallation !== null) {
    getLogger('tts').info('local GPT-SoVITS installation discovered', {
      scope: 'tts',
      tags: { provider: GPT_SOVITS_PROVIDER_ID, version: gptInstallation.version },
      metrics: { voices: voiceProfiles.list().length }
    })
    // 外部 Python 不能读取 app.asar 虚拟路径：安装版由 electron-builder extraResources
    // 把 Nacime 自有 launcher/词典复制成 process.resourcesPath/voice 下的真实文件。
    const bundledVoiceRoot = app.isPackaged
      ? join(process.resourcesPath, 'voice')
      : join(__dirname, '../../resources/voice')
    const launcherPath = join(bundledVoiceRoot, 'gpt-sovits-launcher.py')
    if (existsSync(launcherPath)) {
      const localOrigins = createLocalServiceOriginRegistry()
      const gptFetch = createSecureFetch(
        {
          isDev: is.dev,
          allowHttpLocalhostInDev: false,
          localServiceOrigins: localOrigins
        },
        getLogger('network')
      )
      gptSovitsService = createGptSovitsService(
        {
          command: gptInstallation.pythonPath,
          buildArgs: (port) => [
            '-I',
            launcherPath,
            '--api-script',
            gptInstallation.apiScriptPath,
            '--config',
            gptInstallation.ttsConfigPath,
            '--port',
            String(port),
            '--root',
            gptInstallation.rootDir,
            '--jieba-resources',
            join(bundledVoiceRoot, 'jieba-fast')
          ],
          cwd: gptInstallation.rootDir,
          env: {
            ...process.env,
            PATH: `${join(gptInstallation.rootDir, 'runtime')}${delimiter}${process.env['PATH'] ?? ''}`
          },
          handshakeTimeoutMs: 5 * 60_000,
          healthIntervalMs: 15_000,
          healthTimeoutMs: 5_000,
          maxConsecutiveStartFailures: 2,
          maxRestartsInWindow: 3,
          restartWindowMs: 10 * 60_000,
          healthFailureThreshold: 2,
          restartBackoffBaseMs: 2_000,
          restartBackoffMaxMs: 30_000
        },
        {
          logger: getLogger('tts'),
          originRegistry: localOrigins,
          fetch: (url, init) => gptFetch(url, init)
        }
      )
      gptSovitsServiceRef = gptSovitsService
      ttsRegistry.register({
        id: GPT_SOVITS_PROVIDER_ID,
        capabilities: GPT_SOVITS_CAPABILITIES,
        factory: createGptSovitsProviderFactory({
          logger: getLogger('tts'),
          service: gptSovitsService,
          fetch: (url, init) => gptFetch(url, init),
          // P3V-18：多音色——按 id 到注册表取（未知 id 返回 null → voice-missing 纯文字）
          resolveVoice: (voiceId) => voiceProfiles.resolveVoiceConfig(voiceId),
          requestTimeoutMs: 120_000,
          maxResponseBytes: 64 * 1024 * 1024
        })
      })

      const warmGptIfSelected = (): void => {
        const tts = configStore.get().tts
        if (!tts.enabled || tts.provider !== GPT_SOVITS_PROVIDER_ID) return
        if (gptSovitsService?.state() === 'failed') gptSovitsService.reset()
        void gptSovitsService?.ensureReady().catch(() => {
          /* service 自己记录有界失败；当前/下一轮按 provider-unhealthy 纯文字 */
        })
      }
      warmGptIfSelected()
      gptSovitsConfigCleanupRef = configStore.subscribe((event) => {
        if (event.domain === 'tts') warmGptIfSelected()
      })
    }
  }

  const emitVoiceEvent = (event: VoiceEvent): void => {
    const wc = chatWebContents()
    if (wc !== null) sendEvent(wc, 'companion:event:voice-state', event)
  }
  const gptProviderPublicState = (): VoiceTtsProviderOption['state'] => {
    const serviceState = gptSovitsService?.state()
    switch (serviceState) {
      case 'starting':
      case 'running':
      case 'failed':
        return serviceState
      case 'idle':
        return 'available'
      case 'stopped':
      case undefined:
        return 'failed'
    }
  }
  const chatRenderAckTracker = createChatRenderAckTracker()
  const voiceOrchestrator = createVoiceOrchestrator({
    logger: getLogger('tts'),
    registry: ttsRegistry,
    hostManager: stagePlaybackHost,
    ackGate: chatRenderAckTracker.gate,
    getTtsConfig: () => configStore.get().tts,
    runtime: () => (app.isPackaged ? 'packaged-production' : 'dev'),
    emitEvent: emitVoiceEvent,
    listProviderOptions: () => [
      ...(!app.isPackaged
        ? [
            {
              id: EDGE_TTS_PROVIDER_ID,
              displayName: '系统语音（开发占位）',
              state: 'available' as const,
              devTestOnly: true
            }
          ]
        : []),
      ...(gptInstallation !== null && gptSovitsService !== null
        ? [
            {
              id: GPT_SOVITS_PROVIDER_ID,
              displayName: 'GPT-SoVITS（本地定制音色）',
              state: gptProviderPublicState(),
              devTestOnly: false
            }
          ]
        : [])
    ],
    // P3V-18：设置页音色下拉 = 注册表全量（仅 id/显示名；缺文件的标注在显示名里，
    // 详细状态走 GPT runtime 面板的 voices 投影）
    listVoiceOptions: () =>
      gptInstallation === null
        ? []
        : voiceProfiles.list().map((profile) => ({
            id: profile.id,
            providerId: GPT_SOVITS_PROVIDER_ID,
            displayName: profile.displayName
          })),
    metrics: getMetrics()
  })
  voiceOrchestratorRef = voiceOrchestrator
  const live2dWindowManager = new Live2dWindowManager({
    createWindow: createLive2dWindow,
    onStageCreated: (webContentsId) => registerSenderCapability(webContentsId, 'live2d-stage'),
    onStageDestroyed: (webContentsId) => {
      unregisterSenderCapability(webContentsId)
      stagePlaybackHost.detachStage(webContentsId)
    },
    onStageReady: (webContents) => stagePlaybackHost.attachStage(webContents),
    getModelLoadPlan: () => live2dModelService.getLoadPlan(),
    getStageModelUrl: (modelId) => live2dModelService.getStageModelUrl(modelId),
    getModelExpressionNames: (modelId) =>
      live2dModelService.getRegistered(modelId)?.manifest.expressionNames ?? [],
    getLoadAttemptUrl: (attemptIndex) => live2dModelService.getLoadAttemptUrl(attemptIndex),
    getCubismCoreUrl: () => createCubismCoreUrl(join(bundledLive2dRoot, 'cubism')),
    getCubism2Url: () => createCubism2Url(join(bundledLive2dRoot, 'cubism')),
    getZoom: () => configStore.get().ui.live2d.zoom,
    getOffset: () => ({
      x: configStore.get().ui.live2d.offsetX,
      y: configStore.get().ui.live2d.offsetY
    }),
    getDisplayWorkArea: (bounds) => screen.getDisplayMatching(bounds).workArea,
    onPerformanceReport: (sender, report) => {
      const metrics = getMetrics()
      if (report.fps !== undefined) metrics.gauge('live2d.fps').set(report.fps)
      if (report.modelLoadMs !== undefined) {
        metrics.histogram('live2d.modelLoadMs').observe(report.modelLoadMs)
        metrics.histogram('live2d.firstFrameMs').observe(report.modelLoadMs)
      }
      // Electron 官方 ProcessMetric：workingSetSize 是 KiB，percentCPUUsage 是两次采样间的百分比。
      const pid = sender.getOSProcessId()
      const processMetric = app.getAppMetrics().find((metric) => metric.pid === pid)
      const renderMemoryMb =
        processMetric?.memory?.workingSetSize === undefined
          ? null
          : processMetric.memory.workingSetSize / 1024
      const idleCpuPercent = processMetric?.cpu?.percentCPUUsage ?? null
      if (renderMemoryMb !== null) metrics.gauge('live2d.renderMemoryMb').set(renderMemoryMb)
      if (idleCpuPercent !== null) metrics.gauge('live2d.idleCpuPercent').set(idleCpuPercent)

      // P3A-28：采集不等于有门。超预算时落一条只含数字的 warn，否则回归只能靠人盯 gauge。
      const breached = failedLive2dPerformanceChecks(
        evaluateLive2dPerformance({
          fps: report.fps ?? 0,
          idleCpuPercent,
          renderMemoryMb,
          firstFrameMs: report.modelLoadMs ?? null,
          visible: live2dWindowManager.getSnapshot().visible,
          modelsLoadedThisSession: live2dWindowManager.getModelsLoadedThisSession()
        })
      )
      if (breached.length > 0) {
        getLogger('live2d').warn('Live2D performance budget exceeded', {
          scope: 'live2d',
          tags: { checks: breached.join(',') },
          metrics: {
            fps: report.fps ?? 0,
            ...(renderMemoryMb === null ? {} : { renderMemoryMb: Math.round(renderMemoryMb) }),
            ...(idleCpuPercent === null ? {} : { idleCpuPercent: Math.round(idleCpuPercent) }),
            ...(report.modelLoadMs === undefined ? {} : { firstFrameMs: report.modelLoadMs })
          }
        })
      }
    },
    onStateChange: emitLive2dState
  })
  live2dWindowManagerRef = live2dWindowManager
  emitLive2dState()
  const unsubscribeLive2dConfig = configStore.subscribe((event) => {
    // P3B-15：ui.live2d 与 tts 都影响 stage 运行模式（可见 vs audio-only hidden）
    if (event.domain !== 'ui' && event.domain !== 'tts') return
    const live2dConfig = configStore.get().ui.live2d
    const ttsConfig = configStore.get().tts
    live2dWindowManager.setAlwaysOnTop(live2dConfig.alwaysOnTop)
    live2dWindowManager.setZoom(live2dConfig.zoom)
    live2dWindowManager.setOffset(live2dConfig.offsetX, live2dConfig.offsetY)
    if (live2dConfig.enabled) {
      // 开启 Live2D：销毁 audio-only 宿主（可见 stage 的创建仍是启动路径 P3A 现状）
      if (live2dWindowManager.getSnapshot().audioOnly) live2dWindowManager.destroy()
    } else {
      // Live2D 关闭：纯文字模式不需要 stage；TTS 开则需要隐藏的声音宿主
      if (ttsConfig.enabled) live2dWindowManager.ensureAudioOnlyStage()
      else live2dWindowManager.destroy()
    }
    emitLive2dState()
  })
  live2dConfigCleanupRef = unsubscribeLive2dConfig

  // M-07：向 renderer 推送 app-error 事件（companion:event:app-error）。
  // 此前该通道在 main 侧无任何发射点，主进程内部错误永远到不了 UI。
  function sendAppError(error: PublicAppError): void {
    const wc = chatWebContents()
    if (wc === null) return
    sendEvent(wc, 'companion:event:app-error', error)
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
      mainWindow = createMainWindow()
      setupWindowIpcGuard(mainWindow)
      // 重建窗口后重新挂载 maximize/unmaximize 监听（修复前只挂初始窗口，重建后事件失效）
      attachWindowStateListeners(mainWindow)
      attachChatWindowOwnership(mainWindow)
      return mainWindow
    },
    isQuitting: () => appIsQuitting,
    shouldHandleRendererCrash: (webContents) => chatWebContents()?.id === webContents.id,
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
  // P3A-29：首次体验状态由 main 在 SessionStore 初始化后解析；不能让 renderer 以空 session
  // 猜老用户。只有真实 completed turn 才代表已有用户。
  const onboardingResolution = createOnboardingResolver().resolve({
    hasApiKey: secretStore.hasReadable('modelApiKey'),
    persisted: configStore.get().ui.onboarding,
    history: sessionStore
  })
  if (onboardingResolution.persisted) {
    await configStore.update({ ui: { onboarding: { stage: onboardingResolution.stage } } })
  }
  // P2-44：全文搜索直接绑 sessionDb（handler 依赖注入用；const 捕获保持非空类型收窄）
  const chatSearchDb = sessionDb
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
    getWebContents: () => chatWebContents()
  })

  // === 6.55 合规基础设施（P3C1-08：F5-001 C1 观测接线）===
  // setupCompliance 是统一 composition root：编译规则 + 熔断器 + persistence +
  // ChatService 集成对象（gate 工厂）+ 独立审计 provider + turn.end 审计 hook（350）。
  // 必须真实调用（F5-001 §5 反模式「测试绿但根本没启用采集」）。
  // L0 键名来自 memory infra（memory.enabled=false 时无 L0，空列表降级）。
  const complianceInfra = setupCompliance({
    db: sessionDb,
    configStore,
    secretStore,
    sessionStore,
    promptLoader,
    logger: getLogger('compliance'),
    metrics: getMetrics(),
    isDev: is.dev,
    getKnownFactKeys: () =>
      memoryInfra.services ? Object.keys(memoryInfra.services.l0Store.get().fields) : []
  })
  complianceInfraRef = complianceInfra

  // S-006-补充 §1.7.4：最终可见回复 → 语义情绪 → stage。本地启发式分类，不进流循环、
  // 不改一个字节、不发网络请求，因此与 C1「observe 下 releaseText 逐字节等于 delta」正交。
  // priority 370 排在审计(350)之后：表情是最外层表现，永不抢在记忆/DMAE/审计之前。
  registerHook(
    createLive2dEmotionHook({
      logger: getLogger('live2d'),
      sessionStore,
      setEmotion: (emotion) => live2dWindowManager.setEmotion(emotion),
      isStageLive: () => live2dWindowManager.getSnapshot().status !== 'closed'
    })
  )

  // P3C1-07：合规用户反馈服务（F5-001 §3.7）。三表与 SessionStore 同库（迁移 009）。
  // onDislike 补审回调在此接线（P3C1-08）：dislike -> 审计队列 reason='dislike' 强制补审；
  // 无审计轨道（无 API key）时回调内部跳过，反馈落库 + 计数不受影响。
  const complianceFeedback = createComplianceFeedbackService({
    db: sessionDb,
    sessionStore,
    logger: getLogger('compliance'),
    metrics: getMetrics(),
    onDislike: complianceInfra.onDislike
  })

  // === 6.6 ChatService（providerFactory 注入 createSecureFetch - P1-09B Layer 2）===
  // P2-18: 动态 Prompt 接线（S-021 §1.6）
  // getMemoryConfig 返回当前 memory 配置；memory.enabled=true 但 dynamicPrompt 缺失时
  // ChatService 会抛 CFG_INVALID（S-021 §1.2 合同）
  const chatService = createChatService({
    logger: getLogger('chat'),
    promptLoader,
    sessionStore,
    providerFactory,
    getMemoryConfig: () => configStore.get().memory,
    idempotencyLedger,
    // P3C1-08：合规观测集成（gate 工厂 + TURN_END 落库；未注入时全旁路）
    compliance: complianceInfra.chatIntegration,
    // P3B-18（F5-007 §1.5）：EarlyTTS hook——releaseText 流驱动语音合成与播放
    voice: voiceOrchestrator,
    ...(memoryInfra.contextAssembler
      ? { dynamicPrompt: { contextAssembler: memoryInfra.contextAssembler } }
      : {})
  })

  // === 7. IPC handler 注册 ===
  // M-50：updater 先于 handler 创建（getWebContents 闭包读最新 mainWindow，CrashGuard 重建安全）；
  // start() 推迟到窗口创建之后（步骤 8 末尾），dev/E2E 下 enabled=false 不调度不加载。
  const updater = createUpdater({
    logger: getLogger('updater'),
    getWebContents: () => chatWebContents(),
    enabled: app.isPackaged && !is.dev
  })
  updaterRef = updater
  registerAppHandlers({ logger: getLogger('app'), updater })
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
  // P3B-15A（F5-007 §1.5）：chat paint ack 跟踪器已在 P3B-18 组合点提前创建
  // （orchestrator 的播放队列消费 gate；handler 喂 ack）。
  registerChatHandlers({
    chatService,
    logger: getLogger('chat'),
    searchMessages: (query, limit) => searchChatMessages(chatSearchDb, query, limit),
    // P3C1-07：合规用户反馈（F5-001 §3.7）。onDislike 补审已在
    // 6.55 接线（dislike -> 审计队列 reason='dislike' 强制补审，P3C1-08）。
    recordFeedback: complianceFeedback.recordFeedback,
    ackTracker: chatRenderAckTracker
  })
  // P3A-23：Live2D chat 管理面（main 负责 dialog/ID/URL，renderer 只见 DTO）。
  registerLive2dHandlers({
    logger: getLogger('live2d'),
    getMainWindow: () => mainWindow,
    service: live2dModelService,
    importer: live2dImporter,
    manager: live2dWindowManager,
    getSnapshot: live2dPublicState.snapshot,
    setSelectedModel: async (modelId) => {
      const previousModelId = live2dModelService.selectedModelId()
      if (!live2dModelService.setSelectedModelId(modelId)) return false
      try {
        await configStore.update({ ui: { live2d: { selectedModelId: modelId } } })
        return true
      } catch {
        live2dModelService.setSelectedModelId(previousModelId)
        return false
      }
    },
    getAlwaysOnTop: () => configStore.get().ui.live2d.alwaysOnTop,
    setEnabled: async (enabled) => {
      try {
        await configStore.update({ ui: { live2d: { enabled } } } as Parameters<
          typeof configStore.update
        >[0])
        return true
      } catch {
        return false
      }
    },
    onStateChange: emitLive2dState
  })
  // P3C1-08：合规调试快照（F5-001 §3.10：仅调试面板，聚合量无正文，无 event 通道）
  registerComplianceHandlers({
    logger: getLogger('compliance'),
    getSnapshot: complianceInfra.getSnapshot
  })
  // P3A-05：这两个 handler 必须在 stage 窗口可能加载 live2d.html 前注册。
  registerLive2dStageHandlers({
    logger: getLogger('live2d'),
    manager: live2dWindowManager
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

  // === 7.x P3B-14：语音设置/语音输入（ASR 引擎管理 + 模型下载 + 测试录音）===
  // 模型根 {assetRoot}/asr；下载走 secureFetch（https 公网 + 重定向复验）；
  // tar 解压用系统 bsdtar；语音永不外发（审计裁定 3，localOnly 由共享类型冻结）。
  const asrModelRoot = assetRoot.asrRoot()
  const vadBinding = createNodeSileroVadBinding()
  const modelDownloader = createModelDownloader({
    rootDir: asrModelRoot,
    fetchImpl: createSecureFetch(
      {
        isDev: is.dev,
        allowHttpLocalhostInDev: configStore.get().security.allowHttpLocalhostInDev
      },
      getLogger('network')
    ),
    extractArchive: createTarExtractor(getLogger('voice')),
    engineDirName: asrEngineDirName,
    // 注入 downloader 时 manager 不会替它补 onStateChange；生产必须在这里桥接，
    // 否则进度只在 main 内变化，renderer 的 asr-model-state 永远不刷新。
    onStateChange: () => emitAsrOverview()
  })
  const asrEngineManager = createAsrEngineManager({
    rootDir: asrModelRoot,
    binding: createNodeSherpaBinding(),
    vadBinding,
    // P3V-09：主引擎读 asrPrimaryEngineId（新写法）；旧配置无此键时由兼容键
    // asrEngineId 迁移（旧值原样成为主引擎）。写路径双键同写保持一致。
    getSelectedEngineId: () => {
      const voice = configStore.get().voice
      return voice.asrPrimaryEngineId ?? voice.asrEngineId
    },
    setSelectedEngineId: async (engineId) => {
      try {
        await configStore.update({
          voice: { asrPrimaryEngineId: engineId, asrEngineId: engineId }
        })
        return true
      } catch {
        return false
      }
    },
    // P3V-09：备用引擎。持久层空串=未设备用（null 会被 deepMerge 顶回默认值，
    // 「清除备用」会静默失效——见 shared/config/types.ts VoiceConfig 注释）。
    getFallbackEngineId: () => {
      const value = configStore.get().voice.asrFallbackEngineId
      return value === '' ? null : value
    },
    setFallbackEngineId: async (engineId) => {
      try {
        await configStore.update({ voice: { asrFallbackEngineId: engineId ?? '' } })
        return true
      } catch {
        return false
      }
    },
    downloader: modelDownloader,
    onOverviewChange: () => emitAsrOverview()
  })
  asrEngineManagerRef = asrEngineManager
  const emitAsrOverview = (): void => {
    const wc = chatWebContents()
    if (wc !== null) {
      sendEvent(wc, 'companion:event:asr-model-state', asrEngineManager.getOverview())
    }
  }
  const voiceListening = createVoiceListeningService({
    engineManager: asrEngineManager,
    createVadProcessor: (modelPath) =>
      createVadProcessor({ recognizer: vadBinding.createVad({ modelPath }) }),
    emitEvent: emitVoiceEvent,
    metrics: getMetrics(),
    // P3B-19：用户开口（VAD speech_start）打断当前 TTS/早播（barge-in）
    onSpeechStart: () => {
      voiceOrchestrator.onBargeIn()
    }
  })
  // P3V-16：GPT-SoVITS 官方整合包一键安装。安装根 {assetRoot}/gpt-runtime/gpt-sovits，
  // 暂存与安装同分区（原子 rename 事务的前提）；镜像/哈希/路径全留在 main。
  // 空间按**本会话活跃根**实测（status() 是用户当前选择，换根待重启时两者可能不同）。
  const gptRuntimeManager = createGptRuntimeManager({
    assetRootDir: () => assetRoot.gptRuntimeRoot(),
    fetchImpl: createSecureFetch(
      { isDev: is.dev, allowHttpLocalhostInDev: false },
      getLogger('network')
    ),
    freeBytes: () => {
      try {
        const info = statfsSync(assetRoot.root())
        return Number(info.bavail) * Number(info.bsize)
      } catch {
        return null // 查不到按不足处理（宁可拒绝，也不开一个必然半途失败的 8GB 下载）
      }
    },
    // 生产必须桥接，否则进度只在 main 内变化，renderer 的下载中心永远不刷新
    onStateChange: (variant) => emitAssetDownload(gptRuntimeManager.status(variant)),
    gpuName: createGpuNameProbe()
  })
  // P3V-20：导入音色的暂存槽（会话内存；路径绝不出 main）
  const stagedVoiceFiles: Record<GptVoiceFileKind, string | null> = {
    'gpt-weights': null,
    'sovits-weights': null,
    'ref-audio': null
  }
  const emitAssetDownload = (status: AssetDownloadStatus): void => {
    const wc = chatWebContents()
    if (wc !== null) sendEvent(wc, 'companion:event:asset-download', status)
  }
  registerVoiceHandlers({
    logger: getLogger('voice-ipc'),
    engineManager: asrEngineManager,
    listening: voiceListening,
    orchestrator: voiceOrchestrator,
    emitAsrOverview,
    assetRoot,
    gptRuntime: gptRuntimeManager,
    // 只读发现结果：告诉用户「本机已有一份」，Nacime 不接管也不修改外部目录
    gptRuntimeExternalDetected: () => gptInstallation !== null,
    gptRuntimeSource,
    voiceProfiles,
    // P3V-18：当前音色唯一真源仍是 config（空 = 未选 → 纯文字）
    currentVoiceId: () => configStore.get().tts.voiceId,
    // P3V-20：导入音色的三个文件——路径只在本回调与暂存槽里，renderer 只见文件名
    pickVoiceFile: async (kind) => {
      const filters =
        kind === 'ref-audio'
          ? [{ name: '参考音频', extensions: ['wav', 'mp3', 'flac', 'm4a', 'ogg'] }]
          : kind === 'gpt-weights'
            ? [{ name: 'GPT 权重', extensions: ['ckpt'] }]
            : [{ name: 'SoVITS 权重', extensions: ['pth'] }]
      const picked = await dialog.showOpenDialog({
        title:
          kind === 'ref-audio'
            ? '选择参考音频（几秒清晰人声）'
            : kind === 'gpt-weights'
              ? '选择 GPT 权重（.ckpt）'
              : '选择 SoVITS 权重（.pth）',
        properties: ['openFile', 'dontAddToRecent'],
        filters
      })
      if (picked.canceled || picked.filePaths.length === 0) return null
      const path = picked.filePaths[0]!
      stagedVoiceFiles[kind] = path
      return path
    },
    stagedVoiceFiles: () => stagedVoiceFiles,
    clearStagedVoiceFiles: () => {
      stagedVoiceFiles['gpt-weights'] = null
      stagedVoiceFiles['sovits-weights'] = null
      stagedVoiceFiles['ref-audio'] = null
    },
    // P3V-17：选中的目录只在这里与 source service 内出现，不回传 renderer
    chooseGptRuntimeDirectory: async () => {
      const picked = await dialog.showOpenDialog({
        title: '选择已有的 GPT-SoVITS 整合包目录',
        properties: ['openDirectory', 'dontAddToRecent']
      })
      return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths[0]!
    },
    // P3V-10：原生目录选择只在此回调里接触真实路径；返回给 renderer 的只有
    // isDefault/freeBytes/state（asset-root-types 路径纪律）。
    chooseAssetDirectory: async () => {
      const picked = await dialog.showOpenDialog({
        title: '选择语音资源存放位置',
        properties: ['openDirectory', 'dontAddToRecent']
      })
      return picked.canceled || picked.filePaths.length === 0 ? null : picked.filePaths[0]!
    }
  })

  // === 8. 窗口创建 ===
  // appId 与 electron-builder.yml 保持一致（S-005 §3.11 占位值，发布前由用户确认替换）
  electronApp.setAppUserModelId('com.nacime-soul.app')
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  mainWindow = createMainWindow()
  setupWindowIpcGuard(mainWindow)
  attachChatWindowOwnership(mainWindow)
  // Playwright faux mode verifies the main/stage boundary and needs app.close() to own process teardown;
  // tray semantics are covered by the dedicated main-process unit test instead.
  if (process.env['COMPANION_TEST_MODE'] !== 'faux') {
    trayRef = createNacimeTray({
      assetsDirectory: join(__dirname, '../../assets'),
      showMainWindow: () => {
        const window = mainWindow
        if (window === null || window.isDestroyed()) return
        if (window.isMinimized()) window.restore()
        window.show()
        window.focus()
      }
    })
  }
  if (configStore.get().ui.live2d.enabled) {
    live2dWindowManager.show({ alwaysOnTop: configStore.get().ui.live2d.alwaysOnTop })
  } else if (configStore.get().tts.enabled) {
    // P3B-15（F5-007 §1.14 / C23）：TTS 开而 Live2D 关 -> audio-only-hidden stage，
    // 只跑 PlaybackHost 播声音，不建 Pixi/模型、窗口从不显示。
    live2dWindowManager.ensureAudioOnlyStage()
  }

  // window handler 需要 getMainWindow（窗口可能被 CrashGuard 重建）
  registerWindowHandlers({
    getMainWindow: () => mainWindow,
    logger: getLogger('window')
  })

  // M-50：窗口就绪后启动更新检查调度（首次延迟 10s，之后每 4h；仅打包环境）
  updater.start()

  logger.info('application ready', { scope: 'main' })

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
      setupWindowIpcGuard(mainWindow)
      // macOS 关窗重开（activate）后同样需要重新挂载状态监听
      attachWindowStateListeners(mainWindow)
      attachChatWindowOwnership(mainWindow)
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// M-50：updater 引用提升到模块作用域，before-quit 清理定时器
let updaterRef: { dispose(): void } | null = null
// P3C1-08：合规基础设施引用（before-quit 停审计消费者）
let complianceInfraRef: ComplianceInfrastructure | null = null

// app 退出前清理记忆基础设施（关闭 DB、停止队列消费者、terminate worker）
app.on('before-quit', () => {
  appIsQuitting = true
  updaterRef?.dispose()
  trayRef?.destroy()
  trayRef = null
  live2dConfigCleanupRef?.()
  live2dConfigCleanupRef = null
  gptSovitsConfigCleanupRef?.()
  gptSovitsConfigCleanupRef = null
  // P3B-15：stage audio port 先于窗口销毁（关 port -> stage 收 close 收尾）
  stagePlaybackHostRef?.dispose()
  stagePlaybackHostRef = null
  // P3B-18：先停当前说话（stage 同步停声），再 cancel+dispose 所有存活 provider
  voiceOrchestratorRef?.dispose()
  voiceOrchestratorRef = null
  // P3V-07：显式关闭所有 OnlineStream/OnlineRecognizer，不能只等 napi GC。
  asrEngineManagerRef?.dispose()
  asrEngineManagerRef = null
  void ttsRegistryRef?.disposeAll('app-quit')
  ttsRegistryRef = null
  // GPT-SoVITS 外部整合包由 Nacime launcher 启动；退出必须树杀，不留 Python/GPU 孤儿。
  void gptSovitsServiceRef?.shutdown()
  gptSovitsServiceRef = null
  live2dWindowManagerRef?.destroy()
  live2dWindowManagerRef = null
  complianceInfraRef?.cleanup() // P3C1-08：停审计消费者（中止 in-flight，结果不再投递）
  memoryInfra.cleanup()
  idempotencyLedgerRef?.flushNow() // M-28：防抖写盘的最后一批落盘
  if (sessionDb?.open) sessionDb.close()
  sessionDb = null
})
