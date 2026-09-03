// src/renderer/public/voice/mic-worklet-processor.js
// P3B-13：麦克风 AudioWorklet 处理器——128 样本渲染量子 → 512 样本 s16le 帧。
//
// 部署形态：public 静态资产（dev 由 electron-vite 同源伺服；build 复制到
// out/renderer/voice/）。生产 file:// origin 下 addModule 的加载限制是
// P3B-20（packaged E2E）的显式验证项——若被 Chromium 拦截，后备方案是给
// CSP worker-src 增补 blob: 并改走 Blob URL（见 worklog 2026-09-01）。
//
// 双用途模块：导出的纯函数由 vitest 直接 import 测试（node 环境无
// AudioWorkletProcessor 全局，注册分支被 typeof 守卫跳过）；worklet 环境
// 加载时执行注册。逻辑与 src/shared/voice/mic-types.ts 的帧合同对齐：
// 每帧恰 512 样本（= VAD 窗口），Int16，[-1,1] 夹取后 ×32767 四舍五入。
//
// 零拷贝：每帧 postMessage 时 transfer 底层 ArrayBuffer（worklet→页面线程），
// 页面线程再 transfer 给 main 的专用 port——全链路不复制 PCM。

export const MIC_WORKLET_PROCESSOR_NAME = 'mic-frame-processor'
export const MIC_WORKLET_FRAME_SAMPLES = 512

/** Float32 块 → Int16 帧（[-1,1] 夹取 ×32767 四舍五入）。 */
export function floatToInt16Frame(input) {
  const out = new Int16Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const v = input[i] < -1 ? -1 : input[i] > 1 ? 1 : input[i]
    out[i] = Math.round(v * 32767)
  }
  return out
}

/** 帧累积器：任意尺寸 Float32 块进，凑满 512 样本出一帧（可能 0..N 帧）。 */
export function createMicFrameAccumulator(frameSamples = MIC_WORKLET_FRAME_SAMPLES) {
  let buffer = new Float32Array(frameSamples)
  let filled = 0
  return {
    push(block) {
      const frames = []
      let offset = 0
      while (offset < block.length) {
        const take = Math.min(block.length - offset, frameSamples - filled)
        buffer.set(block.subarray(offset, offset + take), filled)
        filled += take
        offset += take
        if (filled === frameSamples) {
          frames.push(floatToInt16Frame(buffer))
          buffer = new Float32Array(frameSamples)
          filled = 0
        }
      }
      return frames
    },
    reset() {
      buffer = new Float32Array(frameSamples)
      filled = 0
    }
  }
}

if (typeof AudioWorkletProcessor !== 'undefined') {
  class MicFrameProcessor extends AudioWorkletProcessor {
    constructor() {
      super()
      this.accumulator = createMicFrameAccumulator()
    }

    process(inputs) {
      const input = inputs[0] && inputs[0][0]
      if (input) {
        const frames = this.accumulator.push(input)
        for (const samples of frames) {
          this.port.postMessage({ type: 'mic-frame', samples }, [samples.buffer])
        }
      }
      return true
    }
  }
  registerProcessor(MIC_WORKLET_PROCESSOR_NAME, MicFrameProcessor)
}
