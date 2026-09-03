// src/main/voice/asset-root-service.test.ts
// P3V-10：资源根目录服务合同——默认根、自选偏好、状态三态、启动迁移、丢失不回退。
// 全部使用临时目录；EXDEV 跨盘分支用注入 rename 模拟。
// 纪律：每个用例开头 resetState() 清掉共享的偏好文件与默认根（服务在**构造时**
// 读偏好，伪造偏好必须先写盘再 makeService）。

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createAssetRootService, type AssetRootService } from './asset-root-service'

describe('P3V-10 asset-root-service', () => {
  let base: string
  let defaultRoot: string
  let prefPath: string
  let legacyAsrRoot: string

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'asset-root-'))
    defaultRoot = join(base, 'default-assets')
    prefPath = join(base, 'asset-root.json')
    legacyAsrRoot = join(base, 'legacy', 'models', 'asr')
  })
  afterAll(async () => {
    await rm(base, { recursive: true, force: true })
  })

  beforeEach(async () => {
    // 用例隔离：偏好清空 + 默认根删除（服务构造时读偏好，所以必须先清再建服务）
    await rm(prefPath, { force: true })
    await rm(defaultRoot, { recursive: true, force: true })
    await rm(legacyAsrRoot, { recursive: true, force: true })
  })

  function makeService(overrides?: {
    renameImpl?: (from: string, to: string) => Promise<void>
  }): AssetRootService {
    return createAssetRootService({
      prefPath,
      defaultRoot,
      legacyAsrRoot,
      ...overrides
    })
  }

  function readPref(): Record<string, string> {
    return JSON.parse(readFileSync(prefPath, 'utf-8')) as Record<string, string>
  }

  it('默认根首次启动：自动创建，状态 ok + isDefault，偏好落盘', async () => {
    const service = makeService()
    await service.setup()
    expect(existsSync(defaultRoot)).toBe(true)
    expect(service.root()).toBe(defaultRoot)
    expect(service.asrRoot()).toBe(join(defaultRoot, 'asr'))
    // P3V-16：GPT runtime 子目录必须在 ASSET_SUBDIRS 里（否则换根后会留在旧盘）
    expect(service.gptRuntimeRoot()).toBe(join(defaultRoot, 'gpt-runtime'))
    expect(service.status()).toEqual({
      isDefault: true,
      freeBytes: expect.any(Number),
      totalRequiredBytes: 0,
      state: 'ok'
    })
    expect(readPref()['root']).toBe(defaultRoot)
    expect(readPref()['activeRoot']).toBe(defaultRoot)
  })

  it('旧版 data/models/asr 一次性迁入新根 asr/，且二次启动不再动', async () => {
    await mkdir(legacyAsrRoot, { recursive: true })
    await writeFile(join(legacyAsrRoot, 'model.onnx'), 'm')
    const service = makeService()
    await service.setup()
    expect(existsSync(join(defaultRoot, 'asr', 'model.onnx'))).toBe(true)
    expect(existsSync(legacyAsrRoot)).toBe(false) // 源目录已搬走

    await service.setup()
    expect(existsSync(join(defaultRoot, 'asr', 'model.onnx'))).toBe(true)
  })

  it('setRoot：持久化偏好并返回 restartRequired；本会话 root 不变', async () => {
    const custom = join(base, 'custom-root')
    await mkdir(custom, { recursive: true })
    const service = makeService()
    await service.setup()
    const result = service.setRoot(custom)
    expect(result.changed).toBe(true)
    expect(result.restartRequired).toBe(true)
    expect(result.status.isDefault).toBe(false) // 状态快照反映新偏好根
    expect(service.root()).toBe(defaultRoot) // 本会话仍用旧根
    expect(readPref()['root']).toBe(custom)
    expect(readPref()['activeRoot']).toBe(defaultRoot)
    expect(service.restartRequired()).toBe(true)

    // 重复设置同一目录：幂等 no-op，但已有待重启状态不能被清掉
    const repeated = service.setRoot(custom)
    expect(repeated.changed).toBe(false)
    expect(repeated.restartRequired).toBe(true)
    // 不存在的目录：拒绝（选择器只给已存在目录，这是纵深防御）
    expect(service.setRoot(join(base, 'not-there')).changed).toBe(false)
  })

  it('下次启动完成迁移：子目录搬过去，activeRoot 更新', async () => {
    const custom = join(base, 'custom-root-2')
    await mkdir(custom, { recursive: true })
    const first = makeService()
    await first.setup()
    // 在默认根放一个模型文件，验证迁移真的搬了内容
    await mkdir(join(defaultRoot, 'asr'), { recursive: true })
    await writeFile(join(defaultRoot, 'asr', 'model.onnx'), 'm')
    first.setRoot(custom)
    expect(first.root()).toBe(defaultRoot) // 换根本会话不生效

    const second = makeService()
    await second.setup()
    expect(second.root()).toBe(custom)
    expect(second.asrRoot()).toBe(join(custom, 'asr'))
    expect(existsSync(join(custom, 'asr', 'model.onnx'))).toBe(true)
    expect(existsSync(join(defaultRoot, 'asr'))).toBe(false) // 源已搬走
    expect(readPref()['activeRoot']).toBe(custom)
    expect(second.status().isDefault).toBe(false)
  })

  it('自定义根丢失（盘被拔）：missing 明确报错，资产留在旧根、不回默认、不自动创建', async () => {
    const usbRoot = join(base, 'usb-root')
    await mkdir(usbRoot, { recursive: true })
    const service = makeService()
    await service.setup()
    await mkdir(join(defaultRoot, 'asr'), { recursive: true })
    await writeFile(join(defaultRoot, 'asr', 'model.onnx'), 'm')
    service.setRoot(usbRoot)
    // 模拟 U 盘被拔
    await rm(usbRoot, { recursive: true, force: true })

    const restarted = makeService()
    await restarted.setup()
    // 运行根仍是旧根（资产原地不动，等盘回来下次启动再迁）；状态反映用户选择
    expect(restarted.root()).toBe(defaultRoot)
    expect(existsSync(usbRoot)).toBe(false) // 不自动创建
    expect(existsSync(join(defaultRoot, 'asr', 'model.onnx'))).toBe(true) // 资产未动
    expect(restarted.status()).toEqual({
      isDefault: false,
      freeBytes: 0,
      totalRequiredBytes: 0,
      state: 'missing'
    })
    expect(readPref()['root']).toBe(usbRoot)
    expect(readPref()['activeRoot']).toBe(defaultRoot)
  })

  it('盘回来后的下一次启动：迁移真正执行', async () => {
    const usbRoot = join(base, 'usb-root-2')
    await mkdir(usbRoot, { recursive: true })
    const service = makeService()
    await service.setup()
    await mkdir(join(defaultRoot, 'asr'), { recursive: true })
    await writeFile(join(defaultRoot, 'asr', 'model.onnx'), 'm')
    service.setRoot(usbRoot)
    await rm(usbRoot, { recursive: true, force: true })
    const unplugged = makeService()
    await unplugged.setup() // 丢失会话：资产留在默认根
    expect(unplugged.root()).toBe(defaultRoot)

    // 盘回来了
    await mkdir(usbRoot, { recursive: true })
    const reattached = makeService()
    await reattached.setup()
    expect(reattached.root()).toBe(usbRoot)
    expect(existsSync(join(usbRoot, 'asr', 'model.onnx'))).toBe(true)
    expect(existsSync(join(defaultRoot, 'asr'))).toBe(false)
  })

  it('resetRoot：回到默认；重启前撤销 = 无需重启', async () => {
    const custom = join(base, 'custom-root-4')
    await mkdir(custom, { recursive: true })
    const service = makeService()
    await service.setup()
    service.setRoot(custom)
    const result = service.resetRoot()
    expect(result.changed).toBe(true)
    // activeRoot 从未离开默认根：偏好改回默认后没有待生效变更
    expect(result.restartRequired).toBe(false)
    expect(result.status.isDefault).toBe(true)
    // 已经是默认：幂等
    expect(service.resetRoot().changed).toBe(false)
  })

  it('跨盘迁移（EXDEV）：rename 失败回退 cp 复制 + 条目校验 + 删源', async () => {
    const custom = join(base, 'custom-root-5')
    await mkdir(custom, { recursive: true })
    await mkdir(join(defaultRoot, 'asr'), { recursive: true })
    await writeFile(join(defaultRoot, 'asr', 'a.onnx'), 'a')
    await writeFile(join(defaultRoot, 'asr', 'b.onnx'), 'b')
    // 先写偏好再构造（服务构造时读盘）——模拟「上次会话已选 custom、还没重启」
    writeFileSync(
      prefPath,
      JSON.stringify({ schemaVersion: 1, root: custom, activeRoot: defaultRoot })
    )
    const exdev = Object.assign(new Error('cross-device link not permitted'), { code: 'EXDEV' })
    const service = makeService({
      renameImpl: async () => {
        throw exdev
      }
    })
    await service.setup()
    expect(service.root()).toBe(custom)
    expect(existsSync(join(custom, 'asr', 'a.onnx'))).toBe(true)
    expect(existsSync(join(custom, 'asr', 'b.onnx'))).toBe(true)
    expect(existsSync(join(defaultRoot, 'asr'))).toBe(false) // 源已删
  })
})
