// src/main/memory/vector/ivf-worker.ts
// IVF kmeans++ worker_thread 入口。依据 F5-003 §5 红线：
//   "不要让 kmeans 跑在主线程--必须 worker_thread"
//
// worker 接收 { vectors, dim, K, maxIterations, seed }，在独立线程跑 kmeans++，
// 返回 { centroids, assignments, K, dim }。
// 矩阵用 transferable Float32Array 传递，零拷贝。
//
// worker 只 import 纯函数（ivf.ts + cosine.ts），不依赖 better-sqlite3 / electron。

import { parentPort } from 'node:worker_threads'
import { buildIvfIndex, type IvfBuildResult } from './ivf'

interface WorkerRequest {
  vectors: Float32Array
  dim: number
  K: number
  maxIterations: number
  seed: number
}

if (!parentPort) {
  // 不在 worker 环境下运行（直接 node 执行本文件时）
  throw new Error('ivf-worker must be run as a worker_thread')
}

parentPort.on('message', (req: WorkerRequest): void => {
  const { vectors, dim, K, maxIterations, seed } = req
  try {
    const result = buildIvfIndex({ vectors, dim, K, maxIterations, seed })
    const response: IvfBuildResult = result
    // transferable：centroids 和 assignments 的底层 buffer 零拷贝转移回主线程
    parentPort!.postMessage(response, [
      result.centroids.buffer as ArrayBuffer,
      result.assignments.buffer as ArrayBuffer
    ])
  } catch (err) {
    // worker 内异常不阻塞主线程，通过 error 字段传递
    parentPort!.postMessage({
      error: err instanceof Error ? err.message : String(err)
    })
  }
})
