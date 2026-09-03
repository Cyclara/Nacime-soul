// src/main/voice/tts/voice-profile-registry.test.ts
// P3V-18：多音色注册表合同。
//
// 纪律焦点（handoff §8）：
//   - 不做 checkpoint 笛卡尔积——注册表只收「安装当前配置的那一个」+「用户逐项确认导入的」；
//   - 投影不含任何路径；
//   - 权重/参考音频缺文件时如实 missing-files，不假装能出声；
//   - discovered 删不掉（它来自安装自身的配置），imported 才能删。
// 全程只读外部目录：临时目录里造假文件，不碰任何真实 GPT-SoVITS 安装。

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isGptVoiceProfileView } from '@shared/voice/gpt-runtime-types'
import {
  createVoiceProfileRegistry,
  type GptVoiceProfileInput,
  type VoiceProfileRegistry
} from './voice-profile-registry'
import { gptVoiceProfileId, type GptSovitsInstallation } from './gpt-sovits-installation'

let root = ''
let storePath = ''

async function touch(relative: string): Promise<string> {
  const full = join(root, relative)
  await mkdir(join(full, '..'), { recursive: true })
  await writeFile(full, 'x')
  return full
}

function installation(paths: { gpt: string; sovits: string; ref: string }): GptSovitsInstallation {
  const rootDir = join(root, 'pkg')
  return {
    rootDir,
    pythonPath: join(rootDir, 'runtime', 'python.exe'),
    apiScriptPath: join(rootDir, 'api_v2.py'),
    ttsConfigPath: join(rootDir, 'GPT_SoVITS', 'configs', 'tts_infer.yaml'),
    version: 'v2ProPlus',
    gptWeightsPath: paths.gpt,
    sovitsWeightsPath: paths.sovits,
    voice: {
      id: gptVoiceProfileId(paths.gpt, paths.sovits, paths.ref),
      displayName: '爱莉希雅2.0（v2ProPlus）',
      refAudioPath: paths.ref,
      promptText: '今天也是元气满满的一天',
      promptLang: 'zh',
      defaultTextLang: 'zh'
    }
  }
}

function makeRegistry(inst: GptSovitsInstallation | null): VoiceProfileRegistry {
  return createVoiceProfileRegistry({
    storePath,
    installation: () => inst,
    now: () => 1_756_000_000_000
  })
}

async function importInput(name: string): Promise<GptVoiceProfileInput> {
  return {
    displayName: `${name}（v2ProPlus）`,
    version: 'v2ProPlus',
    gptWeightsPath: await touch(`imported/${name}-e15.ckpt`),
    sovitsWeightsPath: await touch(`imported/${name}-e8.pth`),
    refAudioPath: await touch(`imported/${name}-ref.wav`),
    promptText: 'おはようございます',
    promptLang: 'ja',
    defaultTextLang: 'ja'
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'nacime-voice-profiles-'))
  storePath = join(root, 'gpt-voice-profiles.json')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

beforeEach(async () => {
  await rm(storePath, { force: true })
})

describe('P3V-18 discovered 音色', () => {
  it('安装的 custom 配置 = 唯一 discovered 音色（不按 checkpoint 笛卡尔积膨胀）', async () => {
    const inst = installation({
      gpt: await touch('pkg/gpt-e15.ckpt'),
      sovits: await touch('pkg/sovits-e8.pth'),
      ref: await touch('pkg/ref.wav')
    })
    const registry = makeRegistry(inst)
    const list = registry.list()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({
      id: inst.voice.id,
      version: 'v2ProPlus',
      promptLang: 'zh',
      source: 'discovered'
    })
    // 每项都显式保存（版本/两个权重/参考音频/prompt 文本与语言/默认文本语言）
    expect(list[0]?.gptWeightsPath).toBe(inst.gptWeightsPath)
    expect(list[0]?.sovitsWeightsPath).toBe(inst.sovitsWeightsPath)
    expect(list[0]?.promptText).toBe('今天也是元气满满的一天')
  })

  it('没有安装：注册表为空，resolveVoiceConfig 一律 null（→ 纯文字）', () => {
    const registry = makeRegistry(null)
    expect(registry.list()).toEqual([])
    expect(registry.resolveVoiceConfig('gpt-sovits:anything')).toBeNull()
    expect(registry.views('')).toEqual([])
  })

  it('discovered 删不掉（它来自安装自身的配置）', async () => {
    const inst = installation({
      gpt: await touch('pkg2/gpt.ckpt'),
      sovits: await touch('pkg2/sovits.pth'),
      ref: await touch('pkg2/ref.wav')
    })
    const registry = makeRegistry(inst)
    expect(registry.remove(inst.voice.id)).toBe(false)
    expect(registry.list()).toHaveLength(1)
  })
})

