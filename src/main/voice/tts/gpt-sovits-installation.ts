// src/main/voice/tts/gpt-sovits-installation.ts
// 2026-09-02：只读发现用户已有 GPT-SoVITS 整合包与当前 custom 音色。
//
// 绝不修改外部 GPT-SoVITS 目录：只验证 runtime/python.exe、api_v2.py、tts_infer.yaml、
// custom 权重与参考音频。Nacime 自己的 launcher 位于 resources/voice，运行时把官方
// api_v2.py 当子进程启动；退出用 taskkill /T 连同子进程树清理。
//
// 路径只留在 main 进程；renderer 的 VoicePublicSnapshot 只见 voice id/displayName。

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from 'node:path'
import type { GptSovitsVoiceConfig } from './gpt-sovits-provider'
import { GPT_SOVITS_PROVIDER_ID } from './gpt-sovits-constants'

export interface GptSovitsInstallation {
  readonly rootDir: string
  readonly pythonPath: string
  readonly apiScriptPath: string
  readonly ttsConfigPath: string
  readonly version: string
  readonly gptWeightsPath: string
  readonly sovitsWeightsPath: string
  readonly voice: GptSovitsVoiceProfile
}

export interface GptSovitsVoiceProfile extends GptSovitsVoiceConfig {
  readonly id: string
  readonly displayName: string
}

/**
 * 音色 id 的唯一推导（P3V-18 起被 profile 注册表复用）：
 * 三个权重/参考音频路径的规范化哈希——同一组合无论从 tts_infer.yaml 读出还是用户
 * 手动导入，都得到同一个 id（既能去重，又让老用户已存的 `tts.voiceId` 继续命中）。
 */
export function gptVoiceProfileId(
  gptWeightsPath: string,
  sovitsWeightsPath: string,
  refAudioPath: string
): string {
  const hash = createHash('sha256')
    .update(
      `${normalize(gptWeightsPath)}\0${normalize(sovitsWeightsPath)}\0${normalize(refAudioPath)}`
    )
    .digest('hex')
    .slice(0, 12)
  return `${GPT_SOVITS_PROVIDER_ID}:${hash}`
}

interface ParsedCustomConfig {
  readonly version: string
  readonly t2sWeightsPath: string
  readonly vitsWeightsPath: string
}

