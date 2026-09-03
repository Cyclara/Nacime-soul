// src/main/voice/tts/gpt-runtime-source.ts
// P3V-17：GPT-SoVITS 运行时来源（自动发现 / 用户指定已有目录）。main-only。
//
// 三种来源，优先级自上而下：
//   1. 用户显式指定的目录（mode='custom'）——只用它，**不再偷偷回退**到扫描结果；
//      指定的盘拔了就如实报「不可用」，与 asset-root 的「丢失三不」同一条纪律。
//   2. Nacime 自有一键安装（{assetRoot}/gpt-runtime/gpt-sovits）。
//   3. 只读扫描（环境变量 + Windows C/D/E 常见目录）——mode='auto' 才做。
//
// 路径纪律：选择结果持久化在 **main 私有 gpt-runtime-source.json**，不进 renderer
// 可读的 config；renderer 只见 mode/active/voiceConfigured/restartRequired 四个布尔量。
//
// 外部目录永远只读：这里只 existsSync / 读 yaml，绝不写入用户已有的 GPT-SoVITS 目录。
//
// 生效时机：与换资源根同款——**本会话不热切换**。运行中的 api_v2 子进程与已注册的
// provider 不重建（8GB 级运行时换根意味着重启 Python、丢掉已加载权重），改选择只写
// 偏好并回 restartRequired=true。

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteJson } from '../../migrations/atomic-json'
import {
  discoverGptSovitsInstallation,
  type GptSovitsInstallation
} from './gpt-sovits-installation'

/** 来源模式：auto=自动发现；custom=用户指定目录。 */
export type GptRuntimeSourceMode = 'auto' | 'custom'

/** 目录被拒的原因（闭集；UI 据此给人话，不自由拼错误文本）。 */
export type GptRuntimeSourceRejection = 'cancelled' | 'not-gpt-sovits'

interface SourcePref {
  readonly schemaVersion: 1
  readonly mode: GptRuntimeSourceMode
  /** mode='custom' 时的用户目录；auto 时为空串。 */
  readonly rootDir: string
}

export interface GptRuntimeSourceServiceDeps {
  /** 偏好持久化文件（生产 {userData}/gpt-runtime-source.json）。 */
  readonly prefPath: string
  /** Nacime 一键安装根（{assetRoot}/gpt-runtime/gpt-sovits）。 */
  readonly nacimeInstallRoot: () => string
  /** 注入只读发现（测试用）；默认 discoverGptSovitsInstallation。 */
  readonly discover?: (
    extraCandidates: readonly string[],
    includeCommonLocations: boolean
  ) => GptSovitsInstallation | null
}

export interface GptRuntimeSourceService {
  /** 本会话定格的安装（启动期调一次；null=没有可用运行时 → 产品退纯文字）。 */
  resolveInstallation(): GptSovitsInstallation | null
  mode(): GptRuntimeSourceMode
  /** 本会话是否真的在用一个可用运行时。 */
  active(): boolean
  /** 当前（含待生效）选择的目录里是否已有配好的音色；false = 还得导入音色才能出声。 */
  voiceConfigured(): boolean
  /** 偏好指向的目录与本会话实际使用的不同 → 需要重启才生效。 */
  restartRequired(): boolean
  /** 采纳用户选择的目录（只做运行时校验，不写外部目录）。 */
  setCustomDirectory(dir: string): {
    accepted: boolean
    changed: boolean
    reason?: 'not-gpt-sovits'
  }
  /** 回到自动发现（清除用户指定）。 */
  clearCustomDirectory(): { changed: boolean }
}

/** 判定一个目录是不是 GPT-SoVITS 整合包（不看音色，只看运行时三件套）。 */
export function isGptSovitsRuntimeDirectory(rootDir: string): boolean {
  if (rootDir.length === 0) return false
  const python = join(rootDir, 'runtime', process.platform === 'win32' ? 'python.exe' : 'python')
  return (
    existsSync(python) &&
    existsSync(join(rootDir, 'api_v2.py')) &&
    existsSync(join(rootDir, 'GPT_SoVITS', 'configs', 'tts_infer.yaml'))
  )
}

function normalizePath(p: string): string {
  return p.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
}

function samePath(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b
  return normalizePath(a) === normalizePath(b)
}

function readPref(prefPath: string): SourcePref {
  try {
    if (existsSync(prefPath)) {
      const raw: unknown = JSON.parse(readFileSync(prefPath, 'utf-8'))
      if (typeof raw === 'object' && raw !== null) {
        const v = raw as Record<string, unknown>
        if ((v['mode'] === 'auto' || v['mode'] === 'custom') && typeof v['rootDir'] === 'string') {
          return { schemaVersion: 1, mode: v['mode'], rootDir: v['rootDir'] }
        }
      }
    }
  } catch {
    /* 损坏 → 回自动发现（不影响本会话启动） */
  }
  return { schemaVersion: 1, mode: 'auto', rootDir: '' }
}

export function createGptRuntimeSourceService(
  deps: GptRuntimeSourceServiceDeps
): GptRuntimeSourceService {
  const discover = deps.discover ?? discoverGptSovitsInstallation
  let pref = readPref(deps.prefPath)
  /** 本会话实际使用的根（resolveInstallation 定格；null=没找到可用运行时）。 */
  let activeRootDir: string | null = null

  /** 偏好当前指向哪个目录（还没生效也算）；null = 自动模式下也没有可用候选。 */
  function preferredRootDir(): string | null {
    if (pref.mode === 'custom') return pref.rootDir
    const nacime = deps.nacimeInstallRoot()
    if (isGptSovitsRuntimeDirectory(nacime)) return nacime
    return activeRootDir
  }

  return {
    resolveInstallation() {
      const installation =
        pref.mode === 'custom'
          ? discover([pref.rootDir], false)
          : discover([deps.nacimeInstallRoot()], true)
      activeRootDir = installation?.rootDir ?? null
      return installation
    },

    mode() {
      return pref.mode
    },

    active() {
      return activeRootDir !== null
    },

    voiceConfigured() {
      const preferred = preferredRootDir()
      if (preferred === null) return false
      // 稳态（偏好就是本会话在用的那个）：已注册即说明音色配好了，不再重扫盘
      if (samePath(preferred, activeRootDir)) return activeRootDir !== null
      return discover([preferred], false) !== null
    },

    restartRequired() {
      return !samePath(preferredRootDir(), activeRootDir)
    },

    setCustomDirectory(dir) {
      if (!isGptSovitsRuntimeDirectory(dir)) {
        return { accepted: false, changed: false, reason: 'not-gpt-sovits' }
      }
      if (pref.mode === 'custom' && samePath(pref.rootDir, dir)) {
        return { accepted: true, changed: false }
      }
      pref = { schemaVersion: 1, mode: 'custom', rootDir: dir }
      atomicWriteJson(deps.prefPath, pref)
      return { accepted: true, changed: true }
    },

    clearCustomDirectory() {
      if (pref.mode === 'auto') return { changed: false }
      pref = { schemaVersion: 1, mode: 'auto', rootDir: '' }
      atomicWriteJson(deps.prefPath, pref)
      return { changed: true }
    }
  }
}
