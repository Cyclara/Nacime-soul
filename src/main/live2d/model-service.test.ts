// src/main/live2d/model-service.test.ts
// P3A-11/12：内置资源/许可、无路径 stage URL、fallback chain、协议路径防穿越。

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLive2dModelRegistry } from './model-registry'
import { createLive2dModelService, createModelLoadPlan, type Live2dModelService } from './model-service'
import { discoverLive2dModel } from './model-discovery'
import { parseLive2dAssetRequest } from './asset-protocol'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function service(): Live2dModelService {
  const root = mkdtempSync(join(tmpdir(), 'nacime-live2d-service-'))
  roots.push(root)
  const registry = createLive2dModelRegistry({
    registryPath: join(root, 'registry.json'),
    builtinModelsRoot: join(process.cwd(), 'resources/live2d/models'),
    userModelsRoot: join(root, 'user-models')
  })
  return createLive2dModelService({
    builtinModelsRoot: join(process.cwd(), 'resources/live2d/models'),
    licenseDirectory: join(process.cwd(), 'resources/live2d/licenses'),
    registry,
    now: () => 123
  })
}

describe('P3A-11/12 model service', () => {
  it('登记 Mao/Hiyori + 许可文件；Mao 缺标准 mouth 仅 warning，不阻断 3a', () => {
    const models = service().initializeBuiltins()
    expect(models.errors).toEqual([])
    expect(models.models.map((model) => model.id).sort()).toEqual(['hiyori', 'mao'])
    expect(models.models.find((model) => model.id === 'mao')?.hasMouthOpen).toBe(false)
    expect(models.models.find((model) => model.id === 'mao')?.warnings).toContain('MOUTH_OPEN_PARAMETER_MISSING')
    expect(models.models.find((model) => model.id === 'hiyori')?.hasMouthOpen).toBe(true)
  })

  it('stage 只拿受控 nacime-live2d URL，绝不拿模型绝对路径；资源解析拒绝 zip-slip', () => {
    const models = service()
    models.initializeBuiltins()
    const url = models.getStageModelUrl('mao')
    expect(url).toBe('nacime-live2d://model/mao/Mao.model3.json')
    expect(url).not.toContain(process.cwd())
    expect(models.resolveAssetPath('mao', 'Mao.2048/texture_00.png')).toContain('texture_00.png')
    expect(models.resolveAssetPath('mao', '../secrets.txt')).toBeNull()
    expect(models.resolveAssetPath('mao', 'Mao.moc3.exe')).toBeNull()
  })

  // P3A-27「中文路径至少一例」：仓库本身就在中文目录下，但那是偶然而非断言。这条显式覆盖
  // 中文模型目录 + 中文资源名，走完 discovery → registry → 受控 URL → 协议解析 → 磁盘定位。
  it('中文目录与中文资源名：受控 URL 百分号编码往返后仍能定位到真实文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'nacime-live2d-cjk-'))
    roots.push(root)
    const userModelsRoot = join(root, 'user-models')
    const modelDirectory = join(userModelsRoot, '我的模型 测试')
    mkdirSync(join(modelDirectory, '贴图'), { recursive: true })
    writeFileSync(join(modelDirectory, '模型.moc3'), '', 'utf8')
    writeFileSync(join(modelDirectory, '贴图', '贴图_00.png'), '', 'utf8')
    writeFileSync(
      join(modelDirectory, '模型.model3.json'),
      JSON.stringify({
        Version: 3,
        FileReferences: { Moc: '模型.moc3', Textures: ['贴图/贴图_00.png'] }
      }),
      'utf8'
    )

    const registry = createLive2dModelRegistry({
      registryPath: join(root, 'registry.json'),
      builtinModelsRoot: join(process.cwd(), 'resources/live2d/models'),
      userModelsRoot
    })
    const discovered = discoverLive2dModel({
      modelDirectory,
      id: 'user-cjk',
      displayName: '中文模型',
      source: 'user'
    })
    expect(discovered.manifest.modelJsonFile).toBe('模型.model3.json')
    expect(discovered.manifest.textureFiles).toEqual(['贴图/贴图_00.png'])
    registry.register({
      id: 'user-cjk',
      directory: modelDirectory,
      manifest: discovered.manifest,
      installedAt: 1
    })

    const models = createLive2dModelService({
      builtinModelsRoot: join(process.cwd(), 'resources/live2d/models'),
      licenseDirectory: join(process.cwd(), 'resources/live2d/licenses'),
      registry,
      now: () => 123
    })

    // stage 只拿到 ASCII 的受控 URL：中文段是百分号编码，不是原文更不是磁盘路径。
    const url = models.getStageModelUrl('user-cjk')
    expect(url).toBe('nacime-live2d://model/user-cjk/%E6%A8%A1%E5%9E%8B.model3.json')
    expect(url).not.toContain('模型')
    expect(url).not.toContain(root)

    const parsed = parseLive2dAssetRequest(url!)
    expect(parsed).toEqual({ modelId: 'user-cjk', path: '模型.model3.json' })
    expect(models.resolveAssetPath(parsed!.modelId, parsed!.path)).toBe(
      join(modelDirectory, '模型.model3.json')
    )

    const textureUrl = `nacime-live2d://model/user-cjk/${encodeURIComponent('贴图')}/${encodeURIComponent('贴图_00.png')}`
    const parsedTexture = parseLive2dAssetRequest(textureUrl)
    expect(parsedTexture).toEqual({ modelId: 'user-cjk', path: '贴图/贴图_00.png' })
    expect(models.resolveAssetPath(parsedTexture!.modelId, parsedTexture!.path)).toBe(
      join(modelDirectory, '贴图', '贴图_00.png')
    )
  })

  it('加载链严格为 selected → retry once → Mao → Hiyori，默认模型不重复 fallback', () => {
    expect(createModelLoadPlan('user-1', ['user-1', 'mao', 'hiyori']).attempts).toEqual([
      { modelId: 'user-1', reason: 'selected' },
      { modelId: 'user-1', reason: 'retry-selected' },
      { modelId: 'mao', reason: 'fallback-mao' },
      { modelId: 'hiyori', reason: 'fallback-hiyori' }
    ])
    expect(createModelLoadPlan('mao', ['mao', 'hiyori']).attempts).toEqual([
      { modelId: 'mao', reason: 'selected' },
      { modelId: 'mao', reason: 'retry-selected' },
      { modelId: 'hiyori', reason: 'fallback-hiyori' }
    ])
  })
})
