// src/main/live2d/model-registry.test.ts
// P3A-08/11：registry 不泄漏绝对路径到 list DTO；选择/注册原子持久化、损坏文件 fail-open。

import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLive2dModelRegistry } from './model-registry'
import type { Live2dModelManifest } from '@shared/live2d/types'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup(): {
  root: string
  registryPath: string
  builtinModelsRoot: string
  userModelsRoot: string
} {
  const root = mkdtempSync(join(tmpdir(), 'nacime-live2d-registry-'))
  roots.push(root)
  return {
    root,
    registryPath: join(root, 'registry.json'),
    builtinModelsRoot: join(root, 'builtin-models'),
    userModelsRoot: join(root, 'user-models')
  }
}

const MANIFEST: Live2dModelManifest = {
  id: 'mao',
  displayName: 'Mao',
  source: 'builtin',
  cubismVersion: 3,
  modelJsonFile: 'Mao.model3.json',
  mocFile: 'Mao.moc3',
  textureFiles: ['Mao.2048/texture_00.png'],
  physicsFile: null,
  expressionNames: ['smile'],
  motionGroups: { Idle: 2 },
  parameterIds: ['ParamMouthOpenY'],
  hasMouthOpen: true,
  warnings: []
}

describe('P3A-08/11 model registry', () => {
  it('注册和选择落盘，但 public list 没有 directory/path/hash 等敏感内部字段', () => {
    const { registryPath, builtinModelsRoot, userModelsRoot } = setup()
    const registry = createLive2dModelRegistry({
      registryPath,
      builtinModelsRoot,
      userModelsRoot,
      now: () => 100
    })
    registry.register({
      id: 'mao',
      directory: join(builtinModelsRoot, 'mao'),
      manifest: MANIFEST,
      installedAt: 100
    })
    expect(registry.select('mao')).toBe(true)

    expect(registry.list()).toEqual([
      {
        id: 'mao',
        displayName: 'Mao',
        source: 'builtin',
        cubismVersion: 3,
        expressionCount: 1,
        motionCount: 2,
        hasMouthOpen: true,
        warnings: []
      }
    ])
    expect(JSON.stringify(registry.list())).not.toContain(builtinModelsRoot)
    expect(registry.getSelected()).toMatchObject({
      id: 'mao',
      directory: join(builtinModelsRoot, 'mao')
    })
    expect(existsSync(registryPath)).toBe(true)
    expect(JSON.parse(readFileSync(registryPath, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      selectedModelId: 'mao'
    })
  })

  it('重开 registry 恢复已有选择；未知 ID 不会把选择篡改为不存在模型', () => {
    const { registryPath, builtinModelsRoot, userModelsRoot } = setup()
    const first = createLive2dModelRegistry({ registryPath, builtinModelsRoot, userModelsRoot })
    first.register({
      id: 'mao',
      directory: join(builtinModelsRoot, 'mao'),
      manifest: MANIFEST,
      installedAt: 1
    })
    first.select('mao')

    const restarted = createLive2dModelRegistry({ registryPath, builtinModelsRoot, userModelsRoot })
    expect(restarted.getSelected()?.id).toBe('mao')
    expect(restarted.select('missing')).toBe(false)
    expect(restarted.getSelected()?.id).toBe('mao')
  })

  it('注册目录逃离 builtinModelsRoot 时拒绝，不把 ../ 写入 registry', () => {
    const { registryPath, builtinModelsRoot, userModelsRoot, root } = setup()
    const registry = createLive2dModelRegistry({ registryPath, builtinModelsRoot, userModelsRoot })
    expect(() =>
      registry.register({
        id: 'escape',
        directory: join(root, 'other'),
        manifest: { ...MANIFEST, id: 'escape' },
        installedAt: 1
      })
    ).toThrow('escapes registry root')
    expect(existsSync(registryPath)).toBe(false)
  })

  it('损坏 registry 不阻塞应用；以空列表保守恢复，原文件不被覆写直到下一次正常变更', () => {
    const { registryPath, builtinModelsRoot, userModelsRoot } = setup()
    writeFileSync(registryPath, '{ broken', 'utf8')
    const registry = createLive2dModelRegistry({ registryPath, builtinModelsRoot, userModelsRoot })
    expect(registry.list()).toEqual([])
    expect(readFileSync(registryPath, 'utf8')).toBe('{ broken')
  })
})
