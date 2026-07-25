// src/main/security/data-envelope.ts
// P1-09A: DataEnvelopeV1 与密钥生命周期纯函数
// 依据：S-005 §3.6.1、S-001 P1-09A 验收标准
//
// 密钥层次：
//   DEK (数据加密密钥, 256-bit CSPRNG)  ← 加密实际数据
//     ↑ safeStorage 包装               ← 本机持久化（WrappedDataKeyV1.local）
//     ↑ scrypt KEK 包装                ← 跨机导出（ExportedDataKeyV1.export）
//
// 安全约束（S-005 §3.6.1）：
//   - DEK 只在 main 进程短时存在，用完即弃
//   - 不得用 API Key、设备 ID、路径、用户名或固定常量充当/派生 DEK
//   - 数据 DEK 不允许降级到 plain:（与 API Key SecretStore 不同）
//   - safeStorage 不可用时，真实记忆加密功能必须阻断（fail-closed）
//   - 导出包只带 KDF 参数和 wrapped DEK，不含裸 DEK
//   - 导入后立即用目标机器 safeStorage 重绑，口令与 KEK 不落盘

import * as crypto from 'node:crypto'
import type { WrappedDataKeyV1 } from '@shared/config/types'
import { AppError } from '@shared/errors'
import type { SafeStorageLike } from './secret-store'

/** 加密内容信封。DEK 加密后的数据格式 */
export interface DataEnvelopeV1 {
  version: 1
  algorithm: 'AES-256-GCM'
  /** 初始化向量，base64，12 字节（96-bit GCM nonce） */
  iv: string
  /** 密文，base64 */
  ciphertext: string
  /** GCM 认证标签，base64，16 字节（128-bit auth tag） */
  authTag: string
}

/** 跨机导出包。只含 KDF 参数和 wrapped DEK，不含本地 safeStorage 包装 */
export interface ExportedDataKeyV1 {
  version: 1
  algorithm: 'AES-256-GCM'
  export: NonNullable<WrappedDataKeyV1['export']>
}

/** scrypt 参数。S-005 §3.6.1 固定为 N=2^17, r=8, p=1 */
const SCRYPT_PARAMS = {
  N: 131_072,
  r: 8,
  p: 1,
  // N=131072, r=8 需要约 128MB 内存，超过 scrypt 默认 32MB 限制
  maxmem: 256 * 1024 * 1024
} as const

const DEK_LENGTH = 32 // 256-bit
const IV_LENGTH = 12 // 96-bit GCM nonce
const KEK_LENGTH = 32 // 256-bit KEK (scrypt 输出)
const SALT_LENGTH = 32 // scrypt salt

// ── 数据信封：加密/解密 ──

/** 生成随机 256-bit DEK。必须来自 CSPRNG */
export function generateDek(): Buffer {
  return crypto.randomBytes(DEK_LENGTH)
}

/**
 * 用 DEK 加密明文，返回 DataEnvelopeV1。
 * 每次调用使用新的随机 IV，因此相同明文产生不同密文。
 */
export function createDataEnvelope(plaintext: string, dek: Buffer): DataEnvelopeV1 {
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return {
    version: 1,
    algorithm: 'AES-256-GCM',
    iv: iv.toString('base64'),
    ciphertext: encrypted.toString('base64'),
    authTag: authTag.toString('base64')
  }
}

/**
 * 用 DEK 解密 DataEnvelopeV1。
 * 篡改 ciphertext/iv/authTag 或使用错误 DEK 时抛错（GCM 认证失败）。
 */
export function openDataEnvelope(envelope: DataEnvelopeV1, dek: Buffer): string {
  const iv = Buffer.from(envelope.iv, 'base64')
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64')
  const authTag = Buffer.from(envelope.authTag, 'base64')
  const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv)
  decipher.setAuthTag(authTag)
  // final() 在 GCM 认证失败时抛错
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8')
}

// ── DEK 本地包装：safeStorage ──

/**
 * 用 safeStorage 包装 DEK 用于本地持久化。
 * safeStorage 不可用时抛 SEC_KEYSTORE_DOWNGRADE（数据 DEK 不降级）。
 */
