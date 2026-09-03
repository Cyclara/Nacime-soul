// src/main/voice/asr/parakeet-provider.ts
// P3V-08：Parakeet TDT v2 离线英语引擎（encoder/decoder/joiner 三件套）。
//
// 与 SenseVoice / FunASR 的差别只有两点，其余（状态机、合同检查、错误映射）
// 走 offline-engine-core 的同一份实现：
//   1. 模型是四个文件（三件套 + tokens），用 AsrFileSetStore 而不是两文件 store；
//   2. 原生识别器走 createTransducerRecognizer 而不是 createRecognizer。
//
// 定位：**英语备用**。中文一律不要选它——它完全不认中文（目录里的
// limitation 已写明）。engine-manager 不会把它当默认，也不会自动回退到它。
//
// 全本地、CPU-only、零网络（审计裁定 3）。

import type { AsrEngine } from '@shared/voice/asr-types'
import { createOfflineEngineCore } from './offline-engine-core'
import type { AsrFileSetStore } from './model-store'
import type { SherpaOfflineTransducerBinding } from './sherpa-binding'
import { AsrEngineError } from './engine-error'
import type { AsrRuntimeSpec } from './download-catalog'

/** 引擎注册表 id（进 AsrModelStatus.engineId；非路径）。 */
export const PARAKEET_TDT_V2_ENGINE_ID = 'parakeet-tdt-v2'

/** CPU-only 单线程：口径同其余离线引擎，与 GPT-SoVITS（GPU）零冲突。 */
const PARAKEET_NUM_THREADS = 1

type OfflineTransducerRuntime = Extract<AsrRuntimeSpec, { kind: 'offline-transducer' }>

export function createParakeetEngine(deps: {
  binding: SherpaOfflineTransducerBinding
  modelStore: AsrFileSetStore
  runtime: OfflineTransducerRuntime
}): AsrEngine {
  const { binding, modelStore, runtime } = deps
  return createOfflineEngineCore({
    engineId: PARAKEET_TDT_V2_ENGINE_ID,
    discoverFiles: () => modelStore.discover(),
    validateFiles: (files, onProgress) => modelStore.validate(files, onProgress),
    buildRecognizer: (files) => {
      function pathOf(name: string): string {
        const path = files[name]
        if (path === undefined) {
          // discover 已保证四个文件齐全；走到这里说明 runtime 规格与下载清单
          // 对不上（download-catalog.test.ts 有断言挡这种配错）
          throw new AsrEngineError('model-corrupt', `missing model file: ${name}`)
        }
        return path
      }
      return binding.createTransducerRecognizer({
        encoderPath: pathOf(runtime.encoderFile),
        decoderPath: pathOf(runtime.decoderFile),
        joinerPath: pathOf(runtime.joinerFile),
        tokensPath: pathOf(runtime.tokensFile),
        numThreads: PARAKEET_NUM_THREADS
      })
    }
  })
}