function parseCustomConfig(yaml: string): ParsedCustomConfig | null {
  const lines = yaml.split(/\r?\n/)
  const customStart = lines.findIndex((line) => /^custom:\s*$/.test(line))
  if (customStart < 0) return null
  const values = new Map<string, string>()
  for (let i = customStart + 1; i < lines.length; i += 1) {
    const line = lines[i]!
    if (/^[^\s#][^:]*:\s*/.test(line)) break // 下一个顶层 section
    const match = /^\s{2}([A-Za-z0-9_]+):\s*(.+?)\s*$/.exec(line)
    if (match === null) continue
    const raw = match[2]!.replace(/^['"]|['"]$/g, '')
    values.set(match[1]!, decodeYamlEscapes(raw))
  }
  const version = values.get('version')
  const t2sWeightsPath = values.get('t2s_weights_path')
  const vitsWeightsPath = values.get('vits_weights_path')
  if (!version || !t2sWeightsPath || !vitsWeightsPath) return null
  return { version, t2sWeightsPath, vitsWeightsPath }
}

/** 仅解 `\uXXXX`（GPT-SoVITS 写入 yaml 时的中文路径形态），不实现通用 YAML。 */
function decodeYamlEscapes(value: string): string {
  return value.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16))
  )
}

function resolveConfigPath(rootDir: string, value: string): string {
  return normalize(isAbsolute(value) ? value : resolve(rootDir, value))
}

function voiceNameFromWeights(path: string): string {
  return basename(path, extname(path))
    .replace(/[-_]e\d+(?:[-_]s\d+)?(?:[-_]l\d+)?$/i, '')
    .replace(/[-_]e\d+$/i, '')
    .trim()
}

function baseCharacterName(displayName: string): string {
  return displayName.replace(/\d+(?:\.\d+)?$/u, '').trim()
}

function promptTextFromAudio(path: string): string {
  return basename(path, extname(path))
    .replace(/^【[^】]+】/u, '')
    .trim()
}

/**
 * 在安装包父级附近有界搜索 reference_audios/*.wav；优先同角色名与「默认」参考音频。
 * 最多 8 层 / 20k entries，防误选一个超大盘根目录后无界扫描。
 */
function findReferenceAudio(searchRoot: string, displayName: string): string | null {
  const wantedName = baseCharacterName(displayName).toLowerCase()
  const candidates: Array<{ path: string; score: number }> = []
  const queue: Array<{ path: string; depth: number }> = [{ path: searchRoot, depth: 0 }]
  let visited = 0
  while (queue.length > 0 && visited < 20_000) {
    const current = queue.shift()!
    if (current.depth > 8) continue
    let entries: Dirent<string>[]
    try {
      entries = readdirSync(current.path, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      continue
    }
    for (const entry of entries) {
      visited += 1
      if (visited >= 20_000) break
      const full = join(current.path, entry.name)
      if (entry.isDirectory()) {
        // runtime/site-packages 与训练中间产物不含参考音频，跳过可把扫描从数万降到数百。
        const lower = entry.name.toLowerCase()
        if (['runtime', 'site-packages', '__pycache__', '.git', 'node_modules'].includes(lower)) {
          continue
        }
        queue.push({ path: full, depth: current.depth + 1 })
        continue
      }
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== '.wav') continue
      const lowerPath = full.toLowerCase()
      let score = 0
      if (lowerPath.includes('reference_audios')) score += 100
      if (wantedName.length > 0 && lowerPath.includes(wantedName)) score += 60
      if (entry.name.includes('【默认】')) score += 30
      if (score > 0) candidates.push({ path: full, score })
    }
  }
  candidates.sort((a, b) => b.score - a.score || a.path.length - b.path.length)
  return candidates[0]?.path ?? null
}

function candidateInstallRoots(
  extraCandidates: readonly string[] = [],
  includeCommonLocations = true
): string[] {
  const roots = new Set<string>()
  const fromEnv = process.env['NACIME_GPT_SOVITS_ROOT']
  if (fromEnv) roots.add(resolve(fromEnv))
  for (const candidate of extraCandidates) roots.add(resolve(candidate))

  if (includeCommonLocations && process.platform === 'win32') {
    for (const drive of ['C:', 'D:', 'E:']) {
      const base = `${drive}\\GPT-SoVITS`
      if (!existsSync(base)) continue
      roots.add(base)
      try {
        for (const first of readdirSync(base, { withFileTypes: true })) {
          if (!first.isDirectory()) continue
          const firstPath = join(base, first.name)
          roots.add(firstPath)
          // 用户整合包常见「压缩包目录/同名应用目录」双层结构。
          try {
            for (const second of readdirSync(firstPath, { withFileTypes: true })) {
              if (second.isDirectory()) roots.add(join(firstPath, second.name))
            }
          } catch {
            /* 单个候选不可读，继续其他候选 */
          }
        }
      } catch {
        /* 盘符/目录读取竞态 */
      }
    }
  }
  return [...roots]
}

function validateCandidate(rootDir: string): GptSovitsInstallation | null {
  const pythonPath = join(
    rootDir,
    'runtime',
    process.platform === 'win32' ? 'python.exe' : 'python'
  )
  const apiScriptPath = join(rootDir, 'api_v2.py')
  const ttsConfigPath = join(rootDir, 'GPT_SoVITS', 'configs', 'tts_infer.yaml')
  if (![pythonPath, apiScriptPath, ttsConfigPath].every(existsSync)) return null

  let parsed: ParsedCustomConfig | null
  try {
    parsed = parseCustomConfig(readFileSync(ttsConfigPath, 'utf8'))
  } catch {
    return null
  }
  if (parsed === null) return null
  const gptWeightsPath = resolveConfigPath(rootDir, parsed.t2sWeightsPath)
  const sovitsWeightsPath = resolveConfigPath(rootDir, parsed.vitsWeightsPath)
  if (!existsSync(gptWeightsPath) || !existsSync(sovitsWeightsPath)) return null
  try {
    if (!statSync(gptWeightsPath).isFile() || !statSync(sovitsWeightsPath).isFile()) return null
  } catch {
    return null
  }

  const displayName = voiceNameFromWeights(gptWeightsPath) || 'GPT-SoVITS 自定义音色'
  // root 通常是 E:/GPT-SoVITS/<package>/<app>，向上两层回到用户的 voice workspace。
  const workspaceRoot = dirname(dirname(rootDir))
  const refAudioPath = findReferenceAudio(workspaceRoot, displayName)
  if (refAudioPath === null) return null // 无参考音频不能调用 /tts，不伪装 ready

  return {
    rootDir,
    pythonPath,
    apiScriptPath,
    ttsConfigPath,
    version: parsed.version,
    gptWeightsPath,
    sovitsWeightsPath,
    voice: {
      id: gptVoiceProfileId(gptWeightsPath, sovitsWeightsPath, refAudioPath),
      displayName: `${displayName}（${parsed.version}）`,
      refAudioPath,
      promptText: promptTextFromAudio(refAudioPath),
      promptLang: 'zh',
      defaultTextLang: 'zh'
    }
  }
}

/**
 * 找到第一份完整可运行安装。环境变量优先，其次显式候选，最后 Windows C/D/E 常见目录。
 * 只读；任何缺件都返回 null，让 Registry 不注册 provider（产品退纯文字）。
 */
export function discoverGptSovitsInstallation(
  extraCandidates: readonly string[] = [],
  includeCommonLocations = true
): GptSovitsInstallation | null {
  for (const candidate of candidateInstallRoots(extraCandidates, includeCommonLocations)) {
    const installation = validateCandidate(candidate)
    if (installation !== null) return installation
  }
  return null
}