export function wrapDekLocal(dek: Buffer, safeStorage: SafeStorageLike): WrappedDataKeyV1 {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new AppError({
      code: 'SEC_KEYSTORE_DOWNGRADE',
      severity: 'error',
      userMessage: '安全存储不可用，数据加密功能已阻断',
      retryable: false
    })
  }
  // DEK 以 base64 编码后用 safeStorage 加密
  const encrypted = safeStorage.encryptString(dek.toString('base64'))
  return {
    version: 1,
    algorithm: 'AES-256-GCM',
    local: { format: 'safeStorage', ciphertext: encrypted.toString('base64') }
  }
}

/**
 * 从本地包装中解包 DEK。
 * safeStorage 不可用时抛 SEC_KEYSTORE_DOWNGRADE。
 */
export function unwrapDekLocal(wrapped: WrappedDataKeyV1, safeStorage: SafeStorageLike): Buffer {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new AppError({
      code: 'SEC_KEYSTORE_DOWNGRADE',
      severity: 'error',
      userMessage: '安全存储不可用，数据加密功能已阻断',
      retryable: false
    })
  }
  if (wrapped.local.format !== 'safeStorage') {
    throw new AppError({
      code: 'UNKNOWN',
      severity: 'error',
      userMessage: `不支持的本地密钥格式: ${wrapped.local.format}`,
      retryable: false
    })
  }
  const dekBase64 = safeStorage.decryptString(Buffer.from(wrapped.local.ciphertext, 'base64'))
  return Buffer.from(dekBase64, 'base64')
}

// ── 跨机导出/导入：scrypt KEK ──

/** scrypt 异步包装 */
function scryptDerive(password: string, salt: Buffer, keyLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, SCRYPT_PARAMS, (err, key) => {
      if (err) reject(err)
      else resolve(key)
    })
  })
}

/**
 * 导出 DEK 用于跨机迁移。
 * 用口令经 scrypt 派生 KEK，AES-256-GCM 包装 DEK。
 * 返回 ExportedDataKeyV1，只含 KDF 参数和 wrapped DEK，不含裸 DEK 和本地 safeStorage 包装。
 */
export async function exportDek(
  wrapped: WrappedDataKeyV1,
  safeStorage: SafeStorageLike,
  password: string
): Promise<ExportedDataKeyV1> {
  const dek = unwrapDekLocal(wrapped, safeStorage)
  const salt = crypto.randomBytes(SALT_LENGTH)
  const kek = await scryptDerive(password, salt, KEK_LENGTH)
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv)
  const encrypted = Buffer.concat([cipher.update(dek), cipher.final()])
  const tag = cipher.getAuthTag()
  // 清除内存中的敏感数据（best-effort）
  kek.fill(0)
  dek.fill(0)
  return {
    version: 1,
    algorithm: 'AES-256-GCM',
    export: {
      kdf: 'scrypt',
      N: 131_072,
      r: 8,
      p: 1,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      wrappedDek: encrypted.toString('base64')
    }
  }
}

/**
 * 从导出包导入 DEK。
 * 用口令经 scrypt 派生 KEK，解包 DEK，立即用目标机器 safeStorage 重绑。
 * 错误口令 -> GCM 认证失败 -> 抛错。口令与 KEK 不落盘。
 */
export async function importDek(
  exported: ExportedDataKeyV1,
  password: string,
  safeStorage: SafeStorageLike
): Promise<WrappedDataKeyV1> {
  const exp = exported.export
  const salt = Buffer.from(exp.salt, 'base64')
  const kek = await scryptDerive(password, salt, KEK_LENGTH)
  const iv = Buffer.from(exp.iv, 'base64')
  const tag = Buffer.from(exp.tag, 'base64')
  const encryptedDek = Buffer.from(exp.wrappedDek, 'base64')
  let dek: Buffer
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', kek, iv)
    decipher.setAuthTag(tag)
    dek = Buffer.concat([decipher.update(encryptedDek), decipher.final()])
  } catch {
    // GCM 认证失败 = 口令错误或数据被篡改
    kek.fill(0)
    throw new AppError({
      code: 'UNKNOWN',
      severity: 'error',
      userMessage: '导入失败：口令错误或导出包已损坏',
      retryable: false
    })
  }
  // 立即用本地 safeStorage 重绑，不保留裸 DEK
  kek.fill(0)
  const result = wrapDekLocal(dek, safeStorage)
  dek.fill(0)
  return result
}
