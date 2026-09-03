// src/main/voice/tts/voice-profile-registry.ts
// P3V-18：GPT-SoVITS 多音色 profile 注册表（main-only）。
//
// handoff §8 的四条硬要求在这里落地：
//   1. 每个 profile **显式**保存版本 / GPT 权重 / SoVITS 权重 / 参考音频 /
//      prompt 文本与语言 / 默认文本语言——没有一项靠运行时猜。
//   2. **不做笛卡尔积**：10 个 GPT 导出 × 7 个 SoVITS 导出不会自动变成 70 个音色。
//      只有两个来源进注册表——安装里 `custom:` 当前配置读出的那一个（discovered），
//      以及用户自己导入并逐项确认过的（imported）。
//   3. renderer 只见 id / 显示名 / 版本 / 语言 / 状态，**不见任何绝对路径**。
//   4. 外部目录只读：这里只 existsSync 校验，绝不写用户的 GPT-SoVITS 目录；
//      导入的 profile 只把路径记在 Nacime 自己的 main 私有 JSON 里。
//
// 「谁是当前音色」不在这里——唯一真源仍是 config `tts.voiceId`（F5-007 §1.3：
// voiceId 空 = 纯文字，绝不自动挑一个音色顶上）。本注册表只回答「有哪些、是什么」。

import { existsSync, readFileSync } from 'node:fs'
import { atomicWriteJson } from '../../migrations/atomic-json'
import type { GptVoiceProfileView } from '@shared/voice/gpt-runtime-types'
import type { GptSovitsVoiceConfig } from './gpt-sovits-provider'
import { gptVoiceProfileId, type GptSovitsInstallation } from './gpt-sovits-installation'

/** 一个可用音色的完整定义（含路径，main-only）。 */
export interface GptVoiceProfile {
  readonly id: string
  readonly displayName: string
  /** GPT-SoVITS 模型版本（v2Pro / v2ProPlus / v4…）——切权重时要按版本核对。 */
  readonly version: string
  readonly gptWeightsPath: string
  readonly sovitsWeightsPath: string
  readonly refAudioPath: string
  readonly promptText: string
  readonly promptLang: string
  readonly defaultTextLang: string
  /** discovered=从安装的 custom 配置读出；imported=用户导入。 */
  readonly source: 'discovered' | 'imported'
}

/** 导入一个音色所需的全部信息（P3V-20 的 UI 逐项收集，不猜）。 */
export interface GptVoiceProfileInput {
  readonly displayName: string
  readonly version: string
  readonly gptWeightsPath: string
  readonly sovitsWeightsPath: string
  readonly refAudioPath: string
  readonly promptText: string
  readonly promptLang: string
  readonly defaultTextLang: string
}

interface StoredProfile extends GptVoiceProfileInput {
  readonly id: string
  readonly createdAt: number
}

interface ProfileFile {
  readonly schemaVersion: 1
  readonly profiles: readonly StoredProfile[]
}

export interface VoiceProfileRegistryDeps {
  /** 导入音色的持久化文件（生产 {userData}/gpt-voice-profiles.json）。 */
  readonly storePath: string
  /** 本会话发现的安装（null=没有可用运行时；其 custom 音色作为 discovered profile）。 */
  readonly installation: () => GptSovitsInstallation | null
  /** 当前时间（测试注入）。 */
  readonly now?: () => number
}

export interface VoiceProfileRegistry {
  /** 全部音色：discovered 在前，imported 按导入顺序在后。 */
  list(): readonly GptVoiceProfile[]
  get(id: string): GptVoiceProfile | null
  /** provider 解析用（含路径）；未知 id 返回 null（→ voice-missing 纯文字）。 */
  resolveVoiceConfig(id: string): GptSovitsVoiceConfig | null
  /** renderer 投影（无路径）。currentVoiceId 来自 config `tts.voiceId`。 */
  views(currentVoiceId: string): readonly GptVoiceProfileView[]
  /** 导入（同一组权重+参考音频重复导入不产生第二条）。 */
  add(input: GptVoiceProfileInput): { added: boolean; id: string }
  /** 删除导入的音色；discovered 的删不掉（它来自安装本身的配置）。 */
  remove(id: string): boolean
}

