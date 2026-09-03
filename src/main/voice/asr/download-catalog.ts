// src/main/voice/asr/download-catalog.ts
// P3V-01：ASR 模型的下载来源与运行时装配规格（**main-only**）。
//
// 为什么与 shared 的 `asr-catalog.ts` 分家：URL、逐文件 sha256、编码器/解码器
// 文件名都是下载与原生装配的实现细节，renderer 一个都不需要，也不该拿到
// （P3B-09 红线：DTO 不含任意文件路径）。shared 那份只有展示元数据。
//
// 完整性纪律（S-023 §1.3）：新模型一律**下载前钉死** Hugging Face 不可变
// commit + 逐文件字节数 + sha256。P3B 的两个归档资产仍是「体积粗检 + 下载后
// 自证 sha256」的旧口径——它们指向 GitHub Release 的固定 tag 资产，本轮不动，
// 但新增路径不许再用那个较弱的口径。
//
// 数据来源与核验（2026-09-02）：逐文件字节数与 sha256 取自 sherpa-onnx 官方
// 上传者 csukuangfj 的 Hugging Face 仓库指定 commit；四个新模型的逐文件之和
// 与 shared 目录声明的 downloadBytes 完全一致（download-catalog.test.ts 断言）。

import type { AsrEngineId } from '@shared/voice/asr-settings-types'

/** 单个待下载文件（多文件直下路径）。 */
export interface AsrDownloadFile {
  /** 落盘文件名（= 上游文件名，不改名；运行时装配按名索引）。 */
  readonly name: string
  readonly url: string
  readonly bytes: number
  /** 下载前就已知的期望摘要；不匹配 = hash-mismatch，直接丢弃 .part。 */
  readonly sha256: string
}

/**
 * 下载来源。
 * - `archive`：P3B 旧口径，单个 tar.bz2 解压后取两个文件。
 * - `files`：P3V 新口径，多个裸文件直下，逐文件校验。
 */
export type AsrDownloadSource =
  | {
      readonly kind: 'archive'
      readonly archiveUrl: string
      readonly archiveBytes: number
      /** 归档内的模型文件名（解压后按名查找）。 */
      readonly modelFile: string
      readonly tokensFile: string
    }
  | {
      readonly kind: 'files'
      readonly files: readonly AsrDownloadFile[]
    }

/**
 * 原生识别器装配规格。文件名字段是**安装目录内的相对文件名**，
 * 由绑定层拼成绝对路径；绝不出现在任何 DTO 里。
 */
export type AsrRuntimeSpec =
  | {
      readonly kind: 'offline-sense-voice'
      readonly modelFile: string
      readonly tokensFile: string
    }
  | {
      readonly kind: 'offline-paraformer'
      readonly modelFile: string
      readonly tokensFile: string
    }
  | {
      readonly kind: 'offline-transducer'
      readonly encoderFile: string
      readonly decoderFile: string
      readonly joinerFile: string
      readonly tokensFile: string
    }
  | {
      readonly kind: 'online-transducer'
      readonly encoderFile: string
      readonly decoderFile: string
      readonly joinerFile: string
      readonly tokensFile: string
      /** sherpa OnlineModelConfig.modelingUnit；中文模型必须给对，否则解码乱码。 */
      readonly modelingUnit?: string
      /** cjkchar+bpe 需要 bpe.vocab；缺它 zipformer 双语模型无法正确切分英文。 */
      readonly bpeVocabFile?: string
    }
  | {
      readonly kind: 'online-paraformer'
      readonly encoderFile: string
      readonly decoderFile: string
      readonly tokensFile: string
    }

export interface AsrEngineDownloadEntry {
  readonly engineId: AsrEngineId
  /** 安装子目录名（{modelsRoot}/{dirName}/…）；每引擎独占，互不共享文件。 */
  readonly dirName: string
  readonly source: AsrDownloadSource
  readonly runtime: AsrRuntimeSpec
  /** true = 走流式会话 ABI；false = 走冻结的离线 AsrEngine ABI。 */
  readonly streaming: boolean
}

