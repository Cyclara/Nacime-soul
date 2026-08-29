// src/main/live2d/model-validator.test.ts
// P3A-10：静态资源完整性/字节上限；WebGL 失败由 stage 在真实 GPU 上单独报告。

import { afterEach, describe, expect, it } from 'vitest'
import { cpSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { discoverLive2dModel } from './model-discovery'
import { validateLive2dModel } from './model-validator'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function copiedFixture(): ReturnType<typeof discoverLive2dModel> {
  const root = mkdtempSync(join(tmpdir(), 'nacime-live2d-validator-'))
  roots.push(root)
  const directory = join(root, 'model')
  cpSync(join(process.cwd(), 'tests/fixtures/live2d/fake-model'), directory, { recursive: true })
  return discoverLive2dModel({
    modelDirectory: directory,
    id: 'fake',
    displayName: 'Fake',
    source: 'user'
  })
}

describe('P3A-10 model validator', () => {
  it('最小合法 fixture 通过，参数/表情/motion 信息由 discovery 保留', () => {
    const candidate = copiedFixture()
    expect(validateLive2dModel(candidate)).toEqual({ ok: true, errors: [], warnings: [] })
  })

  it('缺失 moc3 返回 MOC3_NOT_FOUND', () => {
    const candidate = copiedFixture()
    unlinkSync(join(candidate.modelDirectory, candidate.manifest.mocFile))
    const result = validateLive2dModel(candidate)
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual([
      { code: 'MOC3_NOT_FOUND', retryable: true, suggestedAction: 'choose-model' }
    ])
  })

  it('单纹理或纹理总量超限返回 TEXTURE_TOO_LARGE', () => {
    const candidate = copiedFixture()
    writeFileSync(
      join(candidate.modelDirectory, candidate.manifest.textureFiles[0]!),
      '0123456789',
      'utf8'
    )
    const result = validateLive2dModel(candidate, {
      maxTextureBytes: 4,
      maxTotalTextureBytes: 4,
      maxResourceBytes: 100
    })
    expect(result.ok).toBe(false)
    expect(result.errors).toEqual([
      { code: 'TEXTURE_TOO_LARGE', retryable: false, suggestedAction: 'update-driver' }
    ])
  })

  it('入口名被内部调用方损坏为非 model3 时仍拒绝，不信任上游对象', () => {
    const candidate = copiedFixture()
    const malformed = {
      ...candidate,
      manifest: { ...candidate.manifest, modelJsonFile: 'items_pinned_to_model.json' }
    }
    const result = validateLive2dModel(malformed)
    expect(result.ok).toBe(false)
    expect(result.errors.map((entry) => entry.code)).toContain('MODEL_JSON_INVALID')
  })
})
