// src/main/chat/idempotency-ledger.test.ts
// P2-43: clientRequestId 幂等账本单元测试。
// 依据：S-002-补充-P2-43 §4（缓存定性、LRU 有界、corrupt 不拦启动）。
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createIdempotencyLedger,
  hashIdempotencyText,
  IDEMPOTENCY_LEDGER_MAX_ENTRIES,
  type PersistedIdempotencyRecord
} from './idempotency-ledger'
import { testNoopLogger } from '../../../tests/helpers/test-db'

const dirs: string[] = []
function tmpLedgerPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'nacime-ledger-'))
  dirs.push(dir)
  return join(dir, 'chat-idempotency.json')
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

function makeRecord(
  overrides: Partial<PersistedIdempotencyRecord> = {}
): PersistedIdempotencyRecord {
  return {
    sessionId: 's-1',
    textHash: hashIdempotencyText('你好'),
    ack: { requestId: 'r-1', userMessageId: 'u-1', assistantMessageId: 'a-1' },
    state: 'completed',
    createdAt: 1_000,
    ...overrides
  }
}

describe('P2-43 幂等账本：持久化与缓存定性', () => {
  it('put/get 往返；新实例从同一文件加载（跨重启）', () => {
    const file = tmpLedgerPath()
    const ledger1 = createIdempotencyLedger({ filePath: file, logger: testNoopLogger })
    expect(ledger1.get('k1')).toBeNull()

    ledger1.put('k1', makeRecord())
    expect(ledger1.size).toBe(1)
    // 隐私：账本只存正文 SHA-256，不重复落聊天明文
    expect(readFileSync(file, 'utf8')).not.toContain('你好')

    // 模拟重启：新实例加载同一文件
    const ledger2 = createIdempotencyLedger({ filePath: file, logger: testNoopLogger })
    expect(ledger2.get('k1')).toEqual(makeRecord())
    expect(ledger2.size).toBe(1)
  })

  it('remove 落盘；put 同 key 覆盖', () => {
    const file = tmpLedgerPath()
    const ledger = createIdempotencyLedger({ filePath: file, logger: testNoopLogger })
    ledger.put('k1', makeRecord({ textHash: hashIdempotencyText('v1') }))
    ledger.put('k1', makeRecord({ textHash: hashIdempotencyText('v2') }))
    expect(ledger.get('k1')!.textHash).toBe(hashIdempotencyText('v2'))
    expect(ledger.size).toBe(1)

    ledger.remove('k1')
    expect(ledger.get('k1')).toBeNull()
    const reloaded = createIdempotencyLedger({ filePath: file, logger: testNoopLogger })
    expect(reloaded.get('k1')).toBeNull()
  })

  it('LRU：超上限淘汰最老；get 命中刷新热度', () => {
    const file = tmpLedgerPath()
    const ledger = createIdempotencyLedger({
      filePath: file,
      logger: testNoopLogger,
      maxEntries: 3
    })
    ledger.put('k1', makeRecord())
    ledger.put('k2', makeRecord())
    ledger.put('k3', makeRecord())
    // 命中 k1 后刷新热度，因此下一次淘汰的应是 k2
    expect(ledger.get('k1')).not.toBeNull()
    ledger.put('k4', makeRecord()) // 淘汰最老 = k2

    expect(ledger.size).toBe(3)
    expect(ledger.get('k2')).toBeNull()
    expect(ledger.get('k1')).not.toBeNull()
    expect(ledger.get('k3')).not.toBeNull()
    expect(ledger.get('k4')).not.toBeNull()
  })

  it('corrupt 文件 -> 空表继续不抛错（缓存定性，不拦启动）', () => {
    const file = tmpLedgerPath()
    writeFileSync(file, '{ not valid json')
    const ledger = createIdempotencyLedger({ filePath: file, logger: testNoopLogger })
    expect(ledger.size).toBe(0)
    // 还能正常写入（覆盖坏文件）
    ledger.put('k1', makeRecord())
    expect(ledger.get('k1')).not.toBeNull()
  })

  it('shape 不符（合法 JSON 非账本）-> 空表继续', () => {
    const file = tmpLedgerPath()
    writeFileSync(file, JSON.stringify({ hello: 'world' }))
    const ledger = createIdempotencyLedger({ filePath: file, logger: testNoopLogger })
    expect(ledger.size).toBe(0)
  })

  it('默认上限常量 = 256', () => {
    expect(IDEMPOTENCY_LEDGER_MAX_ENTRIES).toBe(256)
  })
})
