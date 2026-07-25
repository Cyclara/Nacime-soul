// src/main/config/store.ts
// ConfigStore 实现：原子写、schema-aware merge、250ms 防抖、.bak 备份、诊断状态、mutex 串行化
// 依据：S-005 §3.7-§3.8、F5-013 atomicWriteJson、S-001 P1-07

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as v from 'valibot'
import type { Logger } from '@shared/observability/types'
import type {
  AppConfigV1,
  ConfigChangedEvent,
  ConfigDiagnostics,
  ConfigDomain,
  ConfigStore,
  DeepPartial
} from '@shared/config/types'
import { AppError } from '@shared/errors'
import { AppConfigSchema } from './schema'
import { DEFAULT_CONFIG_V1, deepFreeze } from './defaults'

const THROTTLE_MS = 250

/** noop logger，P1-12 真实 Logger 注入前的占位。所有方法空实现 */
const noopLogger: Logger = {
  fatal() {
    /* noop */
  },
  error() {
    /* noop */
  },
  warn() {
    /* noop */
  },
  info() {
    /* noop */
  },
  debug() {
    /* noop */
  },
  child() {
    return noopLogger
  }
}

/**
 * schema-aware deep merge：对象递归；数组整体替换；
 * undefined/null 用默认；未知 key 剔除（只保留 defaults 的 key）。
 * 依据 S-005 §3.7。
 */
function deepMergeWithDefaults<T>(defaults: T, user: unknown): T {
  if (user === undefined || user === null) {
    return defaults
  }
  if (typeof defaults !== 'object' || defaults === null) {
    return user as T
  }
  if (Array.isArray(defaults)) {
    return (Array.isArray(user) ? user : defaults) as T
  }
  if (typeof user !== 'object' || Array.isArray(user)) {
    return defaults
  }
  const result: Record<string, unknown> = {}
  const defaultObj = defaults as Record<string, unknown>
  const userObj = user as Record<string, unknown>
  for (const key of Object.keys(defaultObj)) {
    result[key] =
      key in userObj ? deepMergeWithDefaults(defaultObj[key], userObj[key]) : defaultObj[key]
  }
  return result as T
}

/**
 * 合并两个 patch（b 覆盖 a，对象递归）。用于防抖队列累积 patch。
 */
function mergePatches<T>(a: DeepPartial<T>, b: DeepPartial<T>): DeepPartial<T> {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return b
  if (typeof b !== 'object' || b === null || Array.isArray(b)) return b
  const result: Record<string, unknown> = { ...a }
  for (const key of Object.keys(b as Record<string, unknown>)) {
    const av = (a as Record<string, unknown>)[key]
    const bv = (b as Record<string, unknown>)[key]
    if (
      av !== undefined &&
      bv !== undefined &&
      typeof av === 'object' &&
      av !== null &&
      !Array.isArray(av) &&
      typeof bv === 'object' &&
      bv !== null &&
      !Array.isArray(bv)
    ) {
      result[key] = mergePatches(av as DeepPartial<unknown>, bv as DeepPartial<unknown>)
    } else {
      result[key] = bv
    }
  }
  return result as DeepPartial<T>
}

/**
 * 原子写 JSON：写 {file}.tmp -> fsync -> rename -> best-effort fsync dir。
 * 依据 F5-013 §3 atomicWriteJson。写入中断不损坏旧文件（rename 是原子的）。
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = filePath + '.tmp'
  const json = JSON.stringify(data, null, 2) + '\n'
  const fd = fs.openSync(tmpPath, 'w', 0o600)
  try {
    fs.writeFileSync(fd, json, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  // rename 原子替换（同分区 rename 在 POSIX 和 Windows 上都是原子的）
  fs.renameSync(tmpPath, filePath)
  // best-effort fsync 目录（某些 Windows 文件系统不支持，忽略失败）
  try {
    const dirFd = fs.openSync(path.dirname(filePath), 'r')
    try {
      fs.fsyncSync(dirFd)
    } finally {
      fs.closeSync(dirFd)
    }
  } catch {
    // best-effort：目录 fsync 失败不影响数据完整性（rename 已原子完成）
  }
}

/** 从 valibot issues 提取可读的 { path, message } 列表 */
function issuesToDiagnostics(
  issues: v.BaseIssue<unknown>[]
): Array<{ path: string; message: string }> {
  return issues.map((issue) => ({
    path: issue.path?.map((p) => String(p.input)).join('.') ?? '<root>',
    message:
      issue.message ?? `${issue.expected ?? 'invalid'} (received ${issue.received ?? 'unknown'})`
  }))
}

