// src/main/voice/asset-root-service.ts
// P3V-10：大资源根目录服务（默认路径 / 自选 / 可用空间 / 迁移与丢失报错）。
//
// 资产布局（根目录下的固定子目录，迁移按子目录整体搬）：
//   {root}/asr          —— ASR 模型（引擎 + VAD；接 engine-manager/downloader 的 rootDir）
//   {root}/gpt-runtime  —— GPT-SoVITS 整合包（P3V-16）
//   {root}/voices       —— 音色包（P3V-20）
//
// 生命周期（S-023 §3.3 的用户裁定落地）：
//   - 持久化在 **main 私有 asset-root.json**（{root 偏好, activeRoot}），不进 renderer
//     可读的 config——路径纪律要求 renderer 永远拿不到绝对路径。
//   - setup() 在 main 启动早期执行：读偏好 → 一次性迁移（旧版 data/models/asr →
//     新根；偏好根 ≠ 上次活跃根 → 搬子目录）→ activeRoot 落盘。**本会话内 root 固定**
//     ——运行中的引擎/下载器不热重建（数百 MB recognizer 与下载断点搬家得不偿失）。
//   - setRoot()/resetRoot() 只改偏好：返回 restartRequired=true，UI 提示「重启后生效」。
//   - 自定义根不存在（盘被拔）：status() 报 state='missing'，**不自动创建、不静默回
//     默认盘**；已下载资源原地不动，盘回来即恢复。默认根例外：app-owned，自动建。
//
// 单元测试全部注入临时目录，不碰真实 userData/盘符。

import { existsSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { mkdir, readdir, rename as fsRename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { atomicWriteJson } from '../migrations/atomic-json'
import type { AssetRootChangeResult, AssetRootStatus } from '@shared/voice/asset-root-types'

/** 迁移时整体搬的子目录（新增资产种类必须登记在这里，否则换根后会留在旧盘）。 */
const ASSET_SUBDIRS = ['asr', 'gpt-runtime', 'voices'] as const

/** 偏好文件形状（磁盘 JSON；schemaVersion 语义同 config——预留未来字段演进）。 */
interface AssetRootPref {
  readonly schemaVersion: 1
  /** 用户当前选择（setRoot/resetRoot 写这里）。 */
  readonly root: string
  /** 本（上一次）会话实际使用的根——setup 迁移完成后更新。 */
  readonly activeRoot: string
}

export interface AssetRootServiceDeps {
  /** 偏好持久化文件路径（生产 {userData}/asset-root.json）。 */
  readonly prefPath: string
  /** 默认根目录（生产按平台：Windows %LOCALAPPDATA%\<app>\assets，其余 userData/assets）。 */
  readonly defaultRoot: string
  /** 旧版 ASR 模型目录（{userData}/data/models/asr）；存在则一次性迁入新根。 */
  readonly legacyAsrRoot?: string
  /**
   * 当前选择需要的总下载字节（生产由 main 调 shared catalog 单真源计算）。
   * P3V-16/20 只需扩组合根这一个回调，无需改目录服务。
   */
  readonly getTotalRequiredBytes?: () => number
  /** 注入假 rename（测试 EXDEV 分支用）；默认 node:fs/promises.rename。 */
  readonly renameImpl?: (from: string, to: string) => Promise<void>
}

export interface AssetRootService {
  /** 启动期初始化：读偏好 + 一次性迁移 + activeRoot 落盘。幂等。 */
  setup(): Promise<void>
  /** 本会话根目录（setup 前返回偏好里的 activeRoot，缺省即默认根）。 */
  root(): string
  /** ASR 模型根（engine-manager / downloader 的 rootDir）。 */
  asrRoot(): string
  /** GPT-SoVITS 整合包根（P3V-16 下载器的 assetRootDir；换根随 ASSET_SUBDIRS 迁移）。 */
  gptRuntimeRoot(): string
  status(): AssetRootStatus
  /** 当前偏好与本会话运行根是否不同（true = 仍需重启迁移）。 */
  restartRequired(): boolean
  /** 持久化用户选择（不迁移、不重建运行栈——重启生效）。 */
  setRoot(nextRoot: string): AssetRootChangeResult
  /** 回到默认位置（同 setRoot 语义）。 */
  resetRoot(): AssetRootChangeResult
}

function normalizePath(p: string): string {
  return p.replaceAll('\\', '/')
}

function isSamePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b)
}

