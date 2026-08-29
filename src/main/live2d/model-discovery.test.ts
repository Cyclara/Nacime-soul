// src/main/live2d/model-discovery.test.ts
// P3A-09：只发现精确 .model3.json；items_pinned_to_model.json 永不作为入口；相对路径防穿越。

import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  discoverLive2dModel,
  Live2dModelDiscoveryError,
  type DiscoverLive2dModelOptions
} from './model-discovery'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), 'nacime-live2d-discovery-'))
  roots.push(root)
  return root
}

function options(directory: string): DiscoverLive2dModelOptions {
  return {
    modelDirectory: directory,
    id: 'model-1',
    displayName: '测试模型',
    source: 'user' as const
  }
}

describe('P3A-09 model discovery', () => {
  it('从最小合法 fixture 解析 manifest，并显式忽略 items_pinned_to_model.json 诱饵', () => {
    const root = temporaryDirectory()
    const fixture = join(process.cwd(), 'tests/fixtures/live2d/fake-model')
    const target = join(root, 'model')
    cpSync(fixture, target, { recursive: true })

    const result = discoverLive2dModel(options(target))
    expect(result.manifest).toMatchObject({
      id: 'model-1',
      source: 'user',
      modelJsonFile: 'fake.model3.json',
      mocFile: 'fake.moc3',
      textureFiles: ['textures/fake_00.png'],
      expressionNames: ['smile', 'surprised'],
      hasMouthOpen: true
    })
    expect(result.manifest.motionGroups).toEqual({ Idle: 1 })
    expect(result.referencedFiles).not.toContain('items_pinned_to_model.json')
  })

  it('不存在 model3 入口时返回 FILE_NOT_FOUND，而不是把 items_pinned_to_model.json 当模型', () => {
    const root = temporaryDirectory()
    writeFileSync(join(root, 'items_pinned_to_model.json'), '{}', 'utf8')

    expect(() => discoverLive2dModel(options(root))).toThrow(Live2dModelDiscoveryError)
    try {
      discoverLive2dModel(options(root))
    } catch (error) {
      expect((error as Live2dModelDiscoveryError).loadError.code).toBe('FILE_NOT_FOUND')
    }
  })

  it('model JSON 中的 ../ 资源路径被拒绝，绝不让模型引用逃离自己的目录', () => {
    const root = temporaryDirectory()
    writeFileSync(
      join(root, 'bad.model3.json'),
      JSON.stringify({
        Version: 3,
        FileReferences: { Moc: '../secret.moc3', Textures: ['tex.png'] }
      }),
      'utf8'
    )
    writeFileSync(join(root, 'tex.png'), '', 'utf8')

    try {
      discoverLive2dModel(options(root))
      throw new Error('expected failure')
    } catch (error) {
      expect((error as Live2dModelDiscoveryError).loadError.code).toBe('MODEL_JSON_INVALID')
    }
  })

  it('多个 model3 入口不猜测，拒绝歧义注册目录', () => {
    const root = temporaryDirectory()
    for (const name of ['a.model3.json', 'b.model3.json']) {
      writeFileSync(
        join(root, name),
        JSON.stringify({ Version: 3, FileReferences: { Moc: 'a.moc3', Textures: ['tex.png'] } }),
        'utf8'
      )
    }
    writeFileSync(join(root, 'a.moc3'), '', 'utf8')
    writeFileSync(join(root, 'tex.png'), '', 'utf8')

    expect(() => discoverLive2dModel(options(root))).toThrow('MODEL_JSON_INVALID')
  })

  it('缺 ParamMouthOpenY 只给 warning，3a 可显示、3b 再禁用口型同步', () => {
    const root = temporaryDirectory()
    mkdirSync(join(root, 'textures'))
    writeFileSync(join(root, 'model.moc3'), '', 'utf8')
    writeFileSync(join(root, 'textures/texture.png'), '', 'utf8')
    writeFileSync(
      join(root, 'model.model3.json'),
      JSON.stringify({
        Version: 3,
        FileReferences: { Moc: 'model.moc3', Textures: ['textures/texture.png'] }
      }),
      'utf8'
    )

    const result = discoverLive2dModel(options(root))
    expect(result.manifest.hasMouthOpen).toBe(false)
    expect(result.manifest.warnings).toEqual(['MOUTH_OPEN_PARAMETER_MISSING'])
  })
})
