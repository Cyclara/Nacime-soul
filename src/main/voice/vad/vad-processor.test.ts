// src/main/voice/vad/vad-processor.test.ts
// P3B-12：组合件合同——Int16 chunk 切窗、原生喂入与分段排空、防御性拷贝、
// flush/close/reset。用假 recognizer（脚本化 isDetected）驱动真三态机；
// 真原生件冒烟在 silero-vad-binding.test.ts。

import { describe, expect, it } from 'vitest'
import { createVadProcessor, type VadProcessor } from './vad-processor'
import type { SileroVadRecognizer } from './silero-binding'
import { VAD_WINDOW_SAMPLES, type VadEvent } from './vad'
import { makeSilentPcm16, makeSinePcm16 } from '../../../../tests/helpers/silent-pcm'

function makeFakeRecognizer(flags: boolean[] = []): {
  recognizer: SileroVadRecognizer
  accepted: Float32Array[]
  resetCount: { value: number }
  closeCount: { value: number }
  segments: { value: number }
  popped: { value: number }
} {
  const accepted: Float32Array[] = []
  const resetCount = { value: 0 }
  const closeCount = { value: 0 }
  const segments = { value: 0 }
  const popped = { value: 0 }
  const recognizer: SileroVadRecognizer = {
    acceptWaveform(samples) {
      accepted.push(samples)
    },
    isDetected() {
      // 第 k 次 accept 后返回 flags[k-1]（processor 每窗恰好 accept 一次再读）
      return flags[accepted.length - 1] ?? false
    },
    isEmpty() {
      return segments.value === 0
    },
    pop() {
      popped.value++
      segments.value = Math.max(0, segments.value - 1)
    },
    reset() {
      resetCount.value++
    },
    close() {
      closeCount.value++
    }
  }
  return { recognizer, accepted, resetCount, closeCount, segments, popped }
}

const SINE_CHUNK = (): Int16Array => makeSinePcm16(220, 32, 0.6) // 512 样本，db≈83
const SILENT_CHUNK = (): Int16Array => makeSilentPcm16(32) // 512 样本，db=-140

describe('P3B-12 processor：完整话语流（假 recognizer + 真三态机）', () => {
  it('有声 3 帧触发 start；48 帧静音后 speech_end(silence)，音频含全部 58 帧', () => {
    const fake = makeFakeRecognizer([...Array(12).fill(true)])
    const processor = createVadProcessor({ recognizer: fake.recognizer })
    const events: VadEvent[] = []

    for (let i = 0; i < 10; i++) {
      events.push(...processor.processChunk(SINE_CHUNK()))
    }
    expect(processor.state).toBe('active')

    for (let i = 0; i < 48; i++) {
      events.push(...processor.processChunk(SILENT_CHUNK()))
    }
    expect(events.map((e) => e.type)).toEqual(['speech_start', 'speech_end'])
    const end = events[1]
    if (end?.type !== 'speech_end') return
    expect(end.reason).toBe('silence')
    expect(processor.state).toBe('idle')
    // 前缓冲 3 + 话语 7 + 静音 48 = 58 窗 × 512 样本
    expect(end.audio.length).toBe(58 * VAD_WINDOW_SAMPLES)
  })

  it('flush：说话中冲刷未完话语', () => {
    const fake = makeFakeRecognizer([...Array(12).fill(true)])
    const processor = createVadProcessor({ recognizer: fake.recognizer })
    for (let i = 0; i < 6; i++) processor.processChunk(SINE_CHUNK())
    const event = processor.flush()
    expect(event?.type).toBe('speech_end')
    if (event?.type !== 'speech_end') return
    expect(event.reason).toBe('flush')
    expect(processor.state).toBe('idle')
  })
})

describe('P3B-12 processor：窗口切分与原生合同', () => {
  it('只喂整窗：640 样本 chunk 只 accept 一次 512 样本（尾部 128 丢弃）', () => {
    const fake = makeFakeRecognizer([true])
    const processor = createVadProcessor({ recognizer: fake.recognizer })
    const chunk = new Int16Array(640)
    chunk.set(SINE_CHUNK(), 0)
    chunk.fill(0, 512)
    const events = processor.processChunk(chunk)
    expect(fake.accepted).toHaveLength(1)
    expect(fake.accepted[0]!.length).toBe(VAD_WINDOW_SAMPLES)
    expect(events).toHaveLength(0) // 1 窗只够 hit1，不触发
  })

  it('Int16→Float32（÷32768）喂原生', () => {
    const fake = makeFakeRecognizer([true])
    const processor = createVadProcessor({ recognizer: fake.recognizer })
    processor.processChunk(SINE_CHUNK())
    const samples = fake.accepted[0]!
    expect(samples.length).toBe(VAD_WINDOW_SAMPLES)
    const maxAbs = Math.max(...samples.map(Math.abs))
    expect(maxAbs).toBeGreaterThan(0.5)
    expect(maxAbs).toBeLessThanOrEqual(1)
  })

  it('每窗后排空原生分段队列（防内存增长红线）', () => {
    const fake = makeFakeRecognizer([true, true, true, true])
    const processor = createVadProcessor({ recognizer: fake.recognizer })
    fake.segments.value = 3
    processor.processChunk(SINE_CHUNK())
    expect(fake.segments.value).toBe(0)
    expect(fake.popped.value).toBe(3)
  })

  it('防御性拷贝：前缓冲块在调用方改写后保持原值', () => {
    const fake = makeFakeRecognizer([...Array(20).fill(true)])
    const processor = createVadProcessor({ recognizer: fake.recognizer })
    for (let i = 0; i < 2; i++) processor.processChunk(SINE_CHUNK())
    const third = SINE_CHUNK()
    processor.processChunk(third) // 触发 speech_start，进前缓冲
    third.fill(0)
    for (let i = 0; i < 5; i++) processor.processChunk(SINE_CHUNK())
    const event = processor.flush()
    if (event?.type !== 'speech_end') throw new Error('expected speech_end')
    // 前缓冲第三块仍是正弦（非全零）
    const thirdWindow = event.audio.subarray(2 * VAD_WINDOW_SAMPLES, 3 * VAD_WINDOW_SAMPLES)
    expect(Math.max(...thirdWindow.map(Math.abs))).toBeGreaterThan(10_000)
  })
})

describe('P3B-12 processor：生命周期', () => {
  function makeProcessor(): {
    processor: VadProcessor
    fake: ReturnType<typeof makeFakeRecognizer>
  } {
    const fake = makeFakeRecognizer([...Array(12).fill(true)])
    return { processor: createVadProcessor({ recognizer: fake.recognizer }), fake }
  }

  it('reset：状态机与原生 recognizer 都复位', () => {
    const { processor, fake } = makeProcessor()
    for (let i = 0; i < 5; i++) processor.processChunk(SINE_CHUNK())
    expect(processor.state).toBe('active')
    processor.reset()
    expect(processor.state).toBe('idle')
    expect(fake.resetCount.value).toBe(1)
    expect(processor.flush()).toBeNull()
  })

  it('close 幂等；close 后 processChunk 抛错', () => {
    const { processor, fake } = makeProcessor()
    processor.close()
    processor.close()
    expect(fake.closeCount.value).toBe(1)
    expect(() => processor.processChunk(SINE_CHUNK())).toThrow()
    expect(() => processor.flush()).toThrow()
  })
})
