// src/main/voice/tts/gpt-runtime-catalog.ts
// P3V-16：GPT-SoVITS 官方 v2Pro 整合包目录（main-only——含 URL 与哈希，不出 main）。
//
// 事实核验（2026-09-03，全部实测）：
//   - HF 仓库 lj1995/GPT-SoVITS-windows-package 文件列表（hf-mirror API）：
//     GPT-SoVITS-v2pro-20250604.7z / GPT-SoVITS-v2pro-20250604-nvidia50.7z
//   - 两文件 Content-Length 与 handoff 钉死字节数逐一吻合（8,185,086,602 /
//     8,835,144,925）；SHA-256 用 handoff 2026-09-02 用户核验值（下载前预置，
//     下载后全量校验——不接受下载后自证）。
//   - 镜像三源均来自官方 GitHub release 20250606v2pro 正文：HF 主源、魔搭
//     （FlowerCry/gpt-sovits-7z-pacakges，官方 release 推荐）、hf-mirror.com；
//     三源实测 Range 206 可续传。所有镜像命中同一钉死 hash。
//   - 归档为 .7z；解压用 Windows 自带 bsdtar（System32\tar.exe，libarchive 3.8.4
//     实测支持 LZMA2/bzip2 7z + 中文文件名），无需分发 7-Zip。
//   - 归档顶层目录名（用户已解压目录实测）：GPT-SoVITS-v2pro-20250604(-nvidia50)。
//
// 安装布局：{assetRoot}/gpt-sovits/ 直含 runtime/python.exe、api_v2.py、
// GPT_SoVITS/…（与 gpt-sovits-installation.validateCandidate 的期望一致——
// 无论是外部已有安装还是 Nacime 一键安装，验证与启动路径共用同一形状）。

export type GptRuntimeVariant = 'standard' | 'rtx50'

export interface GptRuntimePackage {
  readonly variant: GptRuntimeVariant
  /** UI 显示名。 */
  readonly displayName: string
  /** 归档文件名（.part 暂存与镜像 URL 共用）。 */
  readonly fileName: string
  /** 钉死的归档字节数（进度分母 + 完整性判定）。 */
  readonly bytes: number
  /** 钉死的归档 SHA-256（下载前预置；下载后全量校验）。 */
  readonly sha256: string
  /** 镜像 URL 列表（第一个为首选；失败按序回退；全部命中同一 hash）。 */
  readonly mirrors: readonly string[]
  /** 归档内顶层目录名（解压后取它作为安装根）。 */
  readonly archiveTopDir: string
}

const HF_BASE = 'https://huggingface.co/lj1995/GPT-SoVITS-windows-package/resolve/main'
const HF_MIRROR_BASE = 'https://hf-mirror.com/lj1995/GPT-SoVITS-windows-package/resolve/main'
const MODELSCOPE_BASE =
  'https://www.modelscope.cn/models/FlowerCry/gpt-sovits-7z-pacakges/resolve/master'

function mirrorUrls(fileName: string): readonly string[] {
  return [
    `${HF_BASE}/${fileName}`,
    `${MODELSCOPE_BASE}/${fileName}`,
    `${HF_MIRROR_BASE}/${fileName}`
  ]
}

export const GPT_RUNTIME_CATALOG: Readonly<Record<GptRuntimeVariant, GptRuntimePackage>> =
  Object.freeze({
    standard: Object.freeze({
      variant: 'standard',
      displayName: 'GPT-SoVITS v2Pro 标准版',
      fileName: 'GPT-SoVITS-v2pro-20250604.7z',
      bytes: 8_185_086_602,
      sha256: 'bd60d0796553ff05d8568136e199c13e0dc22ebe2ed24273134e34ed6f215cd6',
      mirrors: mirrorUrls('GPT-SoVITS-v2pro-20250604.7z'),
      archiveTopDir: 'GPT-SoVITS-v2pro-20250604'
    }),
    rtx50: Object.freeze({
      variant: 'rtx50',
      displayName: 'GPT-SoVITS v2Pro RTX 50 系版',
      fileName: 'GPT-SoVITS-v2pro-20250604-nvidia50.7z',
      bytes: 8_835_144_925,
      sha256: '97b4edcd451c42357db7e26e6c1c877ca5d85144fe97beaff6d7005d35bee008',
      mirrors: mirrorUrls('GPT-SoVITS-v2pro-20250604-nvidia50.7z'),
      archiveTopDir: 'GPT-SoVITS-v2pro-20250604-nvidia50'
    })
  })

/** 安装根目录名（资源根下）：{assetRoot}/gpt-sovits 直含 runtime/、api_v2.py。 */
export const GPT_RUNTIME_INSTALL_DIR_NAME = 'gpt-sovits'

/** 下载/解压暂存目录名（资源根下，点开头避免被当成安装）。 */
export const GPT_RUNTIME_PARTIAL_DIR_NAME = '.gpt-runtime-download'

/** Nacime 写入安装根的元数据文件（变体与安装时间；不动官方包任何文件）。 */
export const GPT_RUNTIME_META_FILE = '.nacime-runtime.json'

/**
 * 安装完整性 root marker（相对安装根；解压完成后逐一校验）。
 * 覆盖 handoff §7「runtime/python.exe、api_v2.py、配置和预训练资源」。
 */
export const GPT_RUNTIME_MARKERS: readonly string[] = Object.freeze([
  'runtime/python.exe',
  'api_v2.py',
  'GPT_SoVITS/configs/tts_infer.yaml',
  'GPT_SoVITS/pretrained_models'
])

/**
 * 安装前可用空间下限（handoff §7：干净运行核心 ≥15~16GB，建议检查约 20GB；
 * 峰值 = 归档 8GB + 解压 staging ≈16GB，不足时安装失败并清理 staging 不伤已有安装）。
 */
export const GPT_RUNTIME_MIN_FREE_BYTES = 20 * 1024 * 1024 * 1024

export function isGptRuntimeVariant(value: unknown): value is GptRuntimeVariant {
  return value === 'standard' || value === 'rtx50'
}
