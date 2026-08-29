// src/main/live2d/model-import.test.ts
// P3A-13/14：真实 JSZip archive 的 zip-slip、类型白名单、展开上限、验证后原子安装。

import { afterEach, describe, expect, it } from 'vitest'
import JSZip from 'jszip'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLive2dModelImporter, type Live2dModelImporter } from './model-import'
import { createLive2dModelRegistry, type Live2dModelRegistry } from './model-registry'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function writeArchive(root: string, entries: Record<string, string | Uint8Array>): Promise<string> {
  const zip = new JSZip()
  for (const [name, content] of Object.entries(entries)) zip.file(name, content)
  const path = join(root, 'model.zip')
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  const { writeFileSync } = await import('node:fs')
  writeFileSync(path, bytes)
  return path
}

function makeImporter(
  root: string,
  limits?: Parameters<typeof createLive2dModelImporter>[0]['limits']
): { importer: Live2dModelImporter; registry: Live2dModelRegistry } {
  const registry = createLive2dModelRegistry({
    registryPath: join(root, 'registry.json'),
    builtinModelsRoot: join(root, 'builtins'),
    userModelsRoot: join(root, 'installed')
  })
  return {
    importer: createLive2dModelImporter({ userModelsRoot: join(root, 'installed'), registry, limits }),
    registry
  }
}

const MODEL_JSON = JSON.stringify({
  Version: 3,
  FileReferences: { Moc: 'model.moc3', Textures: ['texture.png'] },
  Groups: [{ Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] }]
})

const VALID_ENTRIES = {
  'model.model3.json': MODEL_JSON,
  'model.moc3': 'moc',
  'texture.png': 'png'
}

describe('P3A-13/14 Live2D model importer', () => {
  // 对照 AIRI 更新（moeru-ai/airi#1991 ignore macOS files）补的两条：
  // macOS 打包的模型包在网上很常见，其伴随文件必须**跳过**而不是拒绝整个包。
  it('跳过 macOS 元数据条目：AppleDouble 不会被当成第二个 model3 入口', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nacime-live2d-import-'))
    roots.push(root)
    const { importer } = makeImporter(root)
    const archive = await writeArchive(root, {
      ...VALID_ENTRIES,
      // 这两个都以 .model3.json 结尾，会通过扩展名白名单；若不跳过，
      // discovery 会看到 3 个 model3 入口并按「多入口歧义」整包拒绝。
      '__MACOSX/._model.model3.json': 'applereally-not-a-model',
      '._model.model3.json': 'apple-sidecar',
      '.DS_Store': 'finder-junk'
    })

    const result = await importer.importZip(archive)
    expect(result.ok).toBe(true)
    // 噪声文件不得落到安装目录里。
    const installed = join(root, 'installed', result.modelId!)
    expect(existsSync(join(installed, '__MACOSX'))).toBe(false)
    expect(existsSync(join(installed, '._model.model3.json'))).toBe(false)
    expect(existsSync(join(installed, '.DS_Store'))).toBe(false)
    expect(existsSync(join(installed, 'model.model3.json'))).toBe(true)
  })

  it('macOS 前缀不能成为绕过 zip-slip 检查的后门', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nacime-live2d-import-'))
    roots.push(root)
    const { importer } = makeImporter(root)
    const archive = await writeArchive(root, {
      ...VALID_ENTRIES,
      '__MACOSX/../../escaped.model3.json': 'escape-attempt'
    })

    // 跳过发生在 zip-slip 判定**之后**，所以这类条目仍然整包拒绝。
    const result = await importer.importZip(archive)
    expect(result.ok).toBe(false)
  })

  it('合法 ZIP 解压、验证后 rename 安装并注册；临时目录被清除', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nacime-live2d-import-'))
    roots.push(root)
    const zipPath = await writeArchive(root, VALID_ENTRIES)
    const { importer, registry } = makeImporter(root, {
      maxZipBytes: 1024 * 1024,
      maxEntries: 10,
      maxTextureBytes: 1024,
      maxTotalTextureBytes: 1024,
      maxResourceBytes: 1024,
      now: () => 10,
      makeTempId: () => 'fixed'
    })

    const result = await importer.importZip(zipPath)
    expect(result.ok).toBe(true)
    expect(result.modelId).toMatch(/^model-[0-9a-f]{16}$/)
    expect(result.manifest?.hasMouthOpen).toBe(true)
    expect(registry.get(result.modelId!)).not.toBeNull()
    expect(existsSync(join(root, 'installed', result.modelId!))).toBe(true)
    expect(readFileSync(join(root, 'installed', result.modelId!, 'model.model3.json'), 'utf8')).toBe(MODEL_JSON)
    expect(existsSync(join(root, 'installed', '.import-fixed'))).toBe(false)
  })

  it('zip-slip（../、绝对 Windows 路径、反斜杠）在写盘前拒绝，既有安装不受影响', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nacime-live2d-import-slip-'))
    roots.push(root)
    for (const name of ['../escape.txt', '/absolute.txt', 'C:\\absolute.txt', '..\\escape.txt']) {
      const zipPath = await writeArchive(root, { [name]: 'bad' })
      const { importer, registry } = makeImporter(root)
      const result = await importer.importZip(zipPath)
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('MODEL_JSON_INVALID')
      expect(registry.list()).toEqual([])
      expect(existsSync(join(root, 'escape.txt'))).toBe(false)
    }
  })

  it('items_pinned_to_model.json 与不支持的可执行文件都拒绝', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nacime-live2d-import-entry-'))
    roots.push(root)
    const entriesList: Record<string, string>[] = [
      { 'items_pinned_to_model.json': '{}', 'model.moc3': 'x' },
      { 'model.model3.json': MODEL_JSON, 'model.moc3': 'moc', 'texture.png': 'png', 'payload.exe': 'bad' }
    ]
    for (const entries of entriesList) {
      const zipPath = await writeArchive(root, entries)
      const { importer } = makeImporter(root)
      const result = await importer.importZip(zipPath)
      expect(result.ok).toBe(false)
      expect(result.error?.code).toBe('MODEL_JSON_INVALID')
    }
  })

  it('entry 数量与展开体积上限拒绝压缩炸弹，安装目录不留半成品', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nacime-live2d-import-limit-'))
    roots.push(root)
    const zipPath = await writeArchive(root, { ...VALID_ENTRIES, 'extra.png': '123456789' })
    const { importer, registry } = makeImporter(root, {
      maxZipBytes: 1024 * 1024,
      maxEntries: 3,
      maxTextureBytes: 1024,
      maxTotalTextureBytes: 1024,
      maxResourceBytes: 1024
    })
    const result = await importer.importZip(zipPath)
    expect(result.ok).toBe(false)
    expect(registry.list()).toEqual([])
    expect(existsSync(join(root, 'installed'))).toBe(true)
    expect(await (await import('node:fs/promises')).readdir(join(root, 'installed'))).toEqual([])
  })
})
