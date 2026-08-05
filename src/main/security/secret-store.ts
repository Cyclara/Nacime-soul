// src/main/security/secret-store.ts
// SecretStore：enc:/obf:/plain: 三层格式，API Key 不进入 config JSON
// 依据：S-005 §1、§3.6.1、S-001 P1-08

import * as fs from 'node:fs'
import * as crypto from 'node:crypto'
import type { Logger } from '@shared/observability/types'
import { AppError } from '@shared/errors'
import { atomicWriteJson } from '../config/store'

/** safeStorage 接口（与 Electron safeStorage 兼容，便于测试注入） */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(buffer: Buffer): string
}

/** SecretStore 接口。API Key 只在此边界内以明文存在，不进入 config/Pinia/IPC 响应 */
export interface SecretStore {
  /** 读取 secrets.json，确保 xorKey 存在 */
  setup(): void
  /** 获取明文 key；不存在返回 null */
  get(name: string): string | null
  /** 存储明文 key（加密后写入 secrets.json） */
  set(name: string, value: string): void
  /** 删除指定 key */
  delete(name: string): void
  /** 是否存在指定 key */
  has(name: string): boolean
}

const PREFIX_ENC = 'enc:'
const PREFIX_OBF = 'obf:'
const PREFIX_PLAIN = 'plain:'

/** secrets.json 结构 */
interface SecretsFile {
  schemaVersion: 1
  /** XOR 混淆密钥（base64），obf: 降级时使用 */
  xorKey?: string
  [name: string]: string | number | undefined
}

/** noop logger，P1-12 真实 Logger 注入前的占位 */
const noopLogger: Logger = {
  fatal() {
    /* noop */
  },
  error() {
    /* noop */
  },
  warn() {
    /* noop */
  },
  info() {
    /* noop */
  },
  debug() {
    /* noop */
  },
  // noopLogger.child 在 secret-store 中无调用点，不可达分支
  /* istanbul ignore next */
  child() {
    return noopLogger
  }
}

/** XOR 加密（混淆，非真正加密）。obf: 降级方案 */
function xorEncrypt(plaintext: string, key: Buffer): Buffer {
  const data = Buffer.from(plaintext, 'utf8')
  const result = Buffer.alloc(data.length)
  for (let i = 0; i < data.length; i++) {
    result[i] = data[i] ^ key[i % key.length]
  }
  return result
}

/** XOR 解密 */
function xorDecrypt(ciphertext: Buffer, key: Buffer): string {
  const result = Buffer.alloc(ciphertext.length)
  for (let i = 0; i < ciphertext.length; i++) {
    result[i] = ciphertext[i] ^ key[i % key.length]
  }
  return result.toString('utf8')
}

class SecretStoreImpl implements SecretStore {
  private secrets: SecretsFile = { schemaVersion: 1 }
  private readonly logger: Logger
  private readonly secretsPath: string
  private readonly safeStorage: SafeStorageLike

  constructor(opts: { secretsPath: string; safeStorage: SafeStorageLike; logger?: Logger }) {
    this.secretsPath = opts.secretsPath
    this.safeStorage = opts.safeStorage
    this.logger = opts.logger ?? noopLogger
  }

