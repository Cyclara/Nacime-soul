// src/main/live2d/model-validator.ts
// P3A-10：静态模型验证器。GPU/WebGL 上传检查留给 stage report；这里不初始化 WebGL。

import { statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type {
  Live2dLoadError,
  Live2dModelCandidate,
  Live2dValidationResult
} from '@shared/live2d/types'

export interface Live2dModelValidationLimits {
  readonly maxTextureBytes: number
  readonly maxTotalTextureBytes: number
  readonly maxResourceBytes: number
}

export const DEFAULT_LIVE2D_VALIDATION_LIMITS: Live2dModelValidationLimits = {
  // 仅做磁盘字节上限；实际纹理维度/GPU 约束由 stage 以 TEXTURE_TOO_LARGE/UPLOAD_FAILED 报回。
  maxTextureBytes: 64 * 1024 * 1024,
  maxTotalTextureBytes: 160 * 1024 * 1024,
  maxResourceBytes: 256 * 1024 * 1024
}

function error(
  code: Live2dLoadError['code'],
  retryable: boolean,
  suggestedAction: Live2dLoadError['suggestedAction']
): Live2dLoadError {
  return { code, retryable, suggestedAction }
}

function safeStat(path: string): { size: number; isFile: boolean } | null {
  try {
    const stat = statSync(path)
    return { size: stat.size, isFile: stat.isFile() }
  } catch {
    return null
  }
}

/**
 * 验证一个已被 discover 的 candidate。errors 全部是固定枚举，无 filesystem path/stack，
 * 可直接投影给 UI；warnings 带 manifest 的 mouth warning，不阻断 3a 渲染。
 */
export function validateLive2dModel(
  candidate: Live2dModelCandidate,
  limits: Live2dModelValidationLimits = DEFAULT_LIVE2D_VALIDATION_LIMITS
): Live2dValidationResult {
  const errors: Live2dLoadError[] = []
  const warnings = [...candidate.manifest.warnings]
  let totalResourceBytes = 0
  let totalTextureBytes = 0

  for (const resource of candidate.referencedFiles) {
    const absolute = resolve(candidate.modelDirectory, resource)
    const metadata = safeStat(absolute)
    if (metadata === null || !metadata.isFile) {
      errors.push(
        error(
          resource === candidate.manifest.mocFile ? 'MOC3_NOT_FOUND' : 'FILE_NOT_FOUND',
          true,
          'choose-model'
        )
      )
      continue
    }
    totalResourceBytes += metadata.size
    if (candidate.manifest.textureFiles.includes(resource)) {
      totalTextureBytes += metadata.size
      if (metadata.size > limits.maxTextureBytes) {
        errors.push(error('TEXTURE_TOO_LARGE', false, 'update-driver'))
      }
    }
  }

  if (totalTextureBytes > limits.maxTotalTextureBytes) {
    errors.push(error('TEXTURE_TOO_LARGE', false, 'update-driver'))
  }
  if (totalResourceBytes > limits.maxResourceBytes) {
    errors.push(error('TEXTURE_TOO_LARGE', false, 'choose-model'))
  }

  // discovered 入口名保留为 relative basename；任何非 .model3.json 都是内部输入损坏。
  if (!candidate.manifest.modelJsonFile.toLowerCase().endsWith('.model3.json')) {
    errors.push(error('MODEL_JSON_INVALID', false, 'choose-model'))
  }
  if (!candidate.manifest.mocFile.toLowerCase().endsWith('.moc3')) {
    errors.push(error('MOC3_NOT_FOUND', false, 'choose-model'))
  }
  if (candidate.manifest.textureFiles.length === 0) {
    errors.push(error('MODEL_JSON_INVALID', false, 'choose-model'))
  }
  if (basename(candidate.modelJsonPath).toLowerCase() === 'items_pinned_to_model.json') {
    errors.push(error('MODEL_JSON_INVALID', false, 'choose-model'))
  }

  const uniqueErrors = errors.filter(
    (entry, index) => errors.findIndex((other) => other.code === entry.code) === index
  )
  return { ok: uniqueErrors.length === 0, errors: uniqueErrors, warnings }
}
