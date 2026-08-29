// src/shared/live2d/types.ts
// P3A-08：模型元数据与公开错误 DTO 的唯一真源。
//
// main 保存真实路径/hash，renderer 只见 modelId、显示元数据和 main 受控资源 URL；绝不让
// 用户模型绝对路径越过 IPC。七个错误码固定，UI 根据 suggestedAction 给恢复入口。

/** 本项目需要主动控制的标准 Cubism 参数；main 验证与 stage renderer 共用。 */
export const LIVE2D_PARAMETER_IDS = {
  mouthOpen: 'ParamMouthOpenY',
  eyeLeftOpen: 'ParamEyeLOpen',
  eyeRightOpen: 'ParamEyeROpen',
  eyeBallX: 'ParamEyeBallX',
  eyeBallY: 'ParamEyeBallY',
  breath: 'ParamBreath'
} as const

export type Live2DStandardParameterId =
  (typeof LIVE2D_PARAMETER_IDS)[keyof typeof LIVE2D_PARAMETER_IDS]

export type Live2dSemanticEmotion =
  'neutral' | 'smile' | 'happy' | 'surprised' | 'sad' | 'angry' | 'shy' | 'confused'

export const LIVE2D_LOAD_ERROR_CODES = [
  'FILE_NOT_FOUND',
  'MOC3_NOT_FOUND',
  'MODEL_JSON_INVALID',
  'WEBGL_UNSUPPORTED',
  'TEXTURE_TOO_LARGE',
  'CUBISM_PARSE_ERROR',
  'TEXTURE_UPLOAD_FAILED'
] as const

export type Live2dLoadErrorCode = (typeof LIVE2D_LOAD_ERROR_CODES)[number]

export interface Live2dLoadError {
  readonly code: Live2dLoadErrorCode
  readonly retryable: boolean
  readonly suggestedAction: 'retry' | 'choose-model' | 'use-default' | 'update-driver'
}

export interface Live2dModelManifest {
  readonly id: string
  readonly displayName: string
  readonly source: 'builtin' | 'user'
  readonly cubismVersion: number
  readonly modelJsonFile: string
  readonly mocFile: string
  readonly textureFiles: readonly string[]
  readonly physicsFile: string | null
  readonly expressionNames: readonly string[]
  readonly motionGroups: Readonly<Record<string, number>>
  readonly parameterIds: readonly string[]
  readonly hasMouthOpen: boolean
  readonly warnings: readonly string[]
}

/** main-only discovered candidate；absolutePath 永不写进 public snapshot/IPC。 */
export interface Live2dModelCandidate {
  readonly manifest: Live2dModelManifest
  readonly modelDirectory: string
  readonly modelJsonPath: string
  readonly referencedFiles: readonly string[]
}

export interface Live2dValidationResult {
  readonly ok: boolean
  readonly errors: readonly Live2dLoadError[]
  readonly warnings: readonly string[]
}

export interface Live2dModelListItem {
  readonly id: string
  readonly displayName: string
  readonly source: 'builtin' | 'user'
  readonly cubismVersion: number
  readonly expressionCount: number
  readonly motionCount: number
  readonly hasMouthOpen: boolean
  readonly warnings: readonly string[]
}

export function toLive2dModelListItem(manifest: Live2dModelManifest): Live2dModelListItem {
  return {
    id: manifest.id,
    displayName: manifest.displayName,
    source: manifest.source,
    cubismVersion: manifest.cubismVersion,
    expressionCount: manifest.expressionNames.length,
    motionCount: Object.values(manifest.motionGroups).reduce((total, count) => total + count, 0),
    hasMouthOpen: manifest.hasMouthOpen,
    warnings: manifest.warnings
  }
}