  setup(): void {
    if (fs.existsSync(this.secretsPath)) {
      try {
        const raw = fs.readFileSync(this.secretsPath, 'utf8')
        const parsed = JSON.parse(raw) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          this.secrets = parsed as SecretsFile
          if (this.secrets.schemaVersion !== 1) {
            this.secrets.schemaVersion = 1
          }
        }
      } catch (e) {
        this.logger.warn('secrets.json parse failed, starting fresh', {
          scope: 'security',
          detail: e instanceof Error ? e.message : String(e)
        })
      }
    }
    // 确保 xorKey 存在（obf: 降级时需要）
    if (!this.secrets.xorKey) {
      this.secrets.xorKey = crypto.randomBytes(32).toString('base64')
      this.persist()
    }
  }

  get(name: string): string | null {
    const stored = this.secrets[name]
    if (typeof stored !== 'string') return null

    if (stored.startsWith(PREFIX_ENC)) {
      const payload = stored.slice(PREFIX_ENC.length)
      try {
        return this.safeStorage.decryptString(Buffer.from(payload, 'base64'))
      } catch (e) {
        this.logger.error('safeStorage decrypt failed', {
          scope: 'security',
          code: 'SEC_KEYSTORE_DOWNGRADE',
          detail: e instanceof Error ? e.message : String(e)
        })
        return null
      }
    }

    if (stored.startsWith(PREFIX_OBF)) {
      /* istanbul ignore next: xorKey 在 setup() 中必定生成，此分支为防御性代码 */
      if (!this.secrets.xorKey) return null
      const key = Buffer.from(this.secrets.xorKey, 'base64')
      // xorDecrypt 是纯 XOR + Buffer.toString，不会抛错，无需 try/catch
      return xorDecrypt(Buffer.from(stored.slice(PREFIX_OBF.length), 'base64'), key)
    }

    if (stored.startsWith(PREFIX_PLAIN)) {
      this.logger.warn('secret stored in plain format', {
        scope: 'security',
        code: 'SEC_KEYSTORE_DOWNGRADE',
        tags: { name }
      })
      return stored.slice(PREFIX_PLAIN.length)
    }

    // 未知前缀
    return null
  }

  set(name: string, value: string): void {
    // S-004 #10: 已有 enc:/obf:/plain: 前缀的值不重复加密。
    // 防止密文/掩码回传后重复加密（P1-08 风险、P1-15 验收"密文/掩码回传后重复加密"）。
    // 若 value 已带前缀，说明它已是存储格式，直接保存即可。
    if (
      value.startsWith(PREFIX_ENC) ||
      value.startsWith(PREFIX_OBF) ||
      value.startsWith(PREFIX_PLAIN)
    ) {
      this.secrets[name] = value
      this.persist()
      return
    }

    if (!this.safeStorage.isEncryptionAvailable()) {
      // 审计 B-3：不再降级为 XOR"混淆"。
      // 旧行为把 xorKey 和密文写在同一个 secrets.json 里（见 setup() 的 xorKey 生成），
      // 拿到文件即可还原 Key——等于没加密，却让用户以为 Key 被保护了。
      // 拒绝保存比假装加密更诚实：用户能立刻知道系统钥匙串不可用，自己决定怎么办。
      // 读路径仍保留 obf:/plain: 解析，保证历史数据可迁移（见 get()）。
      this.logger.error('refusing to store secret: OS keychain unavailable', {
        scope: 'security',
        code: 'SEC_KEYSTORE_DOWNGRADE',
        tags: { name }
      })
      throw new AppError({
        code: 'SEC_KEYSTORE_DOWNGRADE',
        userMessage:
          '系统密钥库不可用，无法安全保存 API Key。请检查系统钥匙串/凭据管理器是否正常，或改用环境变量提供密钥。',
        severity: 'error',
        retryable: false
      })
    }

    const encrypted = this.safeStorage.encryptString(value)
    this.secrets[name] = PREFIX_ENC + encrypted.toString('base64')
    this.persist()
  }

  delete(name: string): void {
    if (name in this.secrets) {
      delete this.secrets[name]
      this.persist()
    }
  }

  has(name: string): boolean {
    return typeof this.secrets[name] === 'string'
  }

  private persist(): void {
    atomicWriteJson(this.secretsPath, this.secrets)
  }
}

/** 创建 SecretStore */
export function createSecretStore(opts: {
  secretsPath: string
  safeStorage: SafeStorageLike
  logger?: Logger
}): SecretStore {
  return new SecretStoreImpl(opts)
}

export { xorEncrypt, xorDecrypt }
