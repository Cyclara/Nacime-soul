// src/main/memory/vector/types.ts
// VectorStore 合同类型 + IVF 策略常量。照抄 F5-003 §3，不得改动数值。
// 核心逻辑不 import 'electron'（决策 #14）。

/** 向量检索命中 */
export interface VectorSearchHit {
  memoryId: string
  /** 余弦相似度 [-1, 1]，按 f32 计算 */
  score: number
}

export interface VectorStoreStats {
  count: number
  dim: number
  dtype: 'f32' | 'f16'
  indexKind: 'flat' | 'ivf'
  K?: number
  nprobe?: number
  lastBuildAt?: number
  /** 内存矩阵占用字节数 */
  memBytes: number
}

/**
 * 向量存储接口。SQLiteVectorStore 为唯一实现；
 * 未来切换后端 = 新增实现类，调用方零改动。
 */
export interface VectorStore {
  /** 启动加载：读全部 BLOB → 解码 → 内存矩阵 */
  init(): Promise<void>
  /** 写入/更新一条向量（事务内与 L2 元数据同 commit，由调用方保证；应为事务最后一步） */
  upsert(memoryId: string, embedding: Float32Array): void
  remove(memoryId: string): void
  /**
   * top-k 检索。索引未就绪时自动走暴力扫描（败而不崩）。
   * @param minScore 低于该分数的命中被丢弃（默认 0.35）
   */
  search(query: Float32Array, k: number, minScore?: number): VectorSearchHit[]
  count(): number
  /** 跨进程同步用的修订号：每次写 +1 */
  revision(): number
  /** 强制重建 IVF（设置页"重建索引"按钮用；flat 阶段为 no-op） */
  rebuildIndex(force?: boolean): void
  stats(): VectorStoreStats
}

/** IVF 策略常量（照搬 Cyrene-Agent 实测值 + 启用门槛修正）。P2-14/15 使用。 */
export const IVF_POLICY = {
  /** 低于此数量不建索引，暴力扫描 */
  minEntries: 1_000,
  /** K = max(2, min(512, round(√n / 2))) */
  K: (n: number): number => Math.max(2, Math.min(512, Math.round(Math.sqrt(n) / 2))),
  /** nprobe = max(2, round(K / 8)) */
  nprobe: (K: number): number => Math.max(2, Math.round(K / 8)),
  /** 重建触发：自上次构建起增删条数 ≥ max(500, 20%·n) */
  rebuildDrift: (n: number): number => Math.max(500, Math.round(n * 0.2)),
  /** kmeans 最大迭代 */
  maxIterations: 10
} as const
