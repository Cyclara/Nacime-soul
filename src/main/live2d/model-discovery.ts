// src/main/live2d/model-discovery.ts
// P3A-09：从一个受信模型目录发现唯一 .model3.json，并解析资源清单。
//
// 不使用 fork 的 FileLoader/ZipLoader：旧 airi items_pinned_to_model 误识别路线已被依赖勘误
// 作废；我们在 main 自己只接受精确 .model3.json 后缀、解析相对资源，并在边界处拒绝路径穿越。

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, isAbsolute, relative, resolve, sep } from 'node:path'
import {
  LIVE2D_PARAMETER_IDS,
  type Live2dLoadError,
  type Live2dModelCandidate,
  type Live2dModelManifest
} from '@shared/live2d/types'

export interface DiscoverLive2dModelOptions {
  readonly modelDirectory: string
  readonly id: string
  readonly displayName: string
  readonly source: 'builtin' | 'user'
}

export class Live2dModelDiscoveryError extends Error {
  constructor(readonly loadError: Live2dLoadError) {
    super(loadError.code)
    this.name = 'Live2dModelDiscoveryError'
  }
}

interface ModelJson {
  readonly Version?: unknown
  readonly FileReferences?: unknown
  readonly Groups?: unknown
}

interface FileReferences {
  readonly Moc?: unknown
  readonly Textures?: unknown
  readonly Physics?: unknown
  readonly Pose?: unknown
  readonly UserData?: unknown
  readonly DisplayInfo?: unknown
  readonly Expressions?: unknown
  readonly Motions?: unknown
}

function loadError(
  code: Live2dLoadError['code'],
  retryable: boolean,
  suggestedAction: Live2dLoadError['suggestedAction']
): Live2dLoadError {
  return { code, retryable, suggestedAction }
}

function fail(
  code: Live2dLoadError['code'],
  retryable = false,
  suggestedAction: Live2dLoadError['suggestedAction'] = 'choose-model'
): never {
  throw new Live2dModelDiscoveryError(loadError(code, retryable, suggestedAction))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRelativeResource(value: unknown, root: string): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || isAbsolute(value)) return false
  const resolved = resolve(root, value)
  const suffix = relative(root, resolved)
  return suffix.length > 0 && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

function toNormalizedRelativeFile(value: unknown, root: string): string {
  if (!isRelativeResource(value, root)) fail('MODEL_JSON_INVALID')
  return relative(root, resolve(root, value)).split(sep).join('/')
}

/** 深度有界由 P3A-13 ZIP 层保障；已注册目录只找模型入口，不把任意 .json 当入口。 */
function findModelJsonFiles(directory: string): string[] {
  const files: string[] = []
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name)
      if (entry.isDirectory()) {
        walk(path)
        continue
      }
      // airi items_pinned_to_model patch 的等价 main-side 修复：只认 model3 精确后缀，
      // 且显式排除 VTube Studio 元文件，绝不能退化为「第一个 JSON」。
      if (
        entry.isFile() &&
        entry.name.toLowerCase().endsWith('.model3.json') &&
        entry.name.toLowerCase() !== 'items_pinned_to_model.json'
      ) {
        files.push(path)
      }
    }
  }
  walk(directory)
  return files.sort((a, b) => a.localeCompare(b))
}

function parseJson(filePath: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    if (!isPlainObject(parsed)) fail('MODEL_JSON_INVALID')
    return parsed
  } catch (error) {
    if (error instanceof Live2dModelDiscoveryError) throw error
    fail('MODEL_JSON_INVALID')
  }
}

function collectExpressions(value: unknown, root: string): { names: string[]; files: string[] } {
  if (value === undefined) return { names: [], files: [] }
  if (!Array.isArray(value)) fail('MODEL_JSON_INVALID')
  const names: string[] = []
  const files: string[] = []
  for (const expression of value) {
    if (!isPlainObject(expression) || typeof expression['Name'] !== 'string') fail('MODEL_JSON_INVALID')
    names.push(expression['Name'])
    files.push(toNormalizedRelativeFile(expression['File'], root))
  }
  return { names: [...new Set(names)].sort(), files }
}

function collectMotions(value: unknown, root: string): { groups: Record<string, number>; files: string[] } {
  if (value === undefined) return { groups: {}, files: [] }
  if (!isPlainObject(value)) fail('MODEL_JSON_INVALID')
  const groups: Record<string, number> = {}
  const files: string[] = []
  for (const [group, entries] of Object.entries(value)) {
    if (!Array.isArray(entries) || group.length === 0) fail('MODEL_JSON_INVALID')
    groups[group] = entries.length
    for (const motion of entries) {
      if (!isPlainObject(motion)) fail('MODEL_JSON_INVALID')
      files.push(toNormalizedRelativeFile(motion['File'], root))
      if (motion['Sound'] !== undefined) files.push(toNormalizedRelativeFile(motion['Sound'], root))
    }
  }
  return { groups, files }
}

function collectGroupParameters(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  for (const group of value) {
    if (!isPlainObject(group) || !Array.isArray(group['Ids'])) continue
    for (const id of group['Ids']) {
      if (typeof id === 'string' && id.length > 0) ids.add(id)
    }
  }
  return [...ids].sort()
}

