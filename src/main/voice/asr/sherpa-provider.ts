// src/main/voice/asr/sherpa-provider.ts
// P3B-10：Sherpa ONNX + SenseVoice 默认 ASR adapter（全本地，CPU-only）。
// P3B-11：抽出共用离线引擎工厂 createSherpaOfflineEngine--FunASR Paraformer
// 备用 adapter（funasr-provider.ts）是同一工厂的 paraformer 配置，零网络。
//
// 实现 @shared/voice/asr-types 的 AsrEngine：
//   - 状态机 not-downloaded/downloading/ready/error；busy 态（校验+原生构造）合并
//     报 'downloading' + onProgress 0..1（模型 hash 校验是进度大头）。
//   - loadModel：discover（缺 -> 'model-missing'）-> validate（坏 -> 'model-corrupt'）
//     -> 原生构造（败 -> 'engine-init-failed'）。ready 后幂等。
//   - recognize：输入合同检查（空/超界 -> 'audio-invalid'；不截断后继续）；
//     Int16 -> Float32（÷32768）喂原生；输出按共享合同自检（超界文本/段数 ->
//     'recognize-failed'，不把坏结果交给上层）。非 ready -> 'engine-busy'。
//   - 错误一律 AsrEngineError（code 枚举进状态投影；message 只进 main 日志）。
//
// S-004：测试注入假 binding + 临时目录假模型文件，不加载真模型、不发声。
// 断网可用性由构造保证：本 adapter 无任何网络调用（全本地红线，审计裁定 3）。

import type { AsrEngine } from '@shared/voice/asr-types'
import { createOfflineEngineCore } from './offline-engine-core'
import type { AsrModelStore } from './model-store'
import type { SherpaOfflineBinding, SherpaOfflineModelKind } from './sherpa-binding'

/** 引擎注册表 id（进 AsrModelStatus.engineId；非路径）。 */
export const SHERPA_SENSEVOICE_ENGINE_ID = 'sherpa-sensevoice'

/** CPU-only 单线程：与 GPT-SoVITS GPU 零冲突；提速调参属后续校准，不开放注入。 */
const SHERPA_NUM_THREADS = 1

/**
 * 共用离线引擎工厂（P3B-11 抽出）：SenseVoice（默认）与 FunASR Paraformer（备用）
 * 共享全部状态机/合同检查/错误映射；差异只在 engineId、modelKind 与模型目录
 * （modelStore 由调用方按 dirName 构造）。
 *
 * P3V-08 起状态机本体搬进 offline-engine-core（Parakeet 是三件套模型，
 * 塞不进本函数的两文件参数形状）；本函数只剩「两文件 store + 单 model 识别器」
 * 这一种装配方式的绑线。对外签名与行为不变。
 */
export function createSherpaOfflineEngine(deps: {
  binding: SherpaOfflineBinding
  modelStore: AsrModelStore
  engineId: string
  modelKind: SherpaOfflineModelKind
}): AsrEngine {
  const { binding, modelStore, engineId, modelKind } = deps
  return createOfflineEngineCore({
    engineId,
    discoverFiles: () => modelStore.discover(),
    validateFiles: (files, onProgress) => modelStore.validate(files, onProgress),
    buildRecognizer: (files) =>
      binding.createRecognizer({
        modelKind,
        modelPath: files.modelPath,
        tokensPath: files.tokensPath,
        language: '', // sense-voice 引擎级 auto（paraformer 忽略此字段）
        numThreads: SHERPA_NUM_THREADS
      })
  })
}

/** 默认引擎：SenseVoice（P3B-10）。 */
export function createSherpaSenseVoiceEngine(deps: {
  binding: SherpaOfflineBinding
  modelStore: AsrModelStore
}): AsrEngine {
  return createSherpaOfflineEngine({
    ...deps,
    engineId: SHERPA_SENSEVOICE_ENGINE_ID,
    modelKind: 'sense-voice'
  })
}