/** 读偏好；缺失/损坏回默认（损坏文件被覆盖前不影响本会话用默认根启动）。 */
function readPref(deps: AssetRootServiceDeps): AssetRootPref {
  try {
    if (existsSync(deps.prefPath)) {
      const raw: unknown = JSON.parse(readFileSync(deps.prefPath, 'utf-8'))
      if (
        typeof raw === 'object' &&
        raw !== null &&
        typeof (raw as Record<string, unknown>)['root'] === 'string' &&
        typeof (raw as Record<string, unknown>)['activeRoot'] === 'string'
      ) {
        return raw as unknown as AssetRootPref
      }
    }
  } catch {
    /* 损坏 → 默认 */
  }
  return { schemaVersion: 1, root: deps.defaultRoot, activeRoot: deps.defaultRoot }
}

function writePref(deps: AssetRootServiceDeps, pref: AssetRootPref): void {
  atomicWriteJson(deps.prefPath, pref)
}

/** 写探针验证可写（probe 文件立即删除，不留垃圾）。 */
function probeWritableSync(dir: string): boolean {
  const probe = join(dir, '.nacime-write-probe')
  try {
    writeFileSync(probe, 'ok')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 整体搬一个目录：同盘 rename 优先；跨盘回退 cp 递归复制 + 删源。
 * 失败清掉半成品目标，源目录不动（下次启动重试）。
 */
async function moveDir(
  from: string,
  to: string,
  renameImpl: (from: string, to: string) => Promise<void>
): Promise<void> {
  if (!existsSync(from)) return
  await mkdir(dirname(to), { recursive: true })
  if (existsSync(to)) {
    // 目标已存在：不覆盖（防吞掉新根里已有数据），调用方按「子目录级合并」处理
    throw new Error(`asset target already exists: ${to}`)
  }
  try {
    await renameImpl(from, to)
    return
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code
    if (code !== 'EXDEV') throw err
  }
  // 跨盘：复制 + 校验条目数 + 删源
  const { cp } = await import('node:fs/promises')
  try {
    await cp(from, to, { recursive: true })
    const [fromEntries, toEntries] = await Promise.all([readdir(from), readdir(to)])
    if (fromEntries.length !== toEntries.length) {
      throw new Error('asset copy verification failed: entry count mismatch')
    }
    await rm(from, { recursive: true, force: true })
  } catch (err) {
    await rm(to, { recursive: true, force: true })
    throw err
  }
}

export function createAssetRootService(deps: AssetRootServiceDeps): AssetRootService {
  const renameImpl = deps.renameImpl ?? fsRename
  let pref: AssetRootPref = readPref(deps)
  let setupDone = false

  /**
   * 状态快照反映**用户当前选择**（pref.root）而非运行中的 activeRoot——
   * 用户刚改完位置，UI 就该显示新位置；「运行中会话还在旧根」由
   * restartRequired 表达。稳态（无待生效变更）两者相同。
   */
  function status(): AssetRootStatus {
    const root = pref.root
    const isDefault = isSamePath(root, deps.defaultRoot)
    const totalRequiredBytes = Math.max(0, Math.floor(deps.getTotalRequiredBytes?.() ?? 0))
    if (!existsSync(root)) {
      // 自定义根的盘被拔 / 目录被删：明确报 missing，不建目录、不回默认盘
      return { isDefault, freeBytes: 0, totalRequiredBytes, state: 'missing' }
    }
    if (!probeWritableSync(root)) {
      return { isDefault, freeBytes: 0, totalRequiredBytes, state: 'unwritable' }
    }
    let freeBytes = 0
    try {
      // bavail*bsize = 普通用户可用字节（与资源管理器「可用空间」同口径）
      const info = statfsSync(root)
      freeBytes = Number(info.bavail) * Number(info.bsize)
    } catch {
      freeBytes = 0
    }
    return { isDefault, freeBytes, totalRequiredBytes, state: 'ok' }
  }

  async function migrateRoot(from: string, to: string): Promise<void> {
    if (isSamePath(from, to)) return
    const fromExists = existsSync(from)
    if (!fromExists) return // 旧根没有资产（或盘已拔），无处可搬，直接切到新根
    if (!existsSync(to)) await mkdir(to, { recursive: true })
    if (!probeWritableSync(to)) {
      throw new Error(`asset root not writable: ${to}`)
    }
    for (const sub of ASSET_SUBDIRS) {
      await moveDir(join(from, sub), join(to, sub), renameImpl)
    }
  }

  return {
    async setup() {
      if (setupDone) return
      setupDone = true
      const target = pref.root
      const targetMissing = !existsSync(target) && !isSamePath(target, deps.defaultRoot)
      // 旧版 data/models/asr → 新根 asr/（一次性；新根 asr 已有内容则跳过，绝不覆盖）
      if (deps.legacyAsrRoot !== undefined && existsSync(deps.legacyAsrRoot)) {
        const targetAsr = join(target, 'asr')
        if (!existsSync(targetAsr) && !targetMissing) {
          await mkdir(target, { recursive: true })
          if (probeWritableSync(target)) {
            await moveDir(deps.legacyAsrRoot, targetAsr, renameImpl)
          }
        }
        // 目标根不存在（自定义盘被拔）：legacy 留在原地，下次启动再试
      }
      let nextActive = pref.activeRoot
      if (!isSamePath(pref.activeRoot, target)) {
        if (targetMissing) {
          // 用户想要的盘不在：资产留在 activeRoot 原地、activeRoot 不前移——
          // 盘回来后的下一次启动才会真正迁移（「已下载资源不删除，等盘回来即恢复」）
        } else {
          if (!existsSync(target)) await mkdir(target, { recursive: true })
          await migrateRoot(pref.activeRoot, target)
          nextActive = target
        }
      } else if (isSamePath(target, deps.defaultRoot) && !existsSync(target)) {
        // 默认根首次启动：app-owned，自动建
        await mkdir(target, { recursive: true })
        nextActive = target
      }
      pref = { schemaVersion: 1, root: target, activeRoot: nextActive }
      writePref(deps, pref)
    },

    root() {
      return pref.activeRoot
    },

    asrRoot() {
      return join(pref.activeRoot, 'asr')
    },

    gptRuntimeRoot() {
      return join(pref.activeRoot, 'gpt-runtime')
    },

    status,

    restartRequired() {
      return !isSamePath(pref.root, pref.activeRoot)
    },

    setRoot(nextRoot) {
      if (isSamePath(nextRoot, pref.root)) {
        return {
          status: status(),
          changed: false,
          restartRequired: !isSamePath(pref.root, pref.activeRoot)
        }
      }
      // 选择器只会给出已存在的目录，但保底再验一次：不存在/不可写按未变更拒绝
      if (!existsSync(nextRoot) || !probeWritableSync(nextRoot)) {
        return { status: status(), changed: false, restartRequired: false }
      }
      // 只改偏好；activeRoot 不动——运行中的引擎/下载器继续用旧根，重启后迁移生效
      pref = { schemaVersion: 1, root: nextRoot, activeRoot: pref.activeRoot }
      writePref(deps, pref)
      return {
        status: status(),
        changed: true,
        restartRequired: !isSamePath(nextRoot, pref.activeRoot)
      }
    },

    resetRoot() {
      if (isSamePath(pref.root, deps.defaultRoot)) {
        return { status: status(), changed: false, restartRequired: false }
      }
      pref = { schemaVersion: 1, root: deps.defaultRoot, activeRoot: pref.activeRoot }
      writePref(deps, pref)
      return {
        status: status(),
        changed: true,
        restartRequired: !isSamePath(deps.defaultRoot, pref.activeRoot)
      }
    }
  }
}
