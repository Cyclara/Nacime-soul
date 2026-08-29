// E2E 测试辅助函数：临时 userData 目录管理 + 预写配置 + 进程树收尾

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { execFileSync } from 'node:child_process'
import type { ElectronApplication } from '@playwright/test'

/** Phase 1 默认配置（与 defaults.ts 一致） */
export const E2E_DEFAULT_CONFIG = {
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
      decayBeta: 0.3,
      presets: [],
      anomaly: {
        muted: {
          R01: 0,
          R02: 0,
          R03: 0,
          R04: 0,
          R05: 0,
          R06: 0,
          R07: 0,
          R08: 0,
          R09: 0,
          R10: 0,
          R11: 0,
          R12: 0,
          R13: 0
        },
        windows: {
          R01: { days: 3 },
          R02: { days: 7 },
          R03: { days: 3 },
          R04: { turns: 50 },
          R05: { turns: 100 },
          R06: {},
          R07: { turns: 50 },
          R08: { turns: 200 },
          R09: { days: 3 },
          R10: { days: 3, turns: 100 },
          R11: { days: 7 },
          R12: {},
          R13: {}
        }
      },
      historySampleEveryTurns: 1
    }
  },
  ui: {
    locale: 'zh-CN',
    theme: 'light',
    fontScale: 1,
    reduceMotion: false,
    // S-014 之后引导阶段由 config 驱动：不显式声明就会被 healing 成 provider-setup，
    // 有 Key 但历史为空的 E2E 会停在「第一次见面」而不是聊天输入框。这些用例演的是
    // 老用户，所以固定为 complete；首次引导链路由 onboarding 专项用例覆盖。
    onboarding: { version: 1, stage: 'complete' },
    window: { width: 900, height: 720, maximized: false },
    chat: { sendOnEnter: true, showTimestamps: false, showReasoning: true },
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
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(E2E_DEFAULT_CONFIG, null, 2))
}

/**
 * 预写 memory.enabled=true 的配置（E-01/E-02 记忆 E2E 用）。
 * embedding 保持未配置（无真实 API）——L2 走 pending 路径，L0/L2 列表/详情不受影响。
 */
export function writeMemoryConfig(dir: string): void {
  const cfg = {
    ...E2E_DEFAULT_CONFIG,
    memory: { ...E2E_DEFAULT_CONFIG.memory, enabled: true }
  }
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2))
}

/**
 * E-01/E-02 脚本化提取 envelope：只在临时 E2E userData 中使用。
 * 选用明显虚构的测试称呼/爱好，避免测试窗口被误认为写入真实用户资料。
 */
export const E2E_TEST_NAME = '星河测试员'
export const E2E_TEST_PREFERENCE = '伙伴喜欢收集虚构的蓝色月票'
export const FAUX_EXTRACTION_ENVELOPE = JSON.stringify({
  schemaVersion: 1,
  candidates: [
    {
      targetLayer: 'l0',
      field: 'preferredName',
      content: E2E_TEST_NAME,
      confidence: 0.95,
      certainty: 'explicit',
      attribution: 'user_explicit',
      evidence: [{ messageId: 'current-user', role: 'user', quote: `请叫我${E2E_TEST_NAME}` }],
      forbiddenOverclaims: []
    },
    {
      targetLayer: 'l2',
      content: E2E_TEST_PREFERENCE,
      confidence: 0.85,
      certainty: 'explicit',
      attribution: 'user_explicit',
      evidence: [{ messageId: 'current-user', role: 'user', quote: '我喜欢收集虚构的蓝色月票' }],
      memoryType: 'stable',
      importance: 'medium',
      forbiddenOverclaims: []
    }
  ]
})

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

/**
 * 关闭被测 Electron 应用。
 *
 * 不能直接用 `ElectronApplication.close()`：Windows 上隐藏的 GPU 子进程会持有 CDP 管道，
 * close() 可能一直挂到用例超时，再连累同 worker 的其他用例判 teardown timeout——通过的
 * 用例也会被标红。这里直接杀进程树，再给系统一点时间释放 userData 里的 SQLite/WAL 句柄。
 */
export async function shutdownApp(app: ElectronApplication): Promise<void> {
  try {
    execFileSync('taskkill', ['/PID', String(app.process().pid), '/T', '/F'])
  } catch {
    await app.process().kill()
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 300))
}

/** 清理临时目录 */
export function cleanupTmpDir(dir: string): void {
  // Electron 子进程在 Windows 上会短暂持有 userData 的 SQLite/WAL 句柄；kill 后重试，
  // 避免清理竞态把已通过的 E2E 误判失败。
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
}

/**
 * 创建 Electron 启动环境变量。
 * 删除 ELECTRON_RUN_AS_NODE（Claude Code 等工具预设此变量，会导致 Electron 以 Node 模式运行不启动 GUI）。
 * 过滤掉值为 undefined 的项并返回 Record<string,string>——process.env 的 `string | undefined`
 * 值类型与 spawn 的 env 参数（{[key:string]:string}）不兼容（M-19 测试类型检查暴露）。
 */
export function createElectronEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  delete env.ELECTRON_RUN_AS_NODE
  return { ...env, ...overrides }
}
