// src/main/memory/embedding.ts
// Embedding 客户端：OpenAI-compatible /embeddings 调用 → Float32Array。
// 依据：S-Phase2 P2-09、F5-003（模型变更=数据迁移，禁止新旧混算）。
// 复用 Phase 1 的错误映射（mapHttpError/mapFetchError）与 fetch 注入模式。
//
// 说明：embedding 的 baseUrl / apiKey 由调用方在 wiring 时注入（memory 配置域当前
// 只有 provider/model/dimension，凭据来源在集成步骤解析——可能复用 model 域凭据或
// 后续新增 memory embedding 配置）。本客户端对凭据来源不可知。

import type { Database } from 'better-sqlite3'
import { AppError } from '@shared/errors'
import type { Logger } from '@shared/observability/types'
import { mapFetchError, mapHttpError } from '../llm/errors'

export interface EmbeddingConfig {
  /** 供应商标识（日志/元数据用） */
  provider: string
  /** embedding 模型名（写入 vec_meta.embeddingModel） */
  model: string
  /** API 根地址（如 https://api.siliconflow.cn/v1）；自动追加 /embeddings */
  baseUrl: string
  apiKey: string
  /** 期望维度（config.memory.embeddingDimension）；>0 时校验，不符抛 MEM_EMBED_FAIL */
  dimension: number
  timeoutMs?: number
}

export interface EmbeddingClient {
  embed(text: string): Promise<Float32Array>
  embedBatch(texts: string[]): Promise<Float32Array[]>
}

const DEFAULT_TIMEOUT_MS = 30_000

export interface EmbeddingDeps {
  logger: Logger
  /** 生产注入 createSecureFetch；默认 globalThis.fetch */
  fetchFn?: typeof globalThis.fetch
}

function embeddingsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/embeddings') ? trimmed : `${trimmed}/embeddings`
}

export function createEmbeddingClient(cfg: EmbeddingConfig, deps: EmbeddingDeps): EmbeddingClient {
  const fetchFn = deps.fetchFn ?? globalThis.fetch
  const logger = deps.logger
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const url = embeddingsUrl(cfg.baseUrl)
  const tags = { provider: cfg.provider, model: cfg.model }

  function malformed(detail: string): AppError {
    logger.warn('embedding response malformed', { scope: 'memory', code: 'LLM_MALFORMED', detail })
    return new AppError({
      code: 'LLM_MALFORMED',
      userMessage: 'Embedding 服务返回格式异常',
      severity: 'error',
      retryable: false
    })
  }

  function dimFail(got: number): AppError {
    logger.warn('embedding dimension mismatch', {
      scope: 'memory',
      code: 'MEM_EMBED_FAIL',
      metrics: { expected: cfg.dimension, got }
    })
    return new AppError({
      code: 'MEM_EMBED_FAIL',
      userMessage: 'Embedding 维度与配置不符',
      severity: 'error',
      retryable: false
    })
  }

  async function embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return []
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    try {
      const res = await fetchFn(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.apiKey}`
        },
        body: JSON.stringify({ model: cfg.model, input: texts }),
        signal: controller.signal
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw mapHttpError(res.status, body, logger, tags)
      }
      const json = (await res.json()) as {
        data?: Array<{ embedding?: number[]; index?: number }>
      }
      if (!json.data || !Array.isArray(json.data) || json.data.length !== texts.length) {
        throw malformed(`data length ${json.data?.length ?? 'none'} != ${texts.length}`)
      }
      // 按 index 还原顺序（若无 index 则按返回顺序）
      const ordered = json.data.every((d) => typeof d.index === 'number')
        ? [...json.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        : json.data
      return ordered.map((d) => {
        if (!Array.isArray(d.embedding)) throw malformed('missing embedding array')
        const arr = Float32Array.from(d.embedding)
        if (cfg.dimension > 0 && arr.length !== cfg.dimension) throw dimFail(arr.length)
        return arr
      })
    } catch (e) {
      if (e instanceof AppError) throw e
      const mapped = mapFetchError(e, logger, tags, timedOut)
      throw (
        mapped ?? new AppError({ code: 'UNKNOWN', severity: 'error', retryable: false, cause: e })
      )
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async embed(text) {
      const [v] = await embedBatch([text])
      return v
    },
    embedBatch
  }
}

// === 模型变更检测（启动比对，F5-003）===

export type EmbeddingModelStatus =
  | { status: 'fresh' }
  | { status: 'ok' }
  | { status: 'changed'; storedModel: string; storedDim: number }

/**
 * 比对 vec_meta.embeddingModel/dim 与当前配置。
 * - 无记录（首次）→ 写入 model + dim，返回 fresh。
 * - 一致 → ok。
 * - 不一致 → 告警 + 返回 changed（Phase 2 阻止新旧混算；后台重嵌入是 Phase 4）。不覆盖存储值。
 */
export function verifyEmbeddingModel(
  db: Database,
  model: string,
  dim: number,
  logger?: Logger
): EmbeddingModelStatus {
  const get = db.prepare(`SELECT value FROM vec_meta WHERE key = ?`)
  const set = db.prepare(
    `INSERT INTO vec_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
  const storedModel = (get.get('embeddingModel') as { value: string } | undefined)?.value
  const storedDimRaw = (get.get('dim') as { value: string } | undefined)?.value
  const storedDim = storedDimRaw ? parseInt(storedDimRaw, 10) : undefined

  if (storedModel === undefined) {
    set.run('embeddingModel', model)
    if (storedDimRaw === undefined) set.run('dim', String(dim))
    return { status: 'fresh' }
  }
  if (storedModel === model && (storedDim === undefined || storedDim === dim)) {
    return { status: 'ok' }
  }
  logger?.warn(
    'embedding model/dim changed; blocking mixed-space retrieval until re-embed (Phase 4)',
    {
      scope: 'memory',
      code: 'MEM_EMBED_FAIL',
      tags: { storedModel, newModel: model },
      metrics: { storedDim: storedDim ?? -1, newDim: dim }
    }
  )
  return { status: 'changed', storedModel, storedDim: storedDim ?? 0 }
}
