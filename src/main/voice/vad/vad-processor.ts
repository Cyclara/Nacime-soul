// src/main/voice/vad/vad-processor.ts
// P3B-12：VAD 组合件——Int16 chunk 进，三态机事件出。
//
// 职责（P3B-13 麦克风管线 / P3B-18 orchestrator 的直接依赖）：
//   1. 把 16k/mono/s16le 的 Int16 chunk 按 VAD_WINDOW_SAMPLES（512）切窗；
//      尾部不足一窗的样本**丢弃**（与参考实现一致：Silero 只吃整窗）。
//   2. 每窗：Int16→Float32（÷32768）喂 Silero，读 isDetected() 作 prob（0/1）；
//      RMS 算 int16 尺度 db；喂三态机。
//   3. 每窗后排空原生分段队列（防内存增长，见 silero-binding.ts 头注释）。
//   4. 对每个保留的窗做防御性拷贝再交给状态机（状态机持有引用；调用方可能
//      复用/传输底层 buffer，别名会污染话语缓冲）。
//
// 事件语义：processChunk 返回本 chunk 内产生的全部事件（生产 chunk=512 时
// 至多一个）；flush 在会话停止时冲刷未完话语。

import {
  computeChunkDb,
  createVadStateMachine,
  VAD_WINDOW_SAMPLES,
  type VadEvent,
  type VadState,
  type VadStateMachine
} from './vad'
import type { SileroVadRecognizer } from './silero-binding'

export interface VadProcessor {
  readonly state: VadState
  /** 喂一个 Int16 chunk（16k/mono/s16le），返回期间产生的事件（通常为空数组）。 */
  processChunk(chunk: Int16Array): VadEvent[]
  /** 非 IDLE 时结束当前话语（reason='flush'）。 */
  flush(): VadEvent | null
  /** 硬复位（含原生 recognizer）。 */
  reset(): void
  /** 丢弃引用（含原生 recognizer）。 */
  close(): void
}

export interface VadProcessorDeps {
  /** 已构造的原生 recognizer（由 SileroVadBinding.createVad 产出）。 */
  readonly recognizer: SileroVadRecognizer
  /** 注入自定义状态机（默认 createVadStateMachine()，测试用）。 */
  readonly machine?: VadStateMachine
}

export function createVadProcessor(deps: VadProcessorDeps): VadProcessor {
  const recognizer = deps.recognizer
  const machine = deps.machine ?? createVadStateMachine()
  let closed = false

  function ensureOpen(): void {
    if (closed) throw new Error('vad processor closed')
  }

  /** Int16 → Float32（[-1,1]，÷32768），新分配（原生可能持有引用）。 */
  function toFloat32(chunk: Int16Array): Float32Array {
    const out = new Float32Array(chunk.length)
    for (let i = 0; i < chunk.length; i++) {
      out[i] = chunk[i] / 32_768
    }
    return out
  }

  return {
    get state(): VadState {
      return machine.state
    },

    processChunk(chunk) {
      ensureOpen()
      const events: VadEvent[] = []
      for (
        let offset = 0;
        offset + VAD_WINDOW_SAMPLES <= chunk.length;
        offset += VAD_WINDOW_SAMPLES
      ) {
        const window = chunk.subarray(offset, offset + VAD_WINDOW_SAMPLES)
        recognizer.acceptWaveform(toFloat32(window))
        // 排空原生分段队列：分段由我们的三态机负责，原生段不 pop 会无限累积
        while (!recognizer.isEmpty()) {
          recognizer.pop()
        }
        const prob = recognizer.isDetected() ? 1 : 0
        const db = computeChunkDb(window)
        const event = machine.process({ prob, db }, window.slice())
        if (event !== null) events.push(event)
      }
      return events
    },

    flush() {
      ensureOpen()
      return machine.flush()
    },

    reset() {
      ensureOpen()
      machine.reset()
      recognizer.reset()
    },

    close() {
      if (closed) return
      closed = true
      machine.reset()
      recognizer.close()
    }
  }
}