describe('P3V-18 导入音色', () => {
  it('导入后落盘、可解析、可删除；同一组合重复导入不产生第二条', async () => {
    const registry = makeRegistry(null)
    const input = await importInput('emma')
    const added = registry.add(input)
    expect(added.added).toBe(true)
    expect(added.id).toBe(
      gptVoiceProfileId(input.gptWeightsPath, input.sovitsWeightsPath, input.refAudioPath)
    )
    expect(registry.list()).toHaveLength(1)
    // P3V-19：解析结果必须带权重——provider 靠它决定要不要切模型
    expect(registry.resolveVoiceConfig(added.id)).toEqual({
      refAudioPath: input.refAudioPath,
      promptText: 'おはようございます',
      promptLang: 'ja',
      defaultTextLang: 'ja',
      gptWeightsPath: input.gptWeightsPath,
      sovitsWeightsPath: input.sovitsWeightsPath
    })

    // 幂等：同样的权重+参考音频再导一次
    expect(registry.add(input)).toEqual({ added: false, id: added.id })
    expect(registry.list()).toHaveLength(1)

    // 重启后仍在（读同一个 store 文件）
    const reloaded = makeRegistry(null)
    expect(reloaded.list()).toHaveLength(1)
    expect(reloaded.list()[0]?.source).toBe('imported')

    expect(registry.remove(added.id)).toBe(true)
    expect(registry.list()).toEqual([])
    expect(JSON.parse(readFileSync(storePath, 'utf-8'))).toEqual({
      schemaVersion: 1,
      profiles: []
    })
  })

  it('导入的与安装 custom 是同一组合时不重复列出', async () => {
    const gpt = await touch('dedupe/gpt.ckpt')
    const sovits = await touch('dedupe/sovits.pth')
    const ref = await touch('dedupe/ref.wav')
    const registry = makeRegistry(installation({ gpt, sovits, ref }))
    registry.add({
      displayName: '重复导入',
      version: 'v2ProPlus',
      gptWeightsPath: gpt,
      sovitsWeightsPath: sovits,
      refAudioPath: ref,
      promptText: '你好',
      promptLang: 'zh',
      defaultTextLang: 'zh'
    })
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]?.source).toBe('discovered')
  })

  it('store 损坏 → 当作没有导入音色，discovered 仍可用', async () => {
    await writeFile(storePath, '{ broken')
    const inst = installation({
      gpt: await touch('pkg3/gpt.ckpt'),
      sovits: await touch('pkg3/sovits.pth'),
      ref: await touch('pkg3/ref.wav')
    })
    const registry = makeRegistry(inst)
    expect(registry.list()).toHaveLength(1)
    expect(registry.list()[0]?.source).toBe('discovered')
  })
})

describe('P3V-18 renderer 投影', () => {
  it('只含 id/显示名/版本/语言/状态/来源/current——绝无路径', async () => {
    const inst = installation({
      gpt: await touch('view/gpt.ckpt'),
      sovits: await touch('view/sovits.pth'),
      ref: await touch('view/ref.wav')
    })
    const registry = makeRegistry(inst)
    const views = registry.views(inst.voice.id)
    expect(views).toHaveLength(1)
    expect(views.every(isGptVoiceProfileView)).toBe(true)
    expect(views[0]?.current).toBe(true)
    expect(views[0]?.state).toBe('ready')
    expect(JSON.stringify(views)).not.toMatch(/[A-Za-z]:[/\\]/)
    // 未选中任何音色时 current 全 false（不自动挑一个顶上）
    expect(registry.views('')[0]?.current).toBe(false)
  })

  it('权重/参考音频不在了 → missing-files（外接盘拔掉的真实场景）', async () => {
    const gpt = await touch('gone/gpt.ckpt')
    const sovits = await touch('gone/sovits.pth')
    const ref = await touch('gone/ref.wav')
    const registry = makeRegistry(installation({ gpt, sovits, ref }))
    expect(registry.views('')[0]?.state).toBe('ready')

    await rm(ref)
    expect(existsSync(ref)).toBe(false)
    expect(registry.views('')[0]?.state).toBe('missing-files')
  })
})
