// src/main/voice/tts/gpt-runtime-source.test.ts
// P3V-17：运行时来源选择合同。
//
// 纪律焦点：
//   - 用户显式指定后**不再偷偷回退**到扫描结果（盘拔了就如实不可用）；
//   - 选择只写偏好，本会话不热切换（restartRequired=true）；
//   - 只读：全过程不写用户目录（只在临时目录建假整合包骨架 + 自己的偏好文件）。
// 不启动任何 Python，不做真发现——discover 注入。

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createGptRuntimeSourceService,
  isGptSovitsRuntimeDirectory,
  type GptRuntimeSourceService
} from './gpt-runtime-source'
import type { GptSovitsInstallation } from './gpt-sovits-installation'

let root = ''

/** 建一个「像 GPT-SoVITS 整合包」的目录骨架（运行时三件套，不含音色）。 */
async function makeRuntimeDir(name: string): Promise<string> {
  const dir = join(root, name)
  await mkdir(join(dir, 'runtime'), { recursive: true })
  await mkdir(join(dir, 'GPT_SoVITS', 'configs'), { recursive: true })
  await writeFile(join(dir, 'runtime', process.platform === 'win32' ? 'python.exe' : 'python'), '')
  await writeFile(join(dir, 'api_v2.py'), '')
  await writeFile(join(dir, 'GPT_SoVITS', 'configs', 'tts_infer.yaml'), 'custom:\n')
  return dir
}

function installation(rootDir: string): GptSovitsInstallation {
  return {
    rootDir,
    pythonPath: join(rootDir, 'runtime', 'python.exe'),
    apiScriptPath: join(rootDir, 'api_v2.py'),
    ttsConfigPath: join(rootDir, 'GPT_SoVITS', 'configs', 'tts_infer.yaml'),
    version: 'v2Pro',
    gptWeightsPath: join(rootDir, 'a.ckpt'),
    sovitsWeightsPath: join(rootDir, 'b.pth'),
    voice: {
      id: 'gpt-sovits:abc',
      displayName: '测试音色（v2Pro）',
      refAudioPath: join(rootDir, 'ref.wav'),
      promptText: '你好',
      promptLang: 'zh',
      defaultTextLang: 'zh'
    }
  }
}

interface Harness {
  prefPath: string
  nacimeRoot: string
  discover: ReturnType<typeof vi.fn>
  service: GptRuntimeSourceService
}

function makeService(
  nacimeRoot: string,
  discover: (extra: readonly string[], common: boolean) => GptSovitsInstallation | null = () =>
    null,
  prefName = 'gpt-runtime-source.json'
): Harness {
  const prefPath = join(root, prefName)
  const spy = vi.fn(discover)
  return {
    prefPath,
    nacimeRoot,
    discover: spy,
    service: createGptRuntimeSourceService({
      prefPath,
      nacimeInstallRoot: () => nacimeRoot,
      discover: spy as unknown as (
        extra: readonly string[],
        common: boolean
      ) => GptSovitsInstallation | null
    })
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'nacime-gpt-source-'))
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

beforeEach(async () => {
  await rm(join(root, 'gpt-runtime-source.json'), { force: true })
})

describe('P3V-17 isGptSovitsRuntimeDirectory', () => {
  it('运行时三件套齐全才算整合包（缺 api_v2.py 就不算）', async () => {
    const dir = await makeRuntimeDir('probe-ok')
    expect(isGptSovitsRuntimeDirectory(dir)).toBe(true)

    await rm(join(dir, 'api_v2.py'))
    expect(isGptSovitsRuntimeDirectory(dir)).toBe(false)
    expect(isGptSovitsRuntimeDirectory(join(root, 'not-there'))).toBe(false)
    expect(isGptSovitsRuntimeDirectory('')).toBe(false)
  })
})

describe('P3V-17 自动模式', () => {
  it('默认 auto：把 Nacime 自有安装作为首选候选，并允许扫描常见目录', async () => {
    const nacime = await makeRuntimeDir('nacime-install')
    const h = makeService(nacime, (extra, common) =>
      extra[0] === nacime && common ? installation(nacime) : null
    )
    const found = h.service.resolveInstallation()
    expect(found?.rootDir).toBe(nacime)
    expect(h.discover).toHaveBeenCalledWith([nacime], true)
    expect(h.service.mode()).toBe('auto')
    expect(h.service.active()).toBe(true)
    expect(h.service.voiceConfigured()).toBe(true)
    expect(h.service.restartRequired()).toBe(false)
  })

  it('没有任何可用运行时：active=false、voiceConfigured=false，不谎报就绪', () => {
    const h = makeService(join(root, 'nowhere'))
    expect(h.service.resolveInstallation()).toBeNull()
    expect(h.service.active()).toBe(false)
    expect(h.service.voiceConfigured()).toBe(false)
    expect(h.service.restartRequired()).toBe(false)
  })

  it('本会话没找到，但一键安装已落盘 → restartRequired=true（重启才生效）', async () => {
    const nacime = await makeRuntimeDir('installed-after-boot')
    // 启动时还没装：discover 返回 null
    const h = makeService(nacime, () => null)
    expect(h.service.resolveInstallation()).toBeNull()
    expect(h.service.active()).toBe(false)
    // 安装完成后目录已经在了 → 偏好指向它，与本会话（无）不同
    expect(h.service.restartRequired()).toBe(true)
  })
})

