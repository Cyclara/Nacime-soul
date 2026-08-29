// src/main/live2d/model-service.ts
// P3A-11/12：内置模型注册、受控资源 URL 与确定性的加载降级链。
//
// 不把绝对路径、zip 来源或模型文件正文交给 renderer。stage 只收到 nacime-live2d:// URL；
// protocol handler 在 main 侧复查 modelId/相对路径后解析真实文件。

import { existsSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import {
  LIVE2D_LICENSE_FILE_NAME,
  LIVE2D_SAMPLE_TERMS_FILE_NAME,
  LIVE2D_CUBISM_CORE_NOTICE_FILE_NAME,
  BUILTIN_LIVE2D_MODEL_SPECS
} from './model-registry'
import type { Live2dLoadError, Live2dModelListItem } from '@shared/live2d/types'
import { discoverLive2dModel, isAllowedLive2dResourceFile } from './model-discovery'
import { validateLive2dModel } from './model-validator'
import type { Live2dModelRegistry, RegisteredLive2dModel } from './model-registry'

export interface ModelLoadAttempt {
  readonly modelId: string
  readonly reason: 'selected' | 'retry-selected' | 'fallback-mao' | 'fallback-hiyori'
}

export interface ModelLoadPlan {
  readonly attempts: readonly ModelLoadAttempt[]
  readonly exhaustedError: Live2dLoadError
}

export function createModelLoadPlan(
  selectedModelId: string | null,
  availableModelIds: readonly string[]
): ModelLoadPlan {
  const available = new Set(availableModelIds)
  const first =
    selectedModelId !== null && available.has(selectedModelId)
      ? selectedModelId
      : available.has('mao')
        ? 'mao'
        : available.has('hiyori')
          ? 'hiyori'
          : null
  const attempts: ModelLoadAttempt[] = []
  if (first !== null) {
    attempts.push({ modelId: first, reason: 'selected' })
    attempts.push({ modelId: first, reason: 'retry-selected' })
  }
  if (available.has('mao') && first !== 'mao')
    attempts.push({ modelId: 'mao', reason: 'fallback-mao' })
  if (available.has('hiyori') && first !== 'hiyori')
    attempts.push({ modelId: 'hiyori', reason: 'fallback-hiyori' })

  return {
    attempts,
    exhaustedError: { code: 'FILE_NOT_FOUND', retryable: false, suggestedAction: 'choose-model' }
  }
}

export interface BuiltinModelSetupResult {
  readonly models: readonly Live2dModelListItem[]
  readonly errors: readonly Live2dLoadError[]
}

export interface Live2dModelService {
  initializeBuiltins(): BuiltinModelSetupResult
  list(): readonly Live2dModelListItem[]
  select(id: string | null): boolean
  selectedModelId(): string | null
  setSelectedModelId(id: string | null): boolean
  getLoadPlan(): ModelLoadPlan
  getStageModelUrl(id: string): string | null
  getLoadAttemptUrl(attemptIndex: number): string | null
  resolveAssetPath(modelId: string, requestPath: string): string | null
  getRegistered(id: string): RegisteredLive2dModel | null
}

function isSafeResourcePath(path: string): boolean {
  if (path.length === 0 || path.includes('\0') || isAbsolute(path)) return false
  const normalized = path.replaceAll('\\', '/')
  return !normalized.startsWith('../') && normalized !== '..'
}

function stageUrl(modelId: string, file: string): string {
  return `nacime-live2d://model/${encodeURIComponent(modelId)}/${file
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/')}`
}

export function createLive2dModelService(options: {
  readonly builtinModelsRoot: string
  readonly licenseDirectory: string
  readonly registry: Live2dModelRegistry
  readonly now?: () => number
}): Live2dModelService {
  const now = options.now ?? Date.now

  const licensesPresent = (): boolean =>
    existsSync(resolve(options.licenseDirectory, LIVE2D_LICENSE_FILE_NAME)) &&
    existsSync(resolve(options.licenseDirectory, LIVE2D_SAMPLE_TERMS_FILE_NAME)) &&
    existsSync(resolve(options.licenseDirectory, LIVE2D_CUBISM_CORE_NOTICE_FILE_NAME))

  return {
    initializeBuiltins() {
      const errors: Live2dLoadError[] = []
      if (!licensesPresent()) {
        return {
          models: [],
          errors: [{ code: 'FILE_NOT_FOUND', retryable: false, suggestedAction: 'use-default' }]
        }
      }

      for (const spec of Object.values(BUILTIN_LIVE2D_MODEL_SPECS)) {
        try {
          const candidate = discoverLive2dModel({
            modelDirectory: resolve(options.builtinModelsRoot, spec.sourceDirectory),
            id: spec.id,
            displayName: spec.displayName,
            source: 'builtin'
          })
          const validation = validateLive2dModel(candidate)
          if (!validation.ok) {
            errors.push(...validation.errors)
            continue
          }
          options.registry.register({
            id: spec.id,
            directory: candidate.modelDirectory,
            manifest: candidate.manifest,
            installedAt: now()
          })
        } catch (cause) {
          const discovered =
            cause instanceof Error && 'loadError' in cause
              ? (cause as { loadError: Live2dLoadError }).loadError
              : {
                  code: 'MODEL_JSON_INVALID' as const,
                  retryable: false,
                  suggestedAction: 'use-default' as const
                }
          errors.push(discovered)
        }
      }

      if (options.registry.getSelected() === null) {
        options.registry.select(options.registry.get('mao') === null ? 'hiyori' : 'mao')
      }
      return { models: options.registry.list(), errors }
    },

    list() {
      return options.registry.list()
    },

    select(id) {
      return options.registry.select(id)
    },

    selectedModelId() {
      return options.registry.getSelected()?.id ?? null
    },

    setSelectedModelId(id) {
      return options.registry.select(id)
    },

    getLoadPlan() {
      return createModelLoadPlan(
        options.registry.getSelected()?.id ?? null,
        options.registry.list().map((model) => model.id)
      )
    },

    getStageModelUrl(id) {
      const model = options.registry.get(id)
      if (model === null) return null
      return stageUrl(id, model.manifest.modelJsonFile)
    },

    getLoadAttemptUrl(attemptIndex) {
      const plan = createModelLoadPlan(
        options.registry.getSelected()?.id ?? null,
        options.registry.list().map((model) => model.id)
      )
      const attempt = plan.attempts[attemptIndex]
      return attempt === undefined ? null : this.getStageModelUrl(attempt.modelId)
    },

    resolveAssetPath(modelId, requestPath) {
      const model = options.registry.get(modelId)
      if (
        model === null ||
        !isSafeResourcePath(requestPath) ||
        !isAllowedLive2dResourceFile(requestPath)
      ) {
        return null
      }
      const absolute = resolve(model.directory, requestPath)
      const suffix = relative(model.directory, absolute)
      if (
        suffix === '..' ||
        suffix.startsWith(`..${sep}`) ||
        isAbsolute(suffix) ||
        !existsSync(absolute)
      ) {
        return null
      }
      return absolute
    },

    getRegistered(id) {
      return options.registry.get(id)
    }
  }
}
