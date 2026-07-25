// E2E 测试辅助函数：临时 userData 目录管理 + 预写配置

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

/** Phase 1 默认配置（与 defaults.ts 一致） */
const DEFAULT_CONFIG = {
  schemaVersion: 1,
  model: {
    provider: 'deepseek',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-v4-flash',
    displayName: 'DeepSeek',
    temperature: 0.8,
    topP: 0.95,
    maxTokens: 2048,
    timeoutMs: 60_000,
    reasoningEffort: 'off',
    compatOverrides: {}
  },
  tts: {
    enabled: false,
    provider: 'edge',
    voiceId: '',
    speed: 1,
    pitch: 0,
    volume: 1,
    sampleRate: 24000,
    cacheEnabled: true,
    earlyPlaybackEnabled: false
  },
  memory: {
    enabled: false,
    embeddingProvider: '',
    embeddingModel: '',
    embeddingDimension: 1024,
    maxActive: 15,
    minRetrievalScore: 0.35,
    dmae: {
      enabled: true,
      maxScore: 100,
      promptThreshold: 30,
      userRewardBase: 20,
      wakeGamma: 0.5,
      modelRewardBase: 8,
      wakeLambda: 0.3,
      decayAlpha: 1.5,
      decayBeta: 0.3
    }
  },
  ui: {
    locale: 'zh-CN',
    theme: 'system',
    fontScale: 1,
    reduceMotion: false,
    window: { width: 900, height: 720, maximized: false },
    chat: { sendOnEnter: true, showTimestamps: false },
    live2d: { enabled: false, zoom: 1, alwaysOnTop: true }
  },
  security: {
    allowHttpLocalhostInDev: true,
    diagnostics: { logLevel: 'info', retentionDays: 7, maxTotalMb: 50 },
    privacy: { includeCrashDumpsInExport: false, monthlyGcDigest: false }
  }
}

/** 创建临时 userData 目录 */
export function createTmpUserData(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nacime-e2e-'))
}

/** 预写 config.json（让应用跳过默认值生成，直接用指定配置） */
export function writeDefaultConfig(dir: string): void {
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(DEFAULT_CONFIG, null, 2))
}

/** 预写 secrets.json（用 plain: 前缀的 API Key，让 hasApiKey=true） */
export function writeFakeApiKey(dir: string): void {
  fs.writeFileSync(
    path.join(dir, 'secrets.json'),
    JSON.stringify({
      schemaVersion: 1,
      xorKey: 'dGVzdA==',
      modelApiKey: 'plain:sk-test-key-for-e2e'
    })
  )
}

/** 清理临时目录 */
export function cleanupTmpDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

/**
 * 创建 Electron 启动环境变量。
 * 删除 ELECTRON_RUN_AS_NODE（Claude Code 等工具预设此变量，会导致 Electron 以 Node 模式运行不启动 GUI）。
 */
export function createElectronEnv(overrides: Record<string, string>): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  return { ...env, ...overrides }
}