function collectCdiParameters(displayInfoPath: string | null, root: string): string[] {
  if (displayInfoPath === null) return []
  const absolute = resolve(root, displayInfoPath)
  if (!existsSync(absolute)) return []
  try {
    const parsed = parseJson(absolute)
    const parameters = parsed['Parameters']
    if (!Array.isArray(parameters)) return []
    return parameters
      .flatMap((parameter) => (isPlainObject(parameter) && typeof parameter['Id'] === 'string' ? [parameter['Id']] : []))
      .sort()
  } catch {
    // CDI 是可选元数据；坏 CDI 给验证器 warning，不阻止核心 .model3.json 发现。
    return []
  }
}

/**
 * 发现模型。candidate 只在 main 内使用；后续 registry 用 manifest/hash 生成 modelId 与受控 URL。
 */
export function discoverLive2dModel(options: DiscoverLive2dModelOptions): Live2dModelCandidate {
  if (!existsSync(options.modelDirectory)) fail('FILE_NOT_FOUND', true, 'use-default')
  let root: string
  try {
    root = realpathSync(options.modelDirectory)
  } catch {
    fail('FILE_NOT_FOUND', true, 'use-default')
  }

  let modelJsonPaths: string[]
  try {
    modelJsonPaths = findModelJsonFiles(root)
  } catch {
    fail('FILE_NOT_FOUND', true, 'use-default')
  }
  if (modelJsonPaths.length === 0) fail('FILE_NOT_FOUND', true, 'use-default')
  // 注册目录应只对应一个模型；多入口不猜测，要求用户选择/重新导入。
  if (modelJsonPaths.length !== 1) fail('MODEL_JSON_INVALID')

  const modelJsonPath = modelJsonPaths[0]!
  const modelRoot = resolve(modelJsonPath, '..')
  const raw = parseJson(modelJsonPath) as ModelJson
  if (!Number.isInteger(raw.Version) || Number(raw.Version) < 3 || !isPlainObject(raw.FileReferences)) {
    fail('MODEL_JSON_INVALID')
  }
  const refs = raw.FileReferences as FileReferences
  const mocFile = toNormalizedRelativeFile(refs.Moc, modelRoot)
  if (!Array.isArray(refs.Textures) || refs.Textures.length === 0) fail('MODEL_JSON_INVALID')
  const textureFiles = refs.Textures.map((texture) => toNormalizedRelativeFile(texture, modelRoot))
  const physicsFile = refs.Physics === undefined ? null : toNormalizedRelativeFile(refs.Physics, modelRoot)
  const poseFile = refs.Pose === undefined ? null : toNormalizedRelativeFile(refs.Pose, modelRoot)
  const userDataFile = refs.UserData === undefined ? null : toNormalizedRelativeFile(refs.UserData, modelRoot)
  const displayInfoFile = refs.DisplayInfo === undefined ? null : toNormalizedRelativeFile(refs.DisplayInfo, modelRoot)
  const expressions = collectExpressions(refs.Expressions, modelRoot)
  const motions = collectMotions(refs.Motions, modelRoot)
  const parameterIds = [...new Set([...collectGroupParameters(raw.Groups), ...collectCdiParameters(displayInfoFile, modelRoot)])].sort()
  const warnings: string[] = []
  if (!parameterIds.includes(LIVE2D_PARAMETER_IDS.mouthOpen)) {
    warnings.push('MOUTH_OPEN_PARAMETER_MISSING')
  }

  const referencedFiles = [
    mocFile,
    ...textureFiles,
    ...(physicsFile === null ? [] : [physicsFile]),
    ...(poseFile === null ? [] : [poseFile]),
    ...(userDataFile === null ? [] : [userDataFile]),
    ...(displayInfoFile === null ? [] : [displayInfoFile]),
    ...expressions.files,
    ...motions.files
  ]

  const manifest: Live2dModelManifest = {
    id: options.id,
    displayName: options.displayName || basename(modelRoot),
    source: options.source,
    cubismVersion: raw.Version as number,
    modelJsonFile: basename(modelJsonPath),
    mocFile,
    textureFiles,
    physicsFile,
    expressionNames: expressions.names,
    motionGroups: motions.groups,
    parameterIds,
    hasMouthOpen: parameterIds.includes(LIVE2D_PARAMETER_IDS.mouthOpen),
    warnings
  }

  return { manifest, modelDirectory: modelRoot, modelJsonPath, referencedFiles }
}

/** P3A-10 复用：资源类型筛选时也只允许这一份允许集。 */
export const LIVE2D_MODEL_RESOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.moc3',
  '.png',
  '.model3.json',
  '.physics3.json',
  '.pose3.json',
  '.cdi3.json',
  '.exp3.json',
  '.motion3.json',
  '.userdata3.json',
  '.wav',
  '.mp3'
])

export function isAllowedLive2dResourceFile(fileName: string): boolean {
  const lower = fileName.toLowerCase()
  return [...LIVE2D_MODEL_RESOURCE_EXTENSIONS].some((extension) => lower.endsWith(extension))
}