describe('P3V-17 用户指定目录', () => {
  it('采纳后写偏好、重启生效，且下次启动只查这个目录（不扫描常见位置）', async () => {
    const nacime = await makeRuntimeDir('nacime-1')
    const custom = await makeRuntimeDir('user-pkg')
    const h = makeService(nacime, (extra) =>
      extra[0] === nacime ? installation(nacime) : installation(custom)
    )
    h.service.resolveInstallation()

    const result = h.service.setCustomDirectory(custom)
    expect(result).toEqual({ accepted: true, changed: true })
    expect(h.service.mode()).toBe('custom')
    // 本会话仍在用旧的：不热切换
    expect(h.service.active()).toBe(true)
    expect(h.service.restartRequired()).toBe(true)
    expect(JSON.parse(readFileSync(h.prefPath, 'utf-8'))).toEqual({
      schemaVersion: 1,
      mode: 'custom',
      rootDir: custom
    })

    // 重启：新服务读偏好 → 只查用户目录、不扫描常见位置
    const next = makeService(nacime, () => installation(custom))
    expect(next.service.resolveInstallation()?.rootDir).toBe(custom)
    expect(next.discover).toHaveBeenCalledWith([custom], false)
    expect(next.service.restartRequired()).toBe(false)
  })

  it('同一个目录重复选：accepted 但 changed=false（不产生假的待重启）', async () => {
    const custom = await makeRuntimeDir('user-same')
    const h = makeService(join(root, 'nacime-2'), () => installation(custom))
    h.service.setCustomDirectory(custom)
    expect(h.service.setCustomDirectory(custom)).toEqual({ accepted: true, changed: false })
  })

  it('不是整合包目录：拒绝且不写偏好', async () => {
    const notPkg = join(root, 'random-folder')
    await mkdir(notPkg, { recursive: true })
    const h = makeService(join(root, 'nacime-3'))
    expect(h.service.setCustomDirectory(notPkg)).toEqual({
      accepted: false,
      changed: false,
      reason: 'not-gpt-sovits'
    })
    expect(h.service.mode()).toBe('auto')
    expect(existsSync(h.prefPath)).toBe(false)
  })

  it('指定目录里没有配好的音色：接受目录但 voiceConfigured=false（不谎报能出声）', async () => {
    const custom = await makeRuntimeDir('user-no-voice')
    const h = makeService(join(root, 'nacime-4'), () => null)
    h.service.resolveInstallation()
    expect(h.service.setCustomDirectory(custom).accepted).toBe(true)
    expect(h.service.voiceConfigured()).toBe(false)
    expect(h.service.restartRequired()).toBe(true)
  })

  it('指定的盘拔了：如实不可用，不偷偷回退到扫描结果', async () => {
    const scanned = await makeRuntimeDir('scanned-elsewhere')
    const gone = join(root, 'removed-drive-pkg')
    await mkdir(join(gone, 'runtime'), { recursive: true })
    await mkdir(join(gone, 'GPT_SoVITS', 'configs'), { recursive: true })
    await writeFile(
      join(gone, 'runtime', process.platform === 'win32' ? 'python.exe' : 'python'),
      ''
    )
    await writeFile(join(gone, 'api_v2.py'), '')
    await writeFile(join(gone, 'GPT_SoVITS', 'configs', 'tts_infer.yaml'), 'custom:\n')

    const h = makeService(join(root, 'nacime-5'), () => installation(gone))
    expect(h.service.setCustomDirectory(gone).accepted).toBe(true)

    // 盘被拔：目录不在了
    await rm(gone, { recursive: true, force: true })
    const next = makeService(
      join(root, 'nacime-5'),
      // 生产 discover 对不存在的目录返回 null；扫描到的 scanned 不该被顶上来
      (extra) => (extra[0] === gone ? null : installation(scanned))
    )
    expect(next.service.resolveInstallation()).toBeNull()
    expect(next.discover).toHaveBeenCalledWith([gone], false)
    expect(next.service.active()).toBe(false)
    expect(next.service.mode()).toBe('custom')
  })

  it('清除用户指定 → 回自动发现（重启生效）', async () => {
    const custom = await makeRuntimeDir('user-clear')
    const nacime = await makeRuntimeDir('nacime-6')
    const h = makeService(nacime, () => installation(custom))
    h.service.setCustomDirectory(custom)
    h.service.resolveInstallation()
    expect(h.service.mode()).toBe('custom')

    expect(h.service.clearCustomDirectory()).toEqual({ changed: true })
    expect(h.service.mode()).toBe('auto')
    expect(JSON.parse(readFileSync(h.prefPath, 'utf-8'))).toEqual({
      schemaVersion: 1,
      mode: 'auto',
      rootDir: ''
    })
    // 已经是 auto 再清一次：无变化
    expect(h.service.clearCustomDirectory()).toEqual({ changed: false })
  })

  it('偏好文件损坏 → 回自动发现，不影响启动', async () => {
    const nacime = await makeRuntimeDir('nacime-7')
    const prefPath = join(root, 'gpt-runtime-source.json')
    await writeFile(prefPath, '{ not json')
    const h = makeService(nacime, () => installation(nacime))
    expect(h.service.mode()).toBe('auto')
    expect(h.service.resolveInstallation()?.rootDir).toBe(nacime)
  })
})