/** 检测 oldConfig 与 newConfig 之间第一个变化的域 */
function detectChangedDomain(old: AppConfigV1, next: AppConfigV1): ConfigDomain {
  const domains: ConfigDomain[] = ['model', 'tts', 'memory', 'ui', 'security']
  for (const d of domains) {
    if (JSON.stringify(old[d]) !== JSON.stringify(next[d])) {
      return d
    }
  }
  return 'model'
}

interface Resolver {
  resolve: (config: Readonly<AppConfigV1>) => void
  reject: (error: unknown) => void
}

class ConfigStoreImpl implements ConfigStore {
  private current: Readonly<AppConfigV1> = DEFAULT_CONFIG_V1
  private readonly listeners = new Set<(event: ConfigChangedEvent) => void>()
  private readonly logger: Logger
  private readonly configPath: string
  private readonly bakPath: string

  /** mutex：写入串行化。依据 S-005 §3.8 */
  private writeQueue: Promise<unknown> = Promise.resolve()

  /** 防抖状态 */
  private throttleTimer: ReturnType<typeof setTimeout> | null = null
  private pendingPatch: DeepPartial<AppConfigV1> | null = null
  private throttleResolvers: Resolver[] = []

  constructor(opts: { configPath: string; logger?: Logger }) {
    this.configPath = opts.configPath
    this.bakPath = opts.configPath + '.bak'
    this.logger = opts.logger ?? noopLogger
  }

  setup(): ConfigDiagnostics {
    // 1. 文件不存在 -> missing，写默认配置
    if (!fs.existsSync(this.configPath)) {
      this.current = DEFAULT_CONFIG_V1
      try {
        atomicWriteJson(this.configPath, DEFAULT_CONFIG_V1)
      } catch (e) {
        this.logger.error('config setup: write default failed', {
          scope: 'config',
          code: 'CFG_INVALID',
          detail: e instanceof Error ? e.message : String(e)
        })
      }
      return { status: 'missing', path: this.configPath, healed: true }
    }

    // 2. 读取文件
    let raw: string
    try {
      raw = fs.readFileSync(this.configPath, 'utf8')
    } catch (e) {
      this.backupCurrent()
      this.current = DEFAULT_CONFIG_V1
      atomicWriteJson(this.configPath, DEFAULT_CONFIG_V1)
      return {
        status: 'read-error',
        path: this.configPath,
        healed: true,
        issues: [
          {
            path: '',
            message: `read failed: ${e instanceof Error ? e.message : String(e)}`
          }
        ]
      }
    }

    // 3. JSON parse
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      this.backupCurrent()
      this.current = DEFAULT_CONFIG_V1
      atomicWriteJson(this.configPath, DEFAULT_CONFIG_V1)
      return {
        status: 'invalid',
        path: this.configPath,
        healed: true,
        issues: [
          {
            path: '',
            message: `JSON parse failed: ${e instanceof Error ? e.message : String(e)}`
          }
        ]
      }
    }

    // 4. schema-aware merge + safeParse
    const merged = deepMergeWithDefaults(DEFAULT_CONFIG_V1, parsed)
    const result = v.safeParse(AppConfigSchema, merged)
    if (!result.success) {
      this.backupCurrent()
      this.current = DEFAULT_CONFIG_V1
      atomicWriteJson(this.configPath, DEFAULT_CONFIG_V1)
      return {
        status: 'invalid',
        path: this.configPath,
        healed: true,
        issues: issuesToDiagnostics(result.issues)
      }
    }

