// src/main/security/secret-store.ts
// SecretStore：enc:/obf:/plain: 三层格式，API Key 不进入 config JSON
// 依据：S-005 §1、§3.6.1、S-001 P1-08

import * as fs from 'node:fs'
import * as crypto from 'node:crypto'
import type { Logger } from '@shared/observability/types'
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

    if (this.safeStorage.isEncryptionAvailable()) {
      const encrypted = this.safeStorage.encryptString(value)
      this.secrets[name] = PREFIX_ENC + encrypted.toString('base64')
    } else {
      // safeStorage 不可用 -> 降级到 XOR 混淆
      this.logger.warn('safeStorage unavailable, downgrading to XOR obfuscation', {
        scope: 'security',
        code: 'SEC_KEYSTORE_DOWNGRADE',
        tags: { name }
      })
      const key = Buffer.from(this.secrets.xorKey ?? '', 'base64')
      if (key.length === 0) {
        // xorKey 丢失，重新生成
        this.secrets.xorKey = crypto.randomBytes(32).toString('base64')
      }
      const freshKey = Buffer.from(this.secrets.xorKey ?? '', 'base64')
      const obfuscated = xorEncrypt(value, freshKey)
      this.secrets[name] = PREFIX_OBF + obfuscated.toString('base64')
    }
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
