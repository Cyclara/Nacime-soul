// src/main/security/secret-store.test.ts
// P1-08 验收测试：SecretStore
// 依据：S-005 §1、§3.6.1、S-001 P1-08 验收标准

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import { createSecretStore, xorEncrypt, type SafeStorageLike } from './secret-store'
import type { Logger, LogFields } from '@shared/observability/types'

let tmpDir: string
let secretsPath: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nacime-soul-secret-'))
  secretsPath = path.join(tmpDir, 'secrets.json')
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/** fake safeStorage：available=true 时用可逆的 fake 加密 */
function createFakeSafeStorage(available: boolean): SafeStorageLike {
  if (!available) {
    return {
      isEncryptionAvailable: () => false,
      encryptString: () => {
        throw new Error('safeStorage not available')
      },
      decryptString: () => {
        throw new Error('safeStorage not available')
      }
    }
  }
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`FAKEENC${value}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const s = buffer.toString('utf8')
      if (s.startsWith('FAKEENC')) return s.slice(7)
      throw new Error('invalid ciphertext')
    }
  }
}

/** spy logger：收集 warn / error 调用 */
function createSpyLogger(): {
  logger: Logger
  warns: Array<{ msg: string; fields: LogFields }>
  errors: Array<{ msg: string; fields: LogFields }>
} {
  const warns: Array<{ msg: string; fields: LogFields }> = []
  const errors: Array<{ msg: string; fields: LogFields }> = []
  const logger: Logger = {
    fatal() {
      /* noop */
    },
    error(msg, fields) {
      errors.push({ msg, fields })
    },
    warn(msg, fields) {
      warns.push({ msg, fields })
    },
    info() {
      /* noop */
    },
    debug() {
      /* noop */
    },
    child() {
      return logger
    }
  }
  return { logger, warns, errors }
}

function writeSecrets(data: unknown): void {
  fs.writeFileSync(secretsPath, JSON.stringify(data, null, 2), 'utf8')
}

const TEST_KEY = 'sk-1234567890abcdef'

describe('P1-08 三种前缀可回读', () => {
  it('enc: 前缀可回读（safeStorage 可用）', () => {
    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(true)
    })
    store.setup()
    store.set('modelApiKey', TEST_KEY)
    expect(store.get('modelApiKey')).toBe(TEST_KEY)
  })

  // 审计 B-3 后：obf: 不再由 set() 产生，但历史数据必须仍可读（迁移兼容）。
  // 因此这里预置 obf: 数据而非用 set() 写出。
  it('obf: 前缀可回读（历史数据迁移兼容）', () => {
    const xorKey = crypto.randomBytes(32).toString('base64')
    const obfuscated = xorEncrypt(TEST_KEY, Buffer.from(xorKey, 'base64'))
    writeSecrets({
      schemaVersion: 1,
      xorKey,
      modelApiKey: `obf:${obfuscated.toString('base64')}`
    })
    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(false)
    })
    store.setup()
    expect(store.get('modelApiKey')).toBe(TEST_KEY)
  })

  it('plain: 前缀可回读', () => {
    writeSecrets({
      schemaVersion: 1,
      xorKey: crypto.randomBytes(32).toString('base64'),
      modelApiKey: `plain:${TEST_KEY}`
    })
    const { logger, warns } = createSpyLogger()
    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(true),
      logger
    })
    store.setup()
    expect(store.get('modelApiKey')).toBe(TEST_KEY)
    // plain: 降级发 SEC_KEYSTORE_DOWNGRADE warn
    expect(warns.some((w) => w.fields.code === 'SEC_KEYSTORE_DOWNGRADE')).toBe(true)
  })

  it('enc: 跨实例回读（持久化后重新加载）', () => {
    const store1 = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(true)
    })
    store1.setup()
    store1.set('modelApiKey', TEST_KEY)

    const store2 = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(true)
    })
    store2.setup()
    expect(store2.get('modelApiKey')).toBe(TEST_KEY)
  })

  it('obf: 跨实例回读（xorKey 持久化，历史数据）', () => {
    const xorKey = crypto.randomBytes(32).toString('base64')
    const obfuscated = xorEncrypt(TEST_KEY, Buffer.from(xorKey, 'base64'))
    writeSecrets({
      schemaVersion: 1,
      xorKey,
      ttsApiKey: `obf:${obfuscated.toString('base64')}`
    })

    const store2 = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(false)
    })
    store2.setup()
    expect(store2.get('ttsApiKey')).toBe(TEST_KEY)
  })
})

describe('P1-08 secrets.json 不含明文 key', () => {
  it('enc: 存储后文件不含明文 key', () => {
    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(true)
    })
    store.setup()
    store.set('modelApiKey', TEST_KEY)
    const raw = fs.readFileSync(secretsPath, 'utf8')
    expect(raw).not.toContain(TEST_KEY)
    expect(raw).toContain('enc:')
  })

  // 审计 B-3：keychain 不可用时拒绝保存，明文绝不落盘（旧行为是写 obf: 假加密）
  it('safeStorage 不可用时拒绝保存，文件不出现明文也不出现 obf:', () => {
    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(false)
    })
    store.setup()
    expect(() => store.set('modelApiKey', TEST_KEY)).toThrow(/密钥库不可用/)
    const raw = fs.readFileSync(secretsPath, 'utf8')
    expect(raw).not.toContain(TEST_KEY)
    expect(raw).not.toContain('obf:')
    // 也没有把 key 存进去
    expect(store.get('modelApiKey')).toBeNull()
  })

  it('多个 key 存储后都不含明文', () => {
    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(true)
    })
    store.setup()
    store.set('modelApiKey', 'sk-model-secret-key')
    store.set('ttsApiKey', 'sk-tts-secret-key')
    const raw = fs.readFileSync(secretsPath, 'utf8')
    expect(raw).not.toContain('sk-model-secret-key')
    expect(raw).not.toContain('sk-tts-secret-key')
  })
})

describe('P1-08 safeStorage 不可用降级', () => {
  // 审计 B-3：行为从"降级 XOR"改为"拒绝保存 + error 级日志"
  it('safeStorage 不可用时 set 抛 SEC_KEYSTORE_DOWNGRADE 并记 error', () => {
    const { logger, errors } = createSpyLogger()
    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(false),
      logger
    })
    store.setup()
    errors.length = 0
    expect(() => store.set('modelApiKey', TEST_KEY)).toThrow(
      expect.objectContaining({ code: 'SEC_KEYSTORE_DOWNGRADE' })
    )
    expect(errors.some((e) => e.fields.code === 'SEC_KEYSTORE_DOWNGRADE')).toBe(true)
  })

  it('safeStorage 可用时不发降级 warn', () => {
    const { logger, warns } = createSpyLogger()
    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(true),
      logger
    })
    store.setup()
    warns.length = 0
    store.set('modelApiKey', TEST_KEY)
    expect(warns.some((w) => w.fields.code === 'SEC_KEYSTORE_DOWNGRADE')).toBe(false)
  })
})

describe('P1-08 setup 与 xorKey', () => {
  it('首次 setup 生成 xorKey 并持久化', () => {
    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(false)
    })
    store.setup()
    const raw = JSON.parse(fs.readFileSync(secretsPath, 'utf8')) as {
      xorKey?: string
    }
    expect(raw.xorKey).toBeDefined()
    expect(raw.xorKey!.length).toBeGreaterThan(0)
  })

  it('xorKey 在重新加载时保持一致', () => {
    const store1 = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(false)
    })
    store1.setup()
    const raw1 = JSON.parse(fs.readFileSync(secretsPath, 'utf8')) as {
      xorKey: string
    }

    const store2 = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(false)
    })
    store2.setup()
    const raw2 = JSON.parse(fs.readFileSync(secretsPath, 'utf8')) as {
      xorKey: string
    }

    expect(raw2.xorKey).toBe(raw1.xorKey)
  })

  it('secrets.json 不存在时 setup 创建新文件', () => {
    expect(fs.existsSync(secretsPath)).toBe(false)
    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(true)
    })
    store.setup()
    expect(fs.existsSync(secretsPath)).toBe(true)
  })

  it('secrets.json 损坏时 setup 用空 secrets 重新初始化', () => {
    fs.writeFileSync(secretsPath, '{ invalid json !!!', 'utf8')
    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(true)
    })
    store.setup()
    // 仍然可用
    store.set('modelApiKey', TEST_KEY)
    expect(store.get('modelApiKey')).toBe(TEST_KEY)
  })
})

describe('P1-08 delete 与 has', () => {
  it('delete 删除 key', () => {
    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(true)
    })
    store.setup()
    store.set('modelApiKey', TEST_KEY)
    expect(store.has('modelApiKey')).toBe(true)
    store.delete('modelApiKey')
    expect(store.has('modelApiKey')).toBe(false)
    expect(store.get('modelApiKey')).toBe(null)
  })

  it('has 返回 false 对于不存在的 key', () => {
    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(true)
    })
    store.setup()
    expect(store.has('nonexistent')).toBe(false)
    expect(store.get('nonexistent')).toBe(null)
  })

  it('delete 持久化到文件', () => {
    const store1 = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(true)
    })
    store1.setup()
    store1.set('modelApiKey', TEST_KEY)
    store1.delete('modelApiKey')

    const store2 = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(true)
    })
    store2.setup()
    expect(store2.has('modelApiKey')).toBe(false)
  })
})

describe('P1-08 边界情况', () => {
  it('enc: 解密失败返回 null', () => {
    writeSecrets({
      schemaVersion: 1,
      xorKey: crypto.randomBytes(32).toString('base64'),
      modelApiKey: 'enc:aW52YWxpZGNpcGhlcnRleHQ=' // 无效密文
    })
    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(true)
    })
    store.setup()
    expect(store.get('modelApiKey')).toBe(null)
  })

  // M-34 语义的单一真源。此前 config 快照用「has+get」、首次引导判定却只用 has()，
  // 两处判据不一致 → 引导跳过配置页、聊天却报「未配置 API Key」，正是 M-34 要消灭的夹击。
  // 2026-08-29 CI 上真实撞到：密文跨重启解不开，has() 仍为 true。
  it('hasReadable：值存在但读不出来时为 false，而 has() 仍为 true', () => {
    writeSecrets({
      schemaVersion: 1,
      xorKey: crypto.randomBytes(32).toString('base64'),
      modelApiKey: 'enc:aW52YWxpZGNpcGhlcnRleHQ=' // 存在，但解密失败
    })
    const store = createSecretStore({ secretsPath, safeStorage: createFakeSafeStorage(true) })
    store.setup()

    expect(store.has('modelApiKey')).toBe(true)
    expect(store.get('modelApiKey')).toBe(null)
    expect(store.hasReadable('modelApiKey')).toBe(false)
  })

  it('hasReadable：值可读时为 true；键不存在时为 false', () => {
    const store = createSecretStore({ secretsPath, safeStorage: createFakeSafeStorage(true) })
    store.setup()
    expect(store.hasReadable('modelApiKey')).toBe(false)

    store.set('modelApiKey', 'sk-readable')
    expect(store.hasReadable('modelApiKey')).toBe(true)
  })

  it('未知前缀返回 null', () => {
    writeSecrets({
      schemaVersion: 1,
      xorKey: crypto.randomBytes(32).toString('base64'),
      modelApiKey: 'unknown:somevalue'
    })
    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(true)
    })
    store.setup()
    expect(store.get('modelApiKey')).toBe(null)
  })

  it('M-34：未知前缀打 SEC_KEYSTORE_UNREADABLE 警告，且同进程同字段只报一次', () => {
    writeSecrets({
      schemaVersion: 1,
      xorKey: crypto.randomBytes(32).toString('base64'),
      modelApiKey: 'unknown:somevalue'
    })
    const { logger, warns } = createSpyLogger()
    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(true),
      logger
    })
    store.setup()
    expect(store.get('modelApiKey')).toBe(null)
    expect(store.get('modelApiKey')).toBe(null) // 第二次读取不重复告警
    const unreadableWarns = warns.filter((w) => w.fields?.code === 'SEC_KEYSTORE_UNREADABLE')
    expect(unreadableWarns).toHaveLength(1)
    expect(unreadableWarns[0].fields?.tags).toEqual({ name: 'modelApiKey' })
  })

  it('空字符串 key 可存储和回读', () => {
    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(true)
    })
    store.setup()
    store.set('modelApiKey', '')
    expect(store.get('modelApiKey')).toBe('')
  })
})

describe('P1-08 S-004 #10: 已有前缀的值不重复加密', () => {
  // S-004 #10: 已有 enc:/obf:/plain: 值不重复加密
  // 防止密文/掩码回传后重复加密（P1-08 风险、P1-15 验收）

  it('enc: 前缀值不重复加密（直接保存，可正确回读）', () => {
    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(true),
      logger: createSpyLogger().logger
    })
    store.setup()

    // 先正常存储，拿到 enc: 密文
    store.set('k1', 'plaintext-secret')
    const raw1 = JSON.parse(fs.readFileSync(secretsPath, 'utf8'))
    const encValue = raw1.k1 as string
    expect(encValue.startsWith('enc:')).toBe(true)

    // 用已加密的 enc: 值再调 set（模拟密文回传场景）
    store.set('k2', encValue)

    // k2 存储值应与 k1 完全相同（未被重复加密）
    const raw2 = JSON.parse(fs.readFileSync(secretsPath, 'utf8'))
    expect(raw2.k2).toBe(encValue)

    // get(k2) 仍能正确解密回原文
    expect(store.get('k2')).toBe('plaintext-secret')
  })

  // 审计 B-3 后：obf: 不再由 set() 产生，但"已带前缀的值直通不重复加密"这条契约仍需成立
  // （前缀直通发生在 keychain 可用性检查之前），因此预置 obf: 值来验证。
  it('obf: 前缀值不重复加密（前缀直通早于 keychain 检查）', () => {
    const xorKey = crypto.randomBytes(32).toString('base64')
    const obfValue = `obf:${xorEncrypt('my-secret', Buffer.from(xorKey, 'base64')).toString('base64')}`
    writeSecrets({ schemaVersion: 1, xorKey })

    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(false),
      logger: createSpyLogger().logger
    })
    store.setup()

    // 即使 safeStorage 不可用，传入已带 obf: 前缀的值也应直通保存（不抛错、不重复加密）
    store.set('k2', obfValue)

    const raw2 = JSON.parse(fs.readFileSync(secretsPath, 'utf8'))
    expect(raw2.k2).toBe(obfValue)
    expect(store.get('k2')).toBe('my-secret')
  })

  it('plain: 前缀值不重复加密（直接保存）', () => {
    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(true),
      logger: createSpyLogger().logger
    })
    store.setup()

    // safeStorage 可用，但传入 plain: 前缀值 -> 不重复加密，直接保存
    store.set('k1', 'plain:my-plaintext')

    const raw = JSON.parse(fs.readFileSync(secretsPath, 'utf8'))
    expect(raw.k1).toBe('plain:my-plaintext')
    expect(store.get('k1')).toBe('my-plaintext')
  })

  it('密文回传不会产生双重加密（enc:enc:... 不应出现）', () => {
    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(true),
      logger: createSpyLogger().logger
    })
    store.setup()

    store.set('k1', 'original-secret')
    const raw1 = JSON.parse(fs.readFileSync(secretsPath, 'utf8'))
    const encValue = raw1.k1 as string

    // 模拟 UI 意外回传已加密的值
    store.set('k1', encValue)

    const raw2 = JSON.parse(fs.readFileSync(secretsPath, 'utf8'))
    // 不应出现 enc:enc: 双重前缀
    expect(raw2.k1).toBe(encValue)
    expect(raw2.k1).not.toMatch(/^enc:enc:/)
    // 仍可正确解密
    expect(store.get('k1')).toBe('original-secret')
  })
})

describe('P1-08 secrets.json schemaVersion 修正', () => {
  it('schemaVersion != 1 时 setup 修正为 1 并持久化', () => {
    // 写 schemaVersion=2 且不含 xorKey 的 secrets.json
    // setup() 内存修正 schemaVersion=1，且因 xorKey 不存在触发 persist() 写回
    writeSecrets({ schemaVersion: 2, modelApiKey: 'enc:test' })
    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(true),
      logger: createSpyLogger().logger
    })
    store.setup()
    const raw = JSON.parse(fs.readFileSync(secretsPath, 'utf8'))
    expect(raw.schemaVersion).toBe(1)
  })
})

// 审计 B-3：原「xorKey 丢失时 set() 重新生成」测试针对的降级写路径已删除。
// 替换为验证新契约：无论 setup 与否，keychain 不可用一律拒绝保存、绝不落任何形式的 key。
describe('P1-08/B-3 keychain 不可用时的写入拒绝', () => {
  it('未 setup 且 keychain 不可用时 set() 抛错且不落盘任何 key', () => {
    const store = createSecretStore({
      secretsPath,
      safeStorage: createFakeSafeStorage(false),
      logger: createSpyLogger().logger
    })
    expect(() => store.set('modelApiKey', 'test-secret')).toThrow(
      expect.objectContaining({ code: 'SEC_KEYSTORE_DOWNGRADE' })
    )
    expect(store.has('modelApiKey')).toBe(false)
    expect(store.get('modelApiKey')).toBeNull()
    // 未创建文件，或创建了但不含该 key（两种都可接受，关键是没有明文/obf 落盘）
    if (fs.existsSync(secretsPath)) {
      const raw = fs.readFileSync(secretsPath, 'utf8')
      expect(raw).not.toContain('test-secret')
      expect(raw).not.toContain('obf:')
    }
  })
})

describe('P1-08 enc 解密失败边界', () => {
  it('enc: 解密失败且异常非 Error 类型时返回 null', () => {
    // safeStorage.decryptString 抛出非 Error 值（字符串），覆盖 e instanceof Error 的 false 分支
    const throwingNonError: SafeStorageLike = {
      isEncryptionAvailable: () => true,
      encryptString: (v: string) => Buffer.from(`FAKEENC${v}`, 'utf8'),
      decryptString: () => {
        throw 'non-error string'
      }
    }
    writeSecrets({
      schemaVersion: 1,
      xorKey: crypto.randomBytes(32).toString('base64'),
      modelApiKey: 'enc:dGVzdA=='
    })
    const store = createSecretStore({
      secretsPath,
      safeStorage: throwingNonError,
      logger: createSpyLogger().logger
    })
    store.setup()
    expect(store.get('modelApiKey')).toBeNull()
  })
})