    // 5. ok
    this.current = deepFreeze(result.output as AppConfigV1)
    return { status: 'ok', path: this.configPath, healed: false }
  }

  get(): Readonly<AppConfigV1> {
    return this.current
  }

  update(
    patch: DeepPartial<AppConfigV1>,
    opts?: { immediate?: boolean }
  ): Promise<Readonly<AppConfigV1>> {
    const immediate = opts?.immediate ?? true

    if (immediate) {
      // 合并 pending 防抖 patch，取消 timer
      const effective = this.pendingPatch ? mergePatches(this.pendingPatch, patch) : patch
      const pendingResolvers = this.throttleResolvers
      this.throttleResolvers = []
      this.pendingPatch = null
      if (this.throttleTimer) {
        clearTimeout(this.throttleTimer)
        this.throttleTimer = null
      }
      return this.enqueueUpdate(effective).then(
        (config) => {
          for (const r of pendingResolvers) r.resolve(config)
          return config
        },
        (error) => {
          for (const r of pendingResolvers) r.reject(error)
          throw error
        }
      )
    }

    // 防抖路径：累积 patch，250ms 后执行
    this.pendingPatch = this.pendingPatch ? mergePatches(this.pendingPatch, patch) : patch
    return new Promise<Readonly<AppConfigV1>>((resolve, reject) => {
      this.throttleResolvers.push({ resolve, reject })
      if (this.throttleTimer) {
        clearTimeout(this.throttleTimer)
      }
      this.throttleTimer = setTimeout(() => {
        const pending = this.pendingPatch
        this.pendingPatch = null
        this.throttleTimer = null
        const resolvers = this.throttleResolvers
        this.throttleResolvers = []
        if (pending) {
          this.enqueueUpdate(pending).then(
            (config) => {
              for (const r of resolvers) r.resolve(config)
            },
            (error) => {
              for (const r of resolvers) r.reject(error)
            }
          )
        } else {
          for (const r of resolvers) r.resolve(this.current)
        }
      }, THROTTLE_MS)
    })
  }

  resetDomain(domain: ConfigDomain): Promise<Readonly<AppConfigV1>> {
    const patch = {
      [domain]: structuredClone(DEFAULT_CONFIG_V1[domain])
    } as DeepPartial<AppConfigV1>
    return this.enqueueUpdate(patch)
  }

  subscribe(listener: (event: ConfigChangedEvent) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // === 私有方法 ===

  /** 将写入任务加入 mutex 队列，保证串行化 */
  private enqueueUpdate(patch: DeepPartial<AppConfigV1>): Promise<Readonly<AppConfigV1>> {
    const task = (): Promise<Readonly<AppConfigV1>> => this.applyUpdate(patch)
    const result = this.writeQueue.then(task)
    this.writeQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  /** 实际执行 merge -> validate -> 原子写 -> emit */
  private async applyUpdate(patch: DeepPartial<AppConfigV1>): Promise<Readonly<AppConfigV1>> {
    const merged = deepMergeWithDefaults(this.current, patch)
    const result = v.safeParse(AppConfigSchema, merged)
    if (!result.success) {
      const issues = issuesToDiagnostics(result.issues)
      this.logger.warn('config update rejected: validation failed', {
        scope: 'config',
        code: 'CFG_INVALID',
        tags: { issueCount: String(issues.length) }
      })
      throw new AppError({
        code: 'CFG_INVALID',
        userMessage: '配置校验失败，请检查输入',
        severity: 'error',
        retryable: false,
        cause: issues
      })
    }

    const newConfig = deepFreeze(result.output as AppConfigV1)
    // 备份当前文件 + 原子写
    this.backupCurrent()
    atomicWriteJson(this.configPath, newConfig)

    const oldConfig = this.current
    this.current = newConfig

    this.emit({ domain: detectChangedDomain(oldConfig, newConfig), config: newConfig })
    return newConfig
  }

  /** 备份当前 config.json 到 .bak */
  private backupCurrent(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        fs.copyFileSync(this.configPath, this.bakPath)
      }
    } catch (e) {
      this.logger.warn('config backup failed', {
        scope: 'config',
        detail: e instanceof Error ? e.message : String(e)
      })
    }
  }

  private emit(event: ConfigChangedEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (e) {
        this.logger.error('config listener threw', {
          scope: 'config',
          detail: e instanceof Error ? e.message : String(e)
        })
      }
    }
  }
}

/**
 * 创建 ConfigStore。
 * configPath 应为 config.json 的绝对路径（main 中用 app.getPath('userData') 拼接）。
 * logger 可选，P1-12 实现后注入真实 Logger。
 */
export function createConfigStore(opts: { configPath: string; logger?: Logger }): ConfigStore {
  return new ConfigStoreImpl(opts)
}

export { deepMergeWithDefaults, mergePatches }