/** Hugging Face 不可变 revision 直链（与 Orca 同款 URL 形状）。 */
function huggingFaceFile(
  repository: string,
  revision: string,
  name: string,
  bytes: number,
  sha256: string
): AsrDownloadFile {
  return {
    name,
    url: `https://huggingface.co/${repository}/resolve/${revision}/${encodeURIComponent(name)}?download=true`,
    bytes,
    sha256
  }
}

const ZIPFORMER_BILINGUAL_REPO =
  'csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20'
const ZIPFORMER_BILINGUAL_REV = '98590b7ed6443e77b714204da2757d75e1a642f4'

const PARAFORMER_BILINGUAL_REPO = 'csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en'
const PARAFORMER_BILINGUAL_REV = '8e40c43232a1c5c66c82111efc5820d3accca11b'

const ZIPFORMER_ZH_14M_REPO = 'csukuangfj/sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23'
const ZIPFORMER_ZH_14M_REV = '204ad334e2e683fd295359930cc16fc0432a23ac'

const PARAKEET_V2_REPO = 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8'
const PARAKEET_V2_REV = '1ab9323565ddb038682214b292f588070a538ce2'

/**
 * 6 个引擎的下载与装配规格。
 * key 是 AsrEngineId，`Record` 保证漏一个就 typecheck 失败。
 */
