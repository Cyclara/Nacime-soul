// src/main/live2d/model-import.ts
// P3A-13/14：Live2D ZIP 导入安全层 + 原子安装。
//
// ZIP 不是可信目录：先完整读入并检查压缩包/entry 数量、原始文件名、展开总量和扩展名；
// 再写入临时目录、发现/验证模型，最后 rename 到 user models root。失败只删除临时目录，
// 不触碰现有 registry/当前模型。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, renameSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import JSZip from 'jszip'
import { decodeZipFileName } from './decode-zip-filename'
import { discoverLive2dModel } from './model-discovery'
import { validateLive2dModel, DEFAULT_LIVE2D_VALIDATION_LIMITS, type Live2dModelValidationLimits } from './model-validator'
import type { Live2dLoadError, Live2dModelCandidate, Live2dModelManifest, Live2dValidationResult } from '@shared/live2d/types'
import type { Live2dModelRegistry } from './model-registry'

export interface Live2dImportLimits extends Live2dModelValidationLimits {
  readonly maxZipBytes: number
  readonly maxEntries: number
  readonly now?: () => number
  readonly makeTempId?: () => string
}

export const DEFAULT_LIVE2D_IMPORT_LIMITS: Live2dImportLimits = {
  ...DEFAULT_LIVE2D_VALIDATION_LIMITS,
  maxZipBytes: 256 * 1024 * 1024,
  maxEntries: 512,
  now: undefined,
  makeTempId: undefined
}

export interface Live2dImportResult {
  readonly ok: boolean
  readonly modelId: string | null
  readonly manifest: Live2dModelManifest | null
  readonly validation: Live2dValidationResult
  readonly error: Live2dLoadError | null
}

export interface Live2dModelImporter {
  importZip(zipPath: string): Promise<Live2dImportResult>
}

function importError(
  code: Live2dLoadError['code'],
  retryable: boolean,
  suggestedAction: Live2dLoadError['suggestedAction']
): Live2dLoadError {
  return { code, retryable, suggestedAction }
}

function isZipSlip(name: string): boolean {
  if (name.length === 0 || name.includes('\0')) return true
  const normalized = name.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return true
  const parts = normalized.split('/')
  return parts.some((part) => part === '..')
}

function safeZipName(name: string): string | null {
  if (isZipSlip(name)) return null
  const normalized = name.replaceAll('\\', '/')
  const parts = normalized.split('/').filter((part) => part.length > 0 && part !== '.')
  if (parts.length === 0) return null
  return parts.join('/')
}

/**
 * macOS 压缩时附带的元数据条目，必须**跳过**而不是拒绝整个包。
 *
 * 对照 AIRI 更新时发现的同类缺陷（moeru-ai/airi#1991 `ignore macOS files`）。对本项目的
 * 具体危害：`__MACOSX/._Mao.model3.json` 这类 AppleDouble 伴随文件同样以 `.model3.json`
 * 结尾，会通过扩展名白名单被解压到磁盘，随后 discovery 发现**两个** model3 入口 →
 * 按「多入口不猜测」拒绝注册，用户看到的是误导性的 MODEL_JSON_INVALID。
 * 它们是纯噪声，跳过即可；这类包在网上流传的模型里很常见。
 */
function isMacOsMetadataEntry(name: string): boolean {
  const parts = name.split('/')
  if (parts[0] === '__MACOSX') return true
  const base = parts[parts.length - 1] ?? ''
  return base.startsWith('._') || base === '.DS_Store'
}

function isSupportedEntry(name: string): boolean {
  const lower = name.toLowerCase()
  return [
    '.model3.json',
    '.moc3',
    '.png',
    '.physics3.json',
    '.pose3.json',
    '.cdi3.json',
    '.exp3.json',
    '.motion3.json',
    '.userdata3.json',
    '.wav',
    '.mp3'
  ].some((extension) => lower.endsWith(extension))
}

interface ZipEntryMetadata extends JSZip.JSZipObject {
  readonly unsafeOriginalName?: string
  readonly _data?: { readonly uncompressedSize?: number }
}

function isDirectory(name: string, entry: ZipEntryMetadata): boolean {
  return entry.dir || name.endsWith('/')
}

function resultFailure(error: Live2dLoadError): Live2dImportResult {
  return {
    ok: false,
    modelId: null,
    manifest: null,
    validation: { ok: false, errors: [error], warnings: [] },
    error
  }
}

function modelIdFromManifest(manifest: Live2dModelManifest, bytes: Buffer): string {
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16)
  const slug = manifest.displayName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-|-$/g, '') || 'model'
  return `${slug}-${hash}`
}

