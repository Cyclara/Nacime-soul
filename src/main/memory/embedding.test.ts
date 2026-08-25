// src/main/memory/embedding.test.ts
// P2-09：正常/超时/401/维度校验（mock fetch）；模型变更→拒绝新旧混算。
import { describe, it, expect, afterEach } from 'vitest'
import { createEmbeddingClient, verifyEmbeddingModel } from './embedding'
import { makeMemoryDb, testNoopLogger, type TestDb } from '../../../tests/helpers/test-db'

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(body)
    },
    async json() {
      return body
    }
  } as unknown as Response
}

function errorResponse(status: number, body = 'err'): Response {
  return {
    ok: false,
    status,
    async text() {
      return body
    },
    async json() {
      return {}
    }
  } as unknown as Response
}

const cfg = {
  provider: 'siliconflow',
  model: 'bge-m3',
  baseUrl: 'https://api.test/v1',
  apiKey: 'sk-test-key-123456',
  dimension: 4
}

describe('P2-09 embedding client', () => {
  it('normal: returns Float32Array of configured dim, hits /embeddings', async () => {
    let calledUrl = ''
    const fetchFn = (async (url: string) => {
      calledUrl = url
      return jsonResponse({
        data: [{ embedding: [0.1, 0.2, 0.3, 0.4], index: 0 }],
        model: 'bge-m3'
      })
    }) as unknown as typeof fetch
    const client = createEmbeddingClient(cfg, { logger: testNoopLogger, fetchFn })
    const v = await client.embed('你好')
    expect(calledUrl).toBe('https://api.test/v1/embeddings')
    expect(v).toBeInstanceOf(Float32Array)
    expect(v.length).toBe(4)
    expect(Array.from(v)).toEqual([
      expect.closeTo(0.1, 6),
      expect.closeTo(0.2, 6),
      expect.closeTo(0.3, 6),
      expect.closeTo(0.4, 6)
    ])
  })

  it('batch preserves order by index', async () => {
    const fetchFn = (async () =>
      jsonResponse({
        data: [
          { embedding: [1, 0, 0, 0], index: 1 },
          { embedding: [0, 1, 0, 0], index: 0 }
        ]
      })) as unknown as typeof fetch
    const client = createEmbeddingClient(cfg, { logger: testNoopLogger, fetchFn })
    const [a, b] = await client.embedBatch(['x', 'y'])
    expect(Array.from(a)).toEqual([0, 1, 0, 0]) // index 0 first
    expect(Array.from(b)).toEqual([1, 0, 0, 0])
  })

  it('401 → LLM_AUTH (not retryable)', async () => {
    const fetchFn = (async () => errorResponse(401, 'unauthorized')) as unknown as typeof fetch
    const client = createEmbeddingClient(cfg, { logger: testNoopLogger, fetchFn })
    let err: unknown
    try {
      await client.embed('x')
    } catch (e) {
      err = e
    }
    expect((err as { code?: string })?.code).toBe('LLM_AUTH')
    expect((err as { retryable?: boolean })?.retryable).toBe(false)
  })

  it('timeout → NET_TIMEOUT', async () => {
    const fetchFn = ((_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
        })
      })) as unknown as typeof fetch
    const client = createEmbeddingClient(
      { ...cfg, timeoutMs: 10 },
      { logger: testNoopLogger, fetchFn }
    )
    let err: unknown
    try {
      await client.embed('x')
    } catch (e) {
      err = e
    }
    expect((err as { code?: string })?.code).toBe('NET_TIMEOUT')
  })

  it('dimension mismatch → MEM_EMBED_FAIL', async () => {
    const fetchFn = (async () =>
      jsonResponse({
        data: [{ embedding: [1, 2, 3, 4, 5, 6, 7, 8], index: 0 }]
      })) as unknown as typeof fetch
    const client = createEmbeddingClient(cfg, { logger: testNoopLogger, fetchFn })
    let err: unknown
    try {
      await client.embed('x')
    } catch (e) {
      err = e
    }
    expect((err as { code?: string })?.code).toBe('MEM_EMBED_FAIL')
  })

  it('malformed response → LLM_MALFORMED', async () => {
    const fetchFn = (async () => jsonResponse({ notdata: [] })) as unknown as typeof fetch
    const client = createEmbeddingClient(cfg, { logger: testNoopLogger, fetchFn })
    let err: unknown
    try {
      await client.embed('x')
    } catch (e) {
      err = e
    }
    expect((err as { code?: string })?.code).toBe('LLM_MALFORMED')
  })
})

describe('P2-09 verifyEmbeddingModel', () => {
  let t: TestDb
  afterEach(() => t.cleanup())

  it('fresh → writes model+dim, returns fresh', async () => {
    t = await makeMemoryDb()
    expect(verifyEmbeddingModel(t.db, 'bge-m3', 1024).status).toBe('fresh')
    const model = (
      t.db.prepare(`SELECT value FROM vec_meta WHERE key='embeddingModel'`).get() as {
        value: string
      }
    ).value
    expect(model).toBe('bge-m3')
  })

  it('same model → ok', async () => {
    t = await makeMemoryDb()
    verifyEmbeddingModel(t.db, 'bge-m3', 1024)
    expect(verifyEmbeddingModel(t.db, 'bge-m3', 1024).status).toBe('ok')
  })

  it('model change → changed (blocks mixing), does not overwrite stored', async () => {
    t = await makeMemoryDb()
    verifyEmbeddingModel(t.db, 'bge-m3', 1024)
    const res = verifyEmbeddingModel(t.db, 'text-embedding-3', 1536)
    expect(res.status).toBe('changed')
    if (res.status === 'changed') {
      expect(res.storedModel).toBe('bge-m3')
      expect(res.storedDim).toBe(1024)
    }
    // 存储值未被覆盖
    const model = (
      t.db.prepare(`SELECT value FROM vec_meta WHERE key='embeddingModel'`).get() as {
        value: string
      }
    ).value
    expect(model).toBe('bge-m3')
  })
})
