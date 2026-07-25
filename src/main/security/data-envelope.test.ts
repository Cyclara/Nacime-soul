// src/main/security/data-envelope.test.ts
// P1-09A 验收测试：DataEnvelopeV1 与密钥生命周期
// 依据：S-005 §3.6.1、S-001 P1-09A 验收标准
//
// 验收标准：
//   1. 往返成功
//   2. 篡改失败
//   3. 同明文密文不同
//   4. 错误口令失败
//   5. 导出包不含裸 DEK
//   6. 重绑后可解密
//   7. safeStorage 不可用时 fail-closed（数据 DEK 不降级）

import { describe, it, expect } from 'vitest'
import * as crypto from 'node:crypto'
import {
  generateDek,
  createDataEnvelope,
  openDataEnvelope,
  wrapDekLocal,
  unwrapDekLocal,
  exportDek,
  importDek,
  type ExportedDataKeyV1
} from './data-envelope'
import type { SafeStorageLike } from './secret-store'
import { isAppError } from '@shared/errors'

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
    // fake 加密：前缀标记 + 原文，可逆
    encryptString: (value: string) => Buffer.from(`FAKEENC${value}`, 'utf8'),
    decryptString: (buffer: Buffer) => {
      const s = buffer.toString('utf8')
      if (s.startsWith('FAKEENC')) return s.slice(7)
      throw new Error('invalid ciphertext')
    }
  }
}

const PLAINTEXT = '这是需要加密的私密记忆数据 Hello World 123'
const safeStorage = createFakeSafeStorage(true)

describe('P1-09A 往返成功', () => {
  it('加密后解密返回原文', () => {
    const dek = generateDek()
    const envelope = createDataEnvelope(PLAINTEXT, dek)
    const decrypted = openDataEnvelope(envelope, dek)
    expect(decrypted).toBe(PLAINTEXT)
  })

  it('空字符串往返', () => {
    const dek = generateDek()
    const envelope = createDataEnvelope('', dek)
    expect(openDataEnvelope(envelope, dek)).toBe('')
  })

  it('长文本往返', () => {
    const longText = 'A'.repeat(10_000)
    const dek = generateDek()
    const envelope = createDataEnvelope(longText, dek)
    expect(openDataEnvelope(envelope, dek)).toBe(longText)
  })

  it('Unicode 文本往返（中文 + emoji + 组合字符）', () => {
    const unicode = '你好世界 🌍👨‍👩‍👧‍👦 é ñ ü'
    const dek = generateDek()
    const envelope = createDataEnvelope(unicode, dek)
    expect(openDataEnvelope(envelope, dek)).toBe(unicode)
  })

  it('DEK 长度严格为 32 字节（256-bit）', () => {
    const dek = generateDek()
    expect(dek.length).toBe(32)
  })
})

describe('P1-09A 篡改失败', () => {
  it('修改 ciphertext 后解密失败', () => {
    const dek = generateDek()
    const envelope = createDataEnvelope(PLAINTEXT, dek)
    // 翻转 ciphertext 的第一个字节
    const ct = Buffer.from(envelope.ciphertext, 'base64')
    ct[0] ^= 0xff
    const tampered: typeof envelope = {
      ...envelope,
      ciphertext: ct.toString('base64')
    }
    expect(() => openDataEnvelope(tampered, dek)).toThrow()
  })

  it('修改 authTag 后解密失败', () => {
    const dek = generateDek()
    const envelope = createDataEnvelope(PLAINTEXT, dek)
    // 翻转 authTag 的第一个字节
    const tag = Buffer.from(envelope.authTag, 'base64')
    tag[0] ^= 0xff
    const tampered: typeof envelope = {
      ...envelope,
      authTag: tag.toString('base64')
    }
    expect(() => openDataEnvelope(tampered, dek)).toThrow()
  })

  it('修改 iv 后解密失败', () => {
    const dek = generateDek()
    const envelope = createDataEnvelope(PLAINTEXT, dek)
    // 翻转 iv 的第一个字节
    const iv = Buffer.from(envelope.iv, 'base64')
    iv[0] ^= 0xff
    const tampered: typeof envelope = {
      ...envelope,
      iv: iv.toString('base64')
    }
    expect(() => openDataEnvelope(tampered, dek)).toThrow()
  })

  it('使用错误 DEK 解密失败', () => {
    const dek1 = generateDek()
    const dek2 = generateDek()
    const envelope = createDataEnvelope(PLAINTEXT, dek1)
    expect(() => openDataEnvelope(envelope, dek2)).toThrow()
  })

  it('篡改 version 不影响解密（version 仅用于格式标识）', () => {
    const dek = generateDek()
    const envelope = createDataEnvelope(PLAINTEXT, dek)
    // version 不是加密参数，篡改不影响 GCM 认证
    const decrypted = openDataEnvelope({ ...envelope, version: 1 }, dek)
    expect(decrypted).toBe(PLAINTEXT)
  })
})