function ensureInside(root: string, path: string): boolean {
  const suffix = relative(root, resolve(path))
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

export function createLive2dModelImporter(options: {
  readonly userModelsRoot: string
  readonly registry: Live2dModelRegistry
  readonly limits?: Live2dImportLimits
}): Live2dModelImporter {
  const limits = options.limits ?? DEFAULT_LIVE2D_IMPORT_LIMITS
  const userRoot = resolve(options.userModelsRoot)
  const makeTempId = limits.makeTempId ?? (() => `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`)
  mkdirSync(userRoot, { recursive: true })

  return {
    async importZip(zipPath) {
      let zipBytes: Buffer
      try {
        zipBytes = readFileSync(zipPath)
      } catch {
        return resultFailure(importError('FILE_NOT_FOUND', true, 'retry'))
      }
      if (zipBytes.byteLength > limits.maxZipBytes) {
        return resultFailure(importError('TEXTURE_TOO_LARGE', false, 'choose-model'))
      }

      let zip: JSZip
      try {
        // decodeFileName 只对**未标 UTF-8 标志**的条目生效：CJK 作者导出的模型包
        // （尤其 VTube Studio）常按 GBK 存条目名，默认 UTF-8 解会变乱码，
        // 随后 model3.json 里正确的 UTF-8 资源名就对不上磁盘文件，导入失败于误导性错误码。
        zip = await JSZip.loadAsync(zipBytes, { checkCRC32: true, decodeFileName: decodeZipFileName })
      } catch {
        return resultFailure(importError('MODEL_JSON_INVALID', false, 'choose-model'))
      }

      const entries = Object.entries(zip.files)
      if (entries.length === 0 || entries.length > limits.maxEntries) {
        return resultFailure(importError('MODEL_JSON_INVALID', false, 'choose-model'))
      }
      const names = new Set<string>()
      for (const [name, rawEntry] of entries) {
        const entry = rawEntry as ZipEntryMetadata
        const originalName = entry.unsafeOriginalName ?? name
        // JSZip >=3.8 normalizes `..` in its public key; inspect unsafeOriginalName too,
        // otherwise a zip-slip entry could appear harmless after normalization.
        if (isZipSlip(originalName)) {
          return resultFailure(importError('MODEL_JSON_INVALID', false, 'choose-model'))
        }
        const safeName = safeZipName(name)
        if (safeName === null || names.has(safeName)) {
          return resultFailure(importError('MODEL_JSON_INVALID', false, 'choose-model'))
        }
        // zip-slip 已在上面按 originalName 判过；macOS 噪声在那之后才跳过，
        // 免得伪装成 `__MACOSX/../..` 的条目借跳过绕开安全检查。
        if (isMacOsMetadataEntry(safeName)) continue
        names.add(safeName)
        const lowerName = safeName.toLowerCase()
        if (!isDirectory(safeName, entry) && (!isSupportedEntry(safeName) || lowerName === 'items_pinned_to_model.json' || lowerName.endsWith('/items_pinned_to_model.json'))) {
          return resultFailure(importError('MODEL_JSON_INVALID', false, 'choose-model'))
        }
      }

      const tempRoot = join(userRoot, `.import-${makeTempId()}`)
      const staging = join(tempRoot, 'model')
      let installedPath: string | null = null
      let registered = false
      try {
        mkdirSync(staging, { recursive: true })
        let expandedBytes = 0
        for (const [rawName, rawEntry] of entries) {
          const entry = rawEntry as ZipEntryMetadata
          const safeName = safeZipName(rawName)!
          if (isDirectory(safeName, entry)) continue
          // 与上面的校验循环保持同一套跳过规则，否则会把 AppleDouble 伴随文件写到磁盘，
          // discovery 随后按「多个 model3 入口」拒绝整个模型。
          if (isMacOsMetadataEntry(safeName)) continue
          const declaredSize = entry._data?.uncompressedSize
          if (declaredSize !== undefined && (!Number.isFinite(declaredSize) || declaredSize < 0 || declaredSize > limits.maxResourceBytes)) {
            return resultFailure(importError('TEXTURE_TOO_LARGE', false, 'choose-model'))
          }
          if (declaredSize !== undefined && safeName.toLowerCase().endsWith('.png') && declaredSize > limits.maxTextureBytes) {
            return resultFailure(importError('TEXTURE_TOO_LARGE', false, 'update-driver'))
          }
          const content = await entry.async('nodebuffer')
          expandedBytes += content.byteLength
          if (expandedBytes > limits.maxResourceBytes) {
            return resultFailure(importError('TEXTURE_TOO_LARGE', false, 'choose-model'))
          }
          const target = resolve(staging, safeName)
          if (!ensureInside(staging, target)) return resultFailure(importError('MODEL_JSON_INVALID', false, 'choose-model'))
          mkdirSync(resolve(target, '..'), { recursive: true })
          writeFileSync(target, content, { flag: 'wx' })
        }

        const discovered = discoverLive2dModel({
          modelDirectory: staging,
          id: 'import-pending',
          displayName: basename(staging),
          source: 'user'
        })
        const validation = validateLive2dModel(discovered, limits)
        if (!validation.ok) {
          return { ok: false, modelId: null, manifest: discovered.manifest, validation, error: validation.errors[0] ?? null }
        }

        const modelId = modelIdFromManifest(discovered.manifest, zipBytes)
        const finalRoot = join(userRoot, modelId)
        if (existsSync(finalRoot)) {
          return resultFailure(importError('MODEL_JSON_INVALID', false, 'choose-model'))
        }
        const finalManifest: Live2dModelManifest = { ...discovered.manifest, id: modelId }
        const finalCandidate: Live2dModelCandidate = {
          ...discovered,
          manifest: finalManifest
        }
        // Stage directory is renamed as a whole; registry write follows only after install succeeds.
        renameSync(staging, finalRoot)
        installedPath = finalRoot
        options.registry.register({
          id: modelId,
          directory: finalRoot,
          manifest: finalManifest,
          installedAt: Date.now()
        })
        registered = true
        return { ok: true, modelId, manifest: finalCandidate.manifest, validation, error: null }
      } catch {
        if (installedPath !== null && !registered) rmSync(installedPath, { recursive: true, force: true })
        return resultFailure(importError('MODEL_JSON_INVALID', false, 'choose-model'))
      } finally {
        rmSync(tempRoot, { recursive: true, force: true })
      }
    }
  }
}
