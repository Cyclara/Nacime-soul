// src/main/voice/asr/funasr-provider.ts
// P3B-11：FunASR Paraformer 备用 ASR adapter（全本地，CPU-only）。
//
// **反模式红线（任务行明示）：备用实现绝不允许写成网络 API**--FunASR 官方有云
// 服务，本 adapter 走的是本地 sherpa-onnx 离线推理（`modelConfig.paraformer`），
// 零网络调用；`localOnly: true` 由共用工厂冻结（审计裁定 3：语音永不发外部）。
//
// 与默认引擎的关系（S-Phase3 P3B-11）：
//   - 同一 AsrEngine ABI（P3B-09 冻结）：编排层/store/UI 对两引擎无差别。
//   - **仅用户显式选择，不自动切换**：引擎选择是用户配置（P3B-14 设置 UI 落地；
//     配置键随语音设置任务走账本流程）。Sherpa 失败绝不静默回落到 FunASR--
//     与 TTS 的「失败退纯文字」不同，ASR 引擎切换是显式用户决策（模型体积
//     500MB/1.5GB 级、CPU/内存代价不同，自动切换会静默吃掉用户资源）。
//   - **切换需重启子系统**：切换 = 丢弃旧引擎实例（recognizer 等原生资源）+ 新
//     引擎走完整 loadModel（'downloading' + 进度）；两个引擎不得同时在内存中
//     持有 recognizer。管理器（P3B-18 组合根）负责执行，本模块只保证引擎可弃。
//   - 模型资产（int8/large 精度选择）是下载器（P3B-14）的关注点；本 adapter
//     只认 {root}/paraformer/ 目录里的 model.onnx + tokens.txt（+可选 manifest）。
//   - Paraformer-zh 是中文模型：语言提示 advisory 忽略（共享 ABI 注明引擎可忽略）。

import type { AsrEngine } from '@shared/voice/asr-types'
import { createAsrModelStore, type AsrModelStore } from './model-store'
import { createSherpaOfflineEngine } from './sherpa-provider'
import type { SherpaOfflineBinding } from './sherpa-binding'

/** 引擎注册表 id（进 AsrModelStatus.engineId；非路径）。 */
export const FUNASR_PARAFORMER_ENGINE_ID = 'funasr-paraformer'

/** 备用引擎的模型子目录（与 sense-voice 互不共享模型文件）。 */
export function createFunasrModelStore(rootDir: string): AsrModelStore {
  return createAsrModelStore(rootDir, { dirName: 'paraformer' })
}

/** 备用引擎：FunASR Paraformer（P3B-11）。modelStore 用 createFunasrModelStore 构造。 */
export function createFunasrParaformerEngine(deps: {
  binding: SherpaOfflineBinding
  modelStore: AsrModelStore
}): AsrEngine {
  return createSherpaOfflineEngine({
    ...deps,
    engineId: FUNASR_PARAFORMER_ENGINE_ID,
    modelKind: 'paraformer'
  })
}