describe('P1-09A 同明文密文不同', () => {
  it('相同明文加密两次产生不同密文（不同 IV）', () => {
    const dek = generateDek()
    const env1 = createDataEnvelope(PLAINTEXT, dek)
    const env2 = createDataEnvelope(PLAINTEXT, dek)
    // IV 不同
    expect(env1.iv).not.toBe(env2.iv)
    // 密文不同
    expect(env1.ciphertext).not.toBe(env2.ciphertext)
    // 都能正确解密
    expect(openDataEnvelope(env1, dek)).toBe(PLAINTEXT)
    expect(openDataEnvelope(env2, dek)).toBe(PLAINTEXT)
  })

  it('100 次加密全部产生不同 IV', () => {
    const dek = generateDek()
    const ivs = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const env = createDataEnvelope(PLAINTEXT, dek)
      ivs.add(env.iv)
    }
    expect(ivs.size).toBe(100)
  })
})

describe('P1-09A DEK 本地包装（safeStorage）', () => {
  it('wrapDekLocal -> unwrapDekLocal 往返', () => {
    const dek = generateDek()
    const wrapped = wrapDekLocal(dek, safeStorage)
    const unwrapped = unwrapDekLocal(wrapped, safeStorage)
    expect(unwrapped.equals(dek)).toBe(true)
  })

  it('包装后的 WrappedDataKeyV1 格式正确', () => {
    const dek = generateDek()
    const wrapped = wrapDekLocal(dek, safeStorage)
    expect(wrapped.version).toBe(1)
    expect(wrapped.algorithm).toBe('AES-256-GCM')
    expect(wrapped.local.format).toBe('safeStorage')
    expect(wrapped.local.ciphertext).toBeTruthy()
    expect(wrapped.export).toBeUndefined()
  })

  it('safeStorage 不可用时 wrapDekLocal 抛 SEC_KEYSTORE_DOWNGRADE', () => {
    const unavailable = createFakeSafeStorage(false)
    const dek = generateDek()
    try {
      wrapDekLocal(dek, unavailable)
      expect.fail('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
      if (isAppError(e)) {
        expect(e.code).toBe('SEC_KEYSTORE_DOWNGRADE')
      }
    }
  })

  it('safeStorage 不可用时 unwrapDekLocal 抛 SEC_KEYSTORE_DOWNGRADE', () => {
    const unavailable = createFakeSafeStorage(false)
    const dek = generateDek()
    const wrapped = wrapDekLocal(dek, safeStorage)
    try {
      unwrapDekLocal(wrapped, unavailable)
      expect.fail('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
      if (isAppError(e)) {
        expect(e.code).toBe('SEC_KEYSTORE_DOWNGRADE')
      }
    }
  })

  it('safeStorage 解密失败时 unwrapDekLocal 抛错', () => {
    const dek = generateDek()
    const wrapped = wrapDekLocal(dek, safeStorage)
    // 篡改密文
    const tampered = {
      ...wrapped,
      local: { ...wrapped.local, ciphertext: 'aW52YWxpZGNpcGhlcnRleHQ=' }
    }
    expect(() => unwrapDekLocal(tampered, safeStorage)).toThrow()
  })
})

describe('P1-09A 跨机导出/导入', () => {
  it('exportDek -> importDek 往返', async () => {
    const dek = generateDek()
    const wrapped = wrapDekLocal(dek, safeStorage)
    const password = 'correct-password-123'

    const exported = await exportDek(wrapped, safeStorage, password)
    const imported = await importDek(exported, password, safeStorage)

    // 导入后重绑的 DEK 与原始 DEK 相同
    const rebindDek = unwrapDekLocal(imported, safeStorage)
    expect(rebindDek.equals(dek)).toBe(true)
  })

  it('错误口令导入失败', async () => {
    const dek = generateDek()
    const wrapped = wrapDekLocal(dek, safeStorage)
    const exported = await exportDek(wrapped, safeStorage, 'correct-password')

    try {
      await importDek(exported, 'wrong-password', safeStorage)
      expect.fail('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
      if (isAppError(e)) {
        expect(e.code).toBe('UNKNOWN')
        expect(e.userMessage).toContain('口令错误')
      }
    }
  })

  it('导出包不含裸 DEK', async () => {
    const dek = generateDek()
    const wrapped = wrapDekLocal(dek, safeStorage)
    const exported = await exportDek(wrapped, safeStorage, 'password')

    // 导出包不应包含 local 字段（safeStorage 包装的密文）
    expect((exported as { local?: unknown }).local).toBeUndefined()

    // wrappedDek 不等于裸 DEK 的 base64
    const rawDekBase64 = dek.toString('base64')
    expect(exported.export.wrappedDek).not.toBe(rawDekBase64)

    // 序列化后的 JSON 不含裸 DEK
    const json = JSON.stringify(exported)
    expect(json).not.toContain(rawDekBase64)

    // wrappedDek 是 32 字节密文（GCM 不扩展密文）
    const wrappedDekBuf = Buffer.from(exported.export.wrappedDek, 'base64')
    expect(wrappedDekBuf.length).toBe(32)
  })

  it('重绑后可解密数据', async () => {
    // 模拟跨机迁移：机器 A 加密数据 -> 导出 -> 机器 B 导入 -> 解密数据
    const dekA = generateDek()
    const plaintext = '跨机迁移的记忆数据 🚀'
    const envelope = createDataEnvelope(plaintext, dekA)

    // 机器 A：包装 DEK 并导出
    const wrappedA = wrapDekLocal(dekA, safeStorage)
    const exported = await exportDek(wrappedA, safeStorage, 'migration-password')

    // 机器 B：导入并重绑（用不同的 fake safeStorage 实例模拟不同机器）
    const safeStorageB = createFakeSafeStorage(true)
    const wrappedB = await importDek(exported, 'migration-password', safeStorageB)

    // 机器 B：解包 DEK 并解密数据
    const dekB = unwrapDekLocal(wrappedB, safeStorageB)
    const decrypted = openDataEnvelope(envelope, dekB)
    expect(decrypted).toBe(plaintext)
  })

  it('导出包格式正确（ExportedDataKeyV1）', async () => {
    const dek = generateDek()
    const wrapped = wrapDekLocal(dek, safeStorage)
    const exported = await exportDek(wrapped, safeStorage, 'pw')

    expect(exported.version).toBe(1)
    expect(exported.algorithm).toBe('AES-256-GCM')
    expect(exported.export.kdf).toBe('scrypt')
    expect(exported.export.N).toBe(131_072)
    expect(exported.export.r).toBe(8)
    expect(exported.export.p).toBe(1)
    expect(exported.export.salt).toBeTruthy()
    expect(exported.export.iv).toBeTruthy()
    expect(exported.export.tag).toBeTruthy()
    expect(exported.export.wrappedDek).toBeTruthy()
  })

  it('每次导出使用不同 salt', async () => {
    const dek = generateDek()
    const wrapped = wrapDekLocal(dek, safeStorage)
    const exp1 = await exportDek(wrapped, safeStorage, 'pw')
    const exp2 = await exportDek(wrapped, safeStorage, 'pw')
    expect(exp1.export.salt).not.toBe(exp2.export.salt)
    expect(exp1.export.iv).not.toBe(exp2.export.iv)
  })

  it('篡改导出包的 wrappedDek 后导入失败', async () => {
    const dek = generateDek()
    const wrapped = wrapDekLocal(dek, safeStorage)
    const exported = await exportDek(wrapped, safeStorage, 'pw')

    // 翻转 wrappedDek 的第一个字节
    const buf = Buffer.from(exported.export.wrappedDek, 'base64')
    buf[0] ^= 0xff
    const tampered: ExportedDataKeyV1 = {
      ...exported,
      export: { ...exported.export, wrappedDek: buf.toString('base64') }
    }
    try {
      await importDek(tampered, 'pw', safeStorage)
      expect.fail('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
    }
  })

  it('篡改导出包的 salt 后导入失败', async () => {
    const dek = generateDek()
    const wrapped = wrapDekLocal(dek, safeStorage)
    const exported = await exportDek(wrapped, safeStorage, 'pw')

    // 用不同 salt -> 派生不同 KEK -> 解密失败
    const tampered: ExportedDataKeyV1 = {
      ...exported,
      export: {
        ...exported.export,
        salt: crypto.randomBytes(32).toString('base64')
      }
    }
    try {
      await importDek(tampered, 'pw', safeStorage)
      expect.fail('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
    }
  })

  it('safeStorage 不可用时 exportDek 抛 SEC_KEYSTORE_DOWNGRADE', async () => {
    const unavailable = createFakeSafeStorage(false)
    const dek = generateDek()
    const wrapped = wrapDekLocal(dek, safeStorage)
    try {
      await exportDek(wrapped, unavailable, 'pw')
      expect.fail('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
      if (isAppError(e)) {
        expect(e.code).toBe('SEC_KEYSTORE_DOWNGRADE')
      }
    }
  })

  it('safeStorage 不可用时 importDek 抛 SEC_KEYSTORE_DOWNGRADE', async () => {
    const unavailable = createFakeSafeStorage(false)
    const dek = generateDek()
    const wrapped = wrapDekLocal(dek, safeStorage)
    const exported = await exportDek(wrapped, safeStorage, 'pw')
    try {
      await importDek(exported, 'pw', unavailable)
      expect.fail('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
      if (isAppError(e)) {
        expect(e.code).toBe('SEC_KEYSTORE_DOWNGRADE')
      }
    }
  })
})