export const ASR_ENGINE_DOWNLOAD_CATALOG: Readonly<Record<AsrEngineId, AsrEngineDownloadEntry>> =
  Object.freeze({
    // ── P3B 既有：归档下载，模型文件在 model-store 归一为 model.onnx / tokens.txt ──
    'sherpa-sensevoice': {
      engineId: 'sherpa-sensevoice',
      dirName: 'sense-voice',
      streaming: false,
      source: {
        kind: 'archive',
        archiveUrl:
          'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2',
        archiveBytes: 163_002_883,
        modelFile: 'model.int8.onnx',
        tokensFile: 'tokens.txt'
      },
      runtime: { kind: 'offline-sense-voice', modelFile: 'model.onnx', tokensFile: 'tokens.txt' }
    },
    'funasr-paraformer': {
      engineId: 'funasr-paraformer',
      dirName: 'paraformer',
      streaming: false,
      source: {
        kind: 'archive',
        archiveUrl:
          'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-2023-09-14.tar.bz2',
        archiveBytes: 234_051_698,
        modelFile: 'model.int8.onnx',
        tokensFile: 'tokens.txt'
      },
      runtime: { kind: 'offline-paraformer', modelFile: 'model.onnx', tokensFile: 'tokens.txt' }
    },

    // ── P3V 新增：Hugging Face 多文件直下，逐文件 sha256 ──
    'zipformer-bilingual-zh-en': {
      engineId: 'zipformer-bilingual-zh-en',
      dirName: 'zipformer-bilingual',
      streaming: true,
      source: {
        kind: 'files',
        files: [
          huggingFaceFile(
            ZIPFORMER_BILINGUAL_REPO,
            ZIPFORMER_BILINGUAL_REV,
            'encoder-epoch-99-avg-1.onnx',
            330_083_505,
            '709f0ed53a734b7942f170127e7547b566cb29c4afc5e67719f314c3d63ccb10'
          ),
          huggingFaceFile(
            ZIPFORMER_BILINGUAL_REPO,
            ZIPFORMER_BILINGUAL_REV,
            'decoder-epoch-99-avg-1.onnx',
            13_876_452,
            '2e3b5ec371f8899ee6acd829fd753ba45772df57a91bdf37cde3136354e7db7d'
          ),
          huggingFaceFile(
            ZIPFORMER_BILINGUAL_REPO,
            ZIPFORMER_BILINGUAL_REV,
            'joiner-epoch-99-avg-1.onnx',
            12_833_618,
            '5f2adc585dd1bec6421c8bb8660d2a73fc8b9ceb24491ef51399ba2a2f0fc31b'
          ),
          huggingFaceFile(
            ZIPFORMER_BILINGUAL_REPO,
            ZIPFORMER_BILINGUAL_REV,
            'tokens.txt',
            56_317,
            'a8e0e4ec53810e433789b54a5c0134a7eaa2ffca595a6334d54c00da858841d3'
          ),
          huggingFaceFile(
            ZIPFORMER_BILINGUAL_REPO,
            ZIPFORMER_BILINGUAL_REV,
            'bpe.vocab',
            12_564,
            'd0b642f3a2eacd5fadefdeff9e0e1358cab729647cbb7fe58cf738e1f7407029'
          )
        ]
      },
      runtime: {
        kind: 'online-transducer',
        encoderFile: 'encoder-epoch-99-avg-1.onnx',
        decoderFile: 'decoder-epoch-99-avg-1.onnx',
        joinerFile: 'joiner-epoch-99-avg-1.onnx',
        tokensFile: 'tokens.txt',
        modelingUnit: 'cjkchar+bpe',
        bpeVocabFile: 'bpe.vocab'
      }
    },
    'paraformer-bilingual-zh-en': {
      engineId: 'paraformer-bilingual-zh-en',
      dirName: 'paraformer-bilingual',
      streaming: true,
      source: {
        kind: 'files',
        files: [
          huggingFaceFile(
            PARAFORMER_BILINGUAL_REPO,
            PARAFORMER_BILINGUAL_REV,
            'encoder.int8.onnx',
            165_462_184,
            '81a70226a8934e6ed92aa1d4fc486b428b5398e2f2619ed4897b7294cab90e9a'
          ),
          huggingFaceFile(
            PARAFORMER_BILINGUAL_REPO,
            PARAFORMER_BILINGUAL_REV,
            'decoder.int8.onnx',
            71_664_561,
            'f3cca9f77bb9d93c8fcbfb63ae617b6b1ee96818df3aa3b151c40658fe38594f'
          ),
          huggingFaceFile(
            PARAFORMER_BILINGUAL_REPO,
            PARAFORMER_BILINGUAL_REV,
            'tokens.txt',
            75_756,
            '59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6'
          )
        ]
      },
      runtime: {
        kind: 'online-paraformer',
        encoderFile: 'encoder.int8.onnx',
        decoderFile: 'decoder.int8.onnx',
        tokensFile: 'tokens.txt'
      }
    },
    'zipformer-streaming-zh-14m': {
      engineId: 'zipformer-streaming-zh-14m',
      dirName: 'zipformer-zh-14m',
      streaming: true,
      source: {
        kind: 'files',
        files: [
          huggingFaceFile(
            ZIPFORMER_ZH_14M_REPO,
            ZIPFORMER_ZH_14M_REV,
            'encoder-epoch-99-avg-1.onnx',
            40_948_171,
            '84c6a8f372686faa5b8f45f2d79f0816f76dcd9f547acb9a90eba2772d7eda8b'
          ),
          huggingFaceFile(
            ZIPFORMER_ZH_14M_REPO,
            ZIPFORMER_ZH_14M_REV,
            'decoder-epoch-99-avg-1.onnx',
            7_509_745,
            '5ee0f03a2768ff1d5c83ef3a493243c7935d316cd41280037b14783a3467cc78'
          ),
          huggingFaceFile(
            ZIPFORMER_ZH_14M_REPO,
            ZIPFORMER_ZH_14M_REV,
            'joiner-epoch-99-avg-1.onnx',
            7_109_975,
            '030212efaea9a8b6a4fa98faf6ac6055529c4408cf4865e898220ddd02780f34'
          ),
          huggingFaceFile(
            ZIPFORMER_ZH_14M_REPO,
            ZIPFORMER_ZH_14M_REV,
            'tokens.txt',
            48_697,
            '8b294db9045d6e5f94647f4c1eec1af4da143a75053c399611444b378ff966ac'
          )
        ]
      },
      runtime: {
        kind: 'online-transducer',
        encoderFile: 'encoder-epoch-99-avg-1.onnx',
        decoderFile: 'decoder-epoch-99-avg-1.onnx',
        joinerFile: 'joiner-epoch-99-avg-1.onnx',
        tokensFile: 'tokens.txt',
        modelingUnit: 'cjkchar'
      }
    },
    'parakeet-tdt-v2': {
      engineId: 'parakeet-tdt-v2',
      dirName: 'parakeet-tdt-v2',
      streaming: false,
      source: {
        kind: 'files',
        files: [
          huggingFaceFile(
            PARAKEET_V2_REPO,
            PARAKEET_V2_REV,
            'encoder.int8.onnx',
            652_184_296,
            'a32b12d17bbbc309d0686fbbcc2987b5e9b8333a7da83fa6b089f0a2acd651ab'
          ),
          huggingFaceFile(
            PARAKEET_V2_REPO,
            PARAKEET_V2_REV,
            'decoder.int8.onnx',
            7_257_753,
            'b6bb64963457237b900e496ee9994b59294526439fbcc1fecf705b31a15c6b4e'
          ),
          huggingFaceFile(
            PARAKEET_V2_REPO,
            PARAKEET_V2_REV,
            'joiner.int8.onnx',
            1_739_080,
            '7946164367946e7f9f29a122407c3252b680dbae9a51343eb2488d057c3c43d2'
          ),
          huggingFaceFile(
            PARAKEET_V2_REPO,
            PARAKEET_V2_REV,
            'tokens.txt',
            9_384,
            'ec182b70dd42113aff6c5372c75cac58c952443eb22322f57bbd7f53977d497d'
          )
        ]
      },
      runtime: {
        kind: 'offline-transducer',
        encoderFile: 'encoder.int8.onnx',
        decoderFile: 'decoder.int8.onnx',
        joinerFile: 'joiner.int8.onnx',
        tokensFile: 'tokens.txt'
      }
    }
  })

