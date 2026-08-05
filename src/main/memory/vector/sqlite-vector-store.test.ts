// src/main/memory/vector/sqlite-vector-store.test.ts
// P2-08：1k 假向量 top-k 与参照实现容差 1e-6；BLOB 往返无损；维度不匹配抛错；minScore/k。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createSQLiteVectorStore } from './sqlite-vector-store'
import { cosine } from './cosine'
import { makeMemoryDb, type TestDb } from '../../../../tests/helpers/test-db'

/** 确定性 PRNG（S-004 V-系列要求 seeded） */
function mulberry32(seed: number): () => number {
  let s = seed
  return function () {
    s |= 0
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('P2-08 SQLiteVectorStore (flat)', () => {
  let t: TestDb
  beforeEach(async () => {
    t = await makeMemoryDb()
  })
  afterEach(() => t.cleanup())

  function seedMemories(
    n: number,
    dim: number,
    seed: number
  ): { ids: string[]; vecs: Float32Array[] } {
    const rnd = mulberry32(seed)
    const ids: string[] = []
    const vecs: Float32Array[] = []
    const ins = t.db.prepare(`INSERT INTO l2_memories (id, content, confidence) VALUES (?,?,?)`)
    for (let i = 0; i < n; i++) {
      const id = `l2_${i}`
      ins.run(id, `mem ${i}`, 0.5)
      const v = new Float32Array(dim)
      for (let j = 0; j < dim; j++) v[j] = rnd() * 2 - 1
      ids.push(id)
      vecs.push(v)
    }
    return { ids, vecs }
  }

  it('1k vectors: brute top-k matches reference within 1e-6, BLOB round-trips', async () => {
    const dim = 64
    const n = 1000
    const { ids, vecs } = seedMemories(n, dim, 12345)
    const store = createSQLiteVectorStore({ db: t.db, dim })
    await store.init()
    for (let i = 0; i < n; i++) store.upsert(ids[i], vecs[i])
    expect(store.count()).toBe(n)

    const rnd = mulberry32(999)
    const q = new Float32Array(dim)
    for (let j = 0; j < dim; j++) q[j] = rnd() * 2 - 1

    const hits = store.search(q, 10, -1)
    expect(hits.length).toBe(10)

    const ref = ids
      .map((id, i) => ({ id, score: cosine(q, vecs[i]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
    expect(hits.map((h) => h.memoryId)).toEqual(ref.map((r) => r.id))
    for (let i = 0; i < 10; i++) expect(Math.abs(hits[i].score - ref[i].score)).toBeLessThan(1e-6)

    // BLOB 往返：新实例从 SQLite 重载，结果一致
    const store2 = createSQLiteVectorStore({ db: t.db, dim })
    await store2.init()
    expect(store2.count()).toBe(n)
    const hits2 = store2.search(q, 10, -1)
    expect(hits2.map((h) => h.memoryId)).toEqual(hits.map((h) => h.memoryId))
    for (let i = 0; i < 10; i++) expect(Math.abs(hits2[i].score - hits[i].score)).toBeLessThan(1e-6)
  })

  it('dimension mismatch on upsert → MEM_EMBED_FAIL', async () => {
    const store = createSQLiteVectorStore({ db: t.db, dim: 8 })
    await store.init()
    t.db.prepare(`INSERT INTO l2_memories (id, content, confidence) VALUES ('l2_a','x',0.5)`).run()
    store.upsert('l2_a', new Float32Array(8))
    t.db.prepare(`INSERT INTO l2_memories (id, content, confidence) VALUES ('l2_b','x',0.5)`).run()
    let err: unknown
    try {
      store.upsert('l2_b', new Float32Array(16))
    } catch (e) {
      err = e
    }
    expect((err as { code?: string })?.code).toBe('MEM_EMBED_FAIL')
  })

  it('dimension mismatch on search → MEM_EMBED_FAIL', async () => {
    const store = createSQLiteVectorStore({ db: t.db, dim: 8 })
    await store.init()
    t.db.prepare(`INSERT INTO l2_memories (id, content, confidence) VALUES ('l2_a','x',0.5)`).run()
    store.upsert('l2_a', new Float32Array(8))
    let err: unknown
    try {
      store.search(new Float32Array(4), 5)
    } catch (e) {
      err = e
    }
    expect((err as { code?: string })?.code).toBe('MEM_EMBED_FAIL')
  })

  it('remove drops from index and SQLite; revision increments on writes', async () => {
    const store = createSQLiteVectorStore({ db: t.db, dim: 8 })
    await store.init()
    const r0 = store.revision()
    t.db.prepare(`INSERT INTO l2_memories (id, content, confidence) VALUES ('l2_a','x',0.5)`).run()
    store.upsert('l2_a', new Float32Array([1, 0, 0, 0, 0, 0, 0, 0]))
    expect(store.count()).toBe(1)
    expect(store.revision()).toBeGreaterThan(r0)
    store.remove('l2_a')
    expect(store.count()).toBe(0)
    expect((t.db.prepare(`SELECT COUNT(*) c FROM l2_vectors`).get() as { c: number }).c).toBe(0)
  })

  it('search respects minScore and returns at most k', async () => {
    const store = createSQLiteVectorStore({ db: t.db, dim: 4 })
    await store.init()
    const ins = t.db.prepare(`INSERT INTO l2_memories (id, content, confidence) VALUES (?,?,?)`)
    ins.run('same', 'x', 0.5)
    ins.run('orth', 'x', 0.5)
    store.upsert('same', new Float32Array([1, 0, 0, 0]))
    store.upsert('orth', new Float32Array([0, 1, 0, 0]))
    const hits = store.search(new Float32Array([1, 0, 0, 0]), 10, 0.35)
    expect(hits.map((h) => h.memoryId)).toEqual(['same']) // orth 余弦 0 < 0.35 被过滤
    expect(hits[0].score).toBeCloseTo(1, 6)
  })
})
