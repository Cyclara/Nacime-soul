// src/main/live2d/model-registry.ts
// P3A-08/11：main-owned 模型注册表。只持久化安全相对目录/manifest，不让 renderer 见路径。
//
// registry 使用 atomicWriteJson；每个变更先写临时文件再 rename，导入中断不会留下半份 JSON。

import { existsSync, readFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { atomicWriteJson } from '../migrations/atomic-json'
import {
  toLive2dModelListItem,
  type Live2dModelListItem,
  type Live2dModelManifest
} from '@shared/live2d/types'

export const BUILTIN_LIVE2D_MODEL_IDS = ['mao', 'hiyori'] as const
export type BuiltinLive2dModelId = (typeof BUILTIN_LIVE2D_MODEL_IDS)[number]

interface RegistryFile {
  readonly schemaVersion: 1
  readonly selectedModelId: string | null
  readonly models: readonly RegistryRecord[]
}

interface RegistryRecord {
  readonly id: string
  /** 相对于 source 对应根目录，始终无绝对路径/../。 */
  readonly directory: string
  readonly manifest: Live2dModelManifest
  readonly installedAt: number
}

export interface RegisteredLive2dModel {
  readonly id: string
  readonly directory: string
  readonly manifest: Live2dModelManifest
  readonly installedAt: number
}

export interface Live2dModelRegistry {
  list(): readonly Live2dModelListItem[]
  get(id: string): RegisteredLive2dModel | null
  getSelected(): RegisteredLive2dModel | null
  select(id: string | null): boolean
  register(input: RegisteredLive2dModel): void
  unregister(id: string): boolean
  revision(): number
}

function isSafeRelativeDirectory(value: string): boolean {
  if (value.length === 0) return false
  const resolved = resolve('/', value)
  const suffix = relative('/', resolved)
  return suffix === value.replaceAll('\\', '/') && !value.startsWith('..') && !value.includes(`..${sep}`)
}

function isValidRecord(value: unknown): value is RegistryRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Partial<RegistryRecord>
  return (
    typeof record.id === 'string' &&
    isSafeRelativeDirectory(String(record.directory ?? '')) &&
    typeof record.installedAt === 'number' &&
    typeof record.manifest === 'object' &&
    record.manifest !== null
  )
}

function readRegistry(path: string): RegistryFile {
  if (!existsSync(path)) return { schemaVersion: 1, selectedModelId: null, models: [] }
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not object')
    const file = parsed as Partial<RegistryFile>
    if (file.schemaVersion !== 1 || !Array.isArray(file.models) || !file.models.every(isValidRecord)) {
      throw new Error('invalid registry')
    }
    return {
      schemaVersion: 1,
      selectedModelId: typeof file.selectedModelId === 'string' ? file.selectedModelId : null,
      models: file.models
    }
  } catch {
    // 用户模型列表损坏不能阻止聊天启动；保守地以空注册表重建，原文件仍保留供排查。
    return { schemaVersion: 1, selectedModelId: null, models: [] }
  }
}

export function createLive2dModelRegistry(options: {
  readonly registryPath: string
  readonly builtinModelsRoot: string
  readonly userModelsRoot: string
  readonly now?: () => number
}): Live2dModelRegistry {
  const now = options.now ?? Date.now
  const builtinModelsRoot = resolve(options.builtinModelsRoot)
  const userModelsRoot = resolve(options.userModelsRoot)
  let file = readRegistry(options.registryPath)
  let revision = 0

  const persist = (): void => {
    atomicWriteJson(options.registryPath, file)
    revision++
  }

  const rootFor = (source: Live2dModelManifest['source']): string =>
    source === 'builtin' ? builtinModelsRoot : userModelsRoot

  const toRegistered = (record: RegistryRecord): RegisteredLive2dModel => ({
    id: record.id,
    directory: resolve(rootFor(record.manifest.source), record.directory),
    manifest: record.manifest,
    installedAt: record.installedAt
  })

  return {
    list() {
      return file.models.map((record) => toLive2dModelListItem(record.manifest))
    },
    get(id) {
      const record = file.models.find((model) => model.id === id)
      return record === undefined ? null : toRegistered(record)
    },
    getSelected() {
      return file.selectedModelId === null ? null : this.get(file.selectedModelId)
    },
    select(id) {
      if (id !== null && !file.models.some((model) => model.id === id)) return false
      if (file.selectedModelId === id) return true
      file = { ...file, selectedModelId: id }
      persist()
      return true
    },
    register(input) {
      const relativeDirectory = relative(rootFor(input.manifest.source), resolve(input.directory)).split(sep).join('/')
      if (!isSafeRelativeDirectory(relativeDirectory)) throw new Error('model directory escapes registry root')
      const record: RegistryRecord = {
        id: input.id,
        directory: relativeDirectory,
        manifest: input.manifest,
        installedAt: input.installedAt || now()
      }
      const remaining = file.models.filter((model) => model.id !== input.id)
      file = { ...file, models: [...remaining, record] }
      persist()
    },
    unregister(id) {
      const remaining = file.models.filter((model) => model.id !== id)
      if (remaining.length === file.models.length) return false
      file = {
        ...file,
        selectedModelId: file.selectedModelId === id ? null : file.selectedModelId,
        models: remaining
      }
      persist()
      return true
    },
    revision() {
      return revision
    }
  }
}

/** P3A-11 内置资源清单；资源实际安装前保持 document-only，避免未许可资产被无意打包。 */
export const BUILTIN_LIVE2D_MODEL_SPECS = {
  mao: { id: 'mao', displayName: 'Mao', sourceDirectory: 'mao' },
  hiyori: { id: 'hiyori', displayName: 'Hiyori', sourceDirectory: 'hiyori' }
} as const

/** 许可文件必须与包一同出现；部署检测不通过则降级到纯文字而不是偷用远程 CDN。 */
export const LIVE2D_LICENSE_FILE_NAME = 'Live2D-Free-Material-License.txt'
export const LIVE2D_SAMPLE_TERMS_FILE_NAME = 'Live2D-Sample-Model-Terms.txt'
export const LIVE2D_CUBISM_CORE_NOTICE_FILE_NAME = 'Live2D-Cubism-Core-NOTICE.txt'