/** 引擎安装子目录名（engine-manager / model-store 共用，避免各写一份映射）。 */
export function asrEngineDirName(engineId: AsrEngineId): string {
  return ASR_ENGINE_DOWNLOAD_CATALOG[engineId].dirName
}

/** 该引擎是否走流式会话 ABI。 */
export function isStreamingAsrEngine(engineId: AsrEngineId): boolean {
  return ASR_ENGINE_DOWNLOAD_CATALOG[engineId].streaming
}

/**
 * 安装后该引擎目录内必须齐全的文件名清单（model-store 的存在性/校验依据）。
 * 归档口径返回 model-store 的归一名，多文件口径返回上游原名。
 */
export function asrEngineRequiredFiles(engineId: AsrEngineId): readonly string[] {
  const runtime = ASR_ENGINE_DOWNLOAD_CATALOG[engineId].runtime
  switch (runtime.kind) {
    case 'offline-sense-voice':
    case 'offline-paraformer':
      return [runtime.modelFile, runtime.tokensFile]
    case 'offline-transducer':
      return [runtime.encoderFile, runtime.decoderFile, runtime.joinerFile, runtime.tokensFile]
    case 'online-transducer':
      return runtime.bpeVocabFile === undefined
        ? [runtime.encoderFile, runtime.decoderFile, runtime.joinerFile, runtime.tokensFile]
        : [
            runtime.encoderFile,
            runtime.decoderFile,
            runtime.joinerFile,
            runtime.tokensFile,
            runtime.bpeVocabFile
          ]
    case 'online-paraformer':
      return [runtime.encoderFile, runtime.decoderFile, runtime.tokensFile]
  }
}

/** 下载总字节数（归档 = 归档体积；多文件 = 逐文件之和）。 */
export function asrEngineDownloadBytes(engineId: AsrEngineId): number {
  const source = ASR_ENGINE_DOWNLOAD_CATALOG[engineId].source
  return source.kind === 'archive'
    ? source.archiveBytes
    : source.files.reduce((sum, file) => sum + file.bytes, 0)
}