function readStore(storePath: string): ProfileFile {
  try {
    if (existsSync(storePath)) {
      const raw: unknown = JSON.parse(readFileSync(storePath, 'utf-8'))
      if (typeof raw === 'object' && raw !== null) {
        const list = (raw as Record<string, unknown>)['profiles']
        if (Array.isArray(list)) {
          const profiles = list.filter((p): p is StoredProfile => {
            if (typeof p !== 'object' || p === null) return false
            const v = p as Record<string, unknown>
            return (
              typeof v['id'] === 'string' &&
              typeof v['displayName'] === 'string' &&
              typeof v['version'] === 'string' &&
              typeof v['gptWeightsPath'] === 'string' &&
              typeof v['sovitsWeightsPath'] === 'string' &&
              typeof v['refAudioPath'] === 'string' &&
              typeof v['promptText'] === 'string' &&
              typeof v['promptLang'] === 'string' &&
              typeof v['defaultTextLang'] === 'string'
            )
          })
          return { schemaVersion: 1, profiles }
        }
      }
    }
  } catch {
    /* 损坏 → 当作没有导入音色（discovered 的仍然可用，不至于整个语音瘫掉） */
  }
  return { schemaVersion: 1, profiles: [] }
}

/** 三个文件都在才算 ready；缺任何一个都如实报 missing-files，不假装能出声。 */
function profileState(profile: GptVoiceProfile): GptVoiceProfileView['state'] {
  const files = [profile.gptWeightsPath, profile.sovitsWeightsPath, profile.refAudioPath]
  return files.every((p) => p.length > 0 && existsSync(p)) ? 'ready' : 'missing-files'
}

export function createVoiceProfileRegistry(deps: VoiceProfileRegistryDeps): VoiceProfileRegistry {
  const now = deps.now ?? Date.now
  let stored = readStore(deps.storePath)

  function discovered(): GptVoiceProfile | null {
    const installation = deps.installation()
    if (installation === null) return null
    return {
      id: installation.voice.id,
      displayName: installation.voice.displayName,
      version: installation.version,
      gptWeightsPath: installation.gptWeightsPath,
      sovitsWeightsPath: installation.sovitsWeightsPath,
      refAudioPath: installation.voice.refAudioPath,
      promptText: installation.voice.promptText ?? '',
      promptLang: installation.voice.promptLang,
      defaultTextLang: installation.voice.defaultTextLang,
      source: 'discovered'
    }
  }

  function all(): GptVoiceProfile[] {
    const result: GptVoiceProfile[] = []
    const seen = new Set<string>()
    const first = discovered()
    if (first !== null) {
      result.push(first)
      seen.add(first.id)
    }
    for (const p of stored.profiles) {
      // 同一组合已由安装的 custom 配置提供时不重复列出
      if (seen.has(p.id)) continue
      seen.add(p.id)
      result.push({
        id: p.id,
        displayName: p.displayName,
        version: p.version,
        gptWeightsPath: p.gptWeightsPath,
        sovitsWeightsPath: p.sovitsWeightsPath,
        refAudioPath: p.refAudioPath,
        promptText: p.promptText,
        promptLang: p.promptLang,
        defaultTextLang: p.defaultTextLang,
        source: 'imported'
      })
    }
    return result
  }

  return {
    list: all,

    get(id) {
      return all().find((p) => p.id === id) ?? null
    },

    resolveVoiceConfig(id) {
      const profile = all().find((p) => p.id === id)
      if (profile === null || profile === undefined) return null
      return {
        refAudioPath: profile.refAudioPath,
        promptText: profile.promptText,
        promptLang: profile.promptLang,
        defaultTextLang: profile.defaultTextLang,
        // P3V-19：带上权重 → provider 合成前串行 set_gpt/set_sovits_weights
        gptWeightsPath: profile.gptWeightsPath,
        sovitsWeightsPath: profile.sovitsWeightsPath
      }
    },

    views(currentVoiceId) {
      return all().map((profile) => ({
        id: profile.id,
        displayName: profile.displayName,
        version: profile.version,
        promptLang: profile.promptLang,
        defaultTextLang: profile.defaultTextLang,
        state: profileState(profile),
        source: profile.source,
        current: profile.id === currentVoiceId
      }))
    },

    add(input) {
      const id = gptVoiceProfileId(
        input.gptWeightsPath,
        input.sovitsWeightsPath,
        input.refAudioPath
      )
      if (all().some((p) => p.id === id)) return { added: false, id }
      stored = {
        schemaVersion: 1,
        profiles: [...stored.profiles, { ...input, id, createdAt: now() }]
      }
      atomicWriteJson(deps.storePath, stored)
      return { added: true, id }
    },

    remove(id) {
      if (!stored.profiles.some((p) => p.id === id)) return false
      stored = { schemaVersion: 1, profiles: stored.profiles.filter((p) => p.id !== id) }
      atomicWriteJson(deps.storePath, stored)
      return true
    }
  }
}
