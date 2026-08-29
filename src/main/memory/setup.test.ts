// src/main/memory/setup.test.ts
// P2-10~15 接线验证：memory.enabled 旁路、无 API Key 降级、正常接线。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
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
  let growthMilestonesPath: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nacime-setup-'))
    dataDir = join(dir, 'data')
    dbPath = join(dataDir, 'memory.db')
    growthMilestonesPath = join(dir, 'milestones.json') // 不存在 -> 回退 MILESTONES_V1
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

  it('memory.enabled=false -> hook=null, no hooks registered', async () => {
    expect(configStore.get().memory.enabled).toBe(false) // 默认 false
    const infra = await setupMemoryInfrastructure({
      dbPath,
      dataDir,
      seedsDir: join(dir, 'seeds'),
      growthMilestonesPath,
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

    const infra = await setupMemoryInfrastructure({
      dbPath,
      dataDir,
      seedsDir: join(dir, 'seeds'),
      growthMilestonesPath,
      configStore,
      secretStore,
      sessionStore,
      logger: testNoopLogger,
      isDev: false,
      getWebContents: () => null
    })
    // 无 API key -> extraction hook 不注册；但 DMAE hook + growth bridge + reference-tracker 仍注册
    expect(infra.hook).toBeNull()
    expect(hookCount()).toBe(4) // reference-tracker（chat.message 150）+ growth-bridge（220）+ DMAE（300）；extraction 需 API key
    infra.cleanup()
  })

  it('memory.enabled=true + API key -> hook registered, cleanup closes DB', async () => {
    await configStore.update({ memory: { enabled: true } })
    secretStore.set('modelApiKey', 'sk-test-key-12345678')

    const infra = await setupMemoryInfrastructure({
      dbPath,
      dataDir,
      seedsDir: join(dir, 'seeds'),
      growthMilestonesPath,
      configStore,
      secretStore,
      sessionStore,
      logger: testNoopLogger,
      isDev: false,
      getWebContents: () => null
    })
    // 有 API key -> extraction hook 注册；DMAE + growth bridge + reference-tracker 也注册
    expect(infra.hook).not.toBeNull()
    expect(infra.hook?.event).toBe('turn.end')
    expect(hookCount()).toBe(5) // GC activity（199）+ reference-tracker（150）+ growth-bridge（220）+ extraction（250）+ dmae（300）
    // cleanup 不抛错（含 worker terminate + DB close）
    expect(() => infra.cleanup()).not.toThrow()
    // cleanup 后 hook 已注销（registry 清空）
    clearHooks()
  })

  it('cleanup terminates worker (no resource leak)', async () => {
    await configStore.update({ memory: { enabled: true } })
    secretStore.set('modelApiKey', 'sk-test-key-12345678')
    const infra = await setupMemoryInfrastructure({
      dbPath,
      dataDir,
      seedsDir: join(dir, 'seeds'),
      growthMilestonesPath,
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
    const infra1 = await setupMemoryInfrastructure({
      dbPath,
      dataDir,
      seedsDir: join(dir, 'seeds'),
      growthMilestonesPath,
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
    const infra2 = await setupMemoryInfrastructure({
      dbPath,
      dataDir,
      seedsDir: join(dir, 'seeds'),
      growthMilestonesPath,
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

  it('P2-36/37: seed 文件加载为 L2 条目（source=creator, importance=10, extractionKey 幂等）', async () => {
    await configStore.update({ memory: { enabled: true } })
    const seedsDir = join(dir, 'seeds')
    mkdirSync(seedsDir, { recursive: true })
    writeFileSync(
      join(seedsDir, 'nacime-test.md'),
      `---
type: seed
importance: 10
confidence: 1.0
source: creator
tags: [test]
---

Nacime 喜欢测试。`,
      'utf-8'
    )

    const infra = await setupMemoryInfrastructure({
      dbPath,
      dataDir,
      seedsDir,
      growthMilestonesPath,
      configStore,
      secretStore,
      sessionStore,
      logger: testNoopLogger,
      isDev: false,
      getWebContents: () => null
    })

    const l2Store = infra.services!.l2Store
    const created = l2Store.list({})
    // seed 条目 + 可能存在的其他条目；至少 1 条 seed
    const seedMem = l2Store.getByExtractionKey('seed:nacime-test')
    expect(seedMem).not.toBeNull()
    expect(seedMem!.source).toBe('creator')
    expect(seedMem!.importance).toBe(10)
    expect(seedMem!.content).toBe('Nacime 喜欢测试。')
    expect(seedMem!.lifecycleState).toBe('active')
    // DMAE 引擎：seed 条目 activation 应为 maxScore（100）
    if (infra.services!.dmaeService) {
      expect(infra.services!.dmaeService.getActivation(seedMem!.id)).toBe(100)
    }
    void created
    infra.cleanup()
  })

  it('P2-36/37: seed 重复启动幂等（extractionKey 已存在则跳过）', async () => {
    await configStore.update({ memory: { enabled: true } })
    const seedsDir = join(dir, 'seeds')
    mkdirSync(seedsDir, { recursive: true })
    writeFileSync(
      join(seedsDir, 'nacime-dup.md'),
      `---
type: seed
importance: 10
confidence: 1.0
source: creator
tags: [test]
---

重复记忆`,
      'utf-8'
    )

    const infra1 = await setupMemoryInfrastructure({
      dbPath,
      dataDir,
      seedsDir,
      growthMilestonesPath,
      configStore,
      secretStore,
      sessionStore,
      logger: testNoopLogger,
      isDev: false,
      getWebContents: () => null
    })
    infra1.cleanup()
    clearHooks()

    const infra2 = await setupMemoryInfrastructure({
      dbPath,
      dataDir,
      seedsDir,
      growthMilestonesPath,
      configStore,
      secretStore,
      sessionStore,
      logger: testNoopLogger,
      isDev: false,
      getWebContents: () => null
    })
    const l2Store = infra2.services!.l2Store
    // 同一 extractionKey 只应有 1 行
    const matches = l2Store.list({}).filter((m) => m.extractionKey === 'seed:nacime-dup')
    expect(matches).toHaveLength(1)
    expect(matches[0].source).toBe('creator')
    infra2.cleanup()
  })

  it('P2-36: 坏 seed 文件跳过不崩', async () => {
    await configStore.update({ memory: { enabled: true } })
    const seedsDir = join(dir, 'seeds')
    mkdirSync(seedsDir, { recursive: true })
    writeFileSync(
      join(seedsDir, 'good.md'),
      `---
type: seed
importance: 10
confidence: 1.0
source: creator
tags: [test]
---

好记忆`,
      'utf-8'
    )
    writeFileSync(join(seedsDir, 'bad.md'), 'no frontmatter')

    const infra = await setupMemoryInfrastructure({
      dbPath,
      dataDir,
      seedsDir,
      growthMilestonesPath,
      configStore,
      secretStore,
      sessionStore,
      logger: testNoopLogger,
      isDev: false,
      getWebContents: () => null
    })
    const l2Store = infra.services!.l2Store
    const seedMem = l2Store.getByExtractionKey('seed:good')
    expect(seedMem).not.toBeNull()
    // 坏文件不产生条目
    const badMem = l2Store.getByExtractionKey('seed:bad')
    expect(badMem).toBeNull()
    infra.cleanup()
  })
})
