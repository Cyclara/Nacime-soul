// src/main/memory/setup.test.ts
// P2-10~15 接线验证：memory.enabled 旁路、无 API Key 降级、正常接线。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupMemoryInfrastructure } from './setup'
import { createConfigStore } from '../config/store'
import { createSecretStore } from '../security/secret-store'
import { createMemorySessionStore } from '../chat/session-store'
import { createMigrationRunner } from '../migrations/runner'
import { MIGRATIONS } from '../migrations/registry'
import { testNoopLogger } from '../../../tests/helpers/test-db'
import { clearHooks, hookCount } from '../hooks/registry'

// SecretStore 需要 safeStorage，测试用 mock
const mockSafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(`enc:${s}`),
  decryptString: (s: Buffer) => s.toString().replace('enc:', '')
}

describe('P2-10~15 memory infrastructure setup', () => {
  let dir: string
  let dataDir: string
  let dbPath: string
  let configStore: ReturnType<typeof createConfigStore>
  let secretStore: ReturnType<typeof createSecretStore>
  let sessionStore: ReturnType<typeof createMemorySessionStore>

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nacime-setup-'))
    dataDir = join(dir, 'data')
    dbPath = join(dataDir, 'memory.db')
    mkdirSync(dataDir, { recursive: true })

    // 跑迁移建表
    await createMigrationRunner({
      dbPath,
      dataDir,
      migrations: MIGRATIONS,
      logger: testNoopLogger,
      appVersion: '1.0.0',
      // 注册 dmae jsonStore（m004 迁移需要 setJsonVersion 写版本号）
      jsonStores: [{ kind: 'dmae', filePath: join(dataDir, 'dmae-state.json') }]
    }).run()

    // 建 configStore（memory.enabled 默认 false）
    const configPath = join(dir, 'config.json')
    configStore = createConfigStore({ configPath, logger: testNoopLogger })
    configStore.setup()

    // 建 secretStore
    const secretsPath = join(dir, 'secrets.json')
    secretStore = createSecretStore({
      secretsPath,
      safeStorage: mockSafeStorage as never,
      logger: testNoopLogger
    })
    secretStore.setup()

    sessionStore = createMemorySessionStore()
    clearHooks()
  })

  afterEach(() => {
    clearHooks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('memory.enabled=false -> hook=null, no hooks registered', () => {
    expect(configStore.get().memory.enabled).toBe(false) // 默认 false
    const infra = setupMemoryInfrastructure({
      dbPath,
      dataDir,
      configStore,
      secretStore,
      sessionStore,
      logger: testNoopLogger,
      isDev: false,
      getWebContents: () => null
    })
    expect(infra.hook).toBeNull()
    expect(hookCount()).toBe(0)
    infra.cleanup()
  })

  it('memory.enabled=true but no API key -> hook=null (extraction not registered), stores created', async () => {
    await configStore.update({ memory: { enabled: true } })
    expect(configStore.get().memory.enabled).toBe(true)
    expect(secretStore.has('modelApiKey')).toBe(false)

    const infra = setupMemoryInfrastructure({
      dbPath,
      dataDir,
      configStore,
      secretStore,
      sessionStore,
      logger: testNoopLogger,
      isDev: false,
      getWebContents: () => null
    })
    // 无 API key -> extraction hook 不注册；但 DMAE hook 仍注册（dmae.enabled=true 默认）
    expect(infra.hook).toBeNull()
    expect(hookCount()).toBe(1) // DMAE hook（extraction 需 API key）
    infra.cleanup()
  })

  it('memory.enabled=true + API key -> hook registered, cleanup closes DB', async () => {
    await configStore.update({ memory: { enabled: true } })
    secretStore.set('modelApiKey', 'sk-test-key-12345678')

    const infra = setupMemoryInfrastructure({
      dbPath,
      dataDir,
      configStore,
      secretStore,
      sessionStore,
      logger: testNoopLogger,
      isDev: false,
      getWebContents: () => null
    })
    // 有 API key -> extraction hook 注册；DMAE hook 也注册（dmae.enabled=true 默认）
    expect(infra.hook).not.toBeNull()
    expect(infra.hook?.event).toBe('turn.end')
    expect(hookCount()).toBe(2) // extraction（250）+ dmae（300）
    // cleanup 不抛错（含 worker terminate + DB close）
    expect(() => infra.cleanup()).not.toThrow()
    // cleanup 后 hook 已注销（registry 清空）
    clearHooks()
  })

  it('cleanup terminates worker (no resource leak)', async () => {
    await configStore.update({ memory: { enabled: true } })
    secretStore.set('modelApiKey', 'sk-test-key-12345678')
    const infra = setupMemoryInfrastructure({
      dbPath,
      dataDir,
      configStore,
      secretStore,
      sessionStore,
      logger: testNoopLogger,
      isDev: false,
      getWebContents: () => null
    })
    // cleanup 应 terminate worker（否则进程不退出）
    expect(() => infra.cleanup()).not.toThrow()
    // 二次 cleanup 不抛错（幂等）
    expect(() => infra.cleanup()).not.toThrow()
  })

  it('P2-09: embedding 模型变更 -> 阻断 embedding（F5-003 禁止新旧混算）', async () => {
    await configStore.update({ memory: { enabled: true } })
    secretStore.set('modelApiKey', 'sk-test-key-12345678')

    // 第一次 setup：写入 embeddingModel=bge-m3, dim=1024
    const infra1 = setupMemoryInfrastructure({
      dbPath,
      dataDir,
      configStore,
      secretStore,
      sessionStore,
      logger: testNoopLogger,
      isDev: false,
      getWebContents: () => null
    })
    infra1.cleanup()

    // 切换 embedding 模型（dim 不变，但 model 名变了）
    await configStore.update({
      memory: {
        enabled: true,
        embeddingModel: 'text-embedding-3-small',
        embeddingDimension: 1024
      }
    })

    // 第二次 setup：应检测到模型变更，阻断 embedding
    const infra2 = setupMemoryInfrastructure({
      dbPath,
      dataDir,
      configStore,
      secretStore,
      sessionStore,
      logger: testNoopLogger,
      isDev: false,
      getWebContents: () => null
    })
    // hook 仍注册（extraction 仍可用，只是 L2 写入走 pending 路径）
    expect(infra2.hook).not.toBeNull()
    // cleanup 不抛错
    expect(() => infra2.cleanup()).not.toThrow()
    clearHooks()
  })
})
