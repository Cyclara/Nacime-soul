// src/main/ipc/handlers/config-handler.test.ts
// config:update handler 回归测试
// 依据：S-001 P1-15、S-005 §3.2
//
// 背景（2026-07-24 真实 bug）：
//   handler 曾把整条 ConfigUpdateRequest 强转传给 configStore.update：
//     `payload as unknown as Parameters<typeof configStore.update>[0]`
//   payload 顶层 key 是 expectedSchemaVersion/domains，
//   而 update 期望 DeepPartial<AppConfigV1>（顶层 key 是 model/tts/...）。
//   deepMergeWithDefaults 找不到任何匹配 key → 静默丢弃全部更新。
//   该 bug 让"保存"假成功（返回 ok 但 config 从未写入），
//   直到思考模式开关需要写非默认值 reasoningEffort:'high' 才暴露。
// 本测试的核心断言：update 后 configStore.get() 的值**真的变了**。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import type { Logger } from '@shared/observability/types'
import type { ConfigUpdateRequest } from '@shared/config/types'
import type { SecretStore } from '../../security/secret-store'
import { createConfigStore } from '../../config/store'
import { registerConfigHandlers } from './config'
import { configureIpcGuard } from '../register'
import { ipcMain } from 'electron'

// mock electron.ipcMain：捕获注册的 handler，直接调用
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn()
  }
}))

function noopLogger(): Logger {
  const log: Logger = {
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
      return log
    }
  }
  return log
}

/** 内存版 SecretStore（handler 只需要 has/get/set） */
function createMemorySecretStore(): SecretStore {
  const map = new Map<string, string>()
  return {
    setup() {
      /* noop */
    },
    get: (name) => map.get(name) ?? null,
    set: (name, value) => {
      map.set(name, value)
    },
    delete: (name) => {
      map.delete(name)
    },
    has: (name) => map.has(name)
  }
}

interface RegisteredHandler {
  (event: unknown, raw: unknown): Promise<unknown>
}

/** 从 ipcMain.handle mock 中取出指定 channel 的 handler */
function getHandler(channel: string): RegisteredHandler {
  const calls = vi.mocked(ipcMain.handle).mock.calls
  const found = calls.find(([ch]) => ch === channel)
  if (!found) throw new Error(`handler not registered: ${channel}`)
  return found[1] as RegisteredHandler
}

/** 构造受信任的 invoke event（webContentsId=1 + localhost origin） */
function trustedEvent(): Partial<IpcMainInvokeEvent> {
  return {
    sender: { id: 1 } as IpcMainInvokeEvent['sender'],
    senderFrame: { url: 'http://localhost:5173/' } as IpcMainInvokeEvent['senderFrame']
  }
}

describe('config:update handler（回归：payload 结构必须传 domains）', () => {
  let tmpDir: string
  let configPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nacime-cfg-test-'))
    configPath = path.join(tmpDir, 'config.json')
    vi.mocked(ipcMain.handle).mockClear()
    vi.mocked(ipcMain.removeHandler).mockClear()
    // 信任 webContents.id=1 + dev origin
    configureIpcGuard(
      { trustedOrigins: new Set(['http://localhost:5173']), trustedWebContentsIds: new Set([1]) },
      noopLogger()
    )
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('update 后 configStore.get() 的值必须真的改变（reasoningEffort off -> high）', async () => {
    const configStore = createConfigStore({ configPath, logger: noopLogger() })
    configStore.setup()
    const secretStore = createMemorySecretStore()

    registerConfigHandlers({ configStore, secretStore, logger: noopLogger() })

    const handler = getHandler('companion:config:update')
    const request: ConfigUpdateRequest = {
      expectedSchemaVersion: 1,
      domains: {
        model: { reasoningEffort: 'high' }
      }
    }

    const result = (await handler(trustedEvent(), request)) as {
      ok: boolean
      data?: { model: { reasoningEffort: string } }
    }

    expect(result.ok).toBe(true)
    // 核心回归断言 1：内存配置真的变了
    expect(configStore.get().model.reasoningEffort).toBe('high')
    // 核心回归断言 2：返回的 snapshot 也反映新值
    expect(result.data?.model.reasoningEffort).toBe('high')
    // 核心回归断言 3：磁盘文件也写入了
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
      model: { reasoningEffort: string }
    }
    expect(onDisk.model.reasoningEffort).toBe('high')
  })

  it('apiKey 被提取到 SecretStore，不进入 config.json', async () => {
    const configStore = createConfigStore({ configPath, logger: noopLogger() })
    configStore.setup()
    const secretStore = createMemorySecretStore()

    registerConfigHandlers({ configStore, secretStore, logger: noopLogger() })

    const handler = getHandler('companion:config:update')
    const request: ConfigUpdateRequest = {
      expectedSchemaVersion: 1,
      domains: {
        model: { apiKey: 'sk-test-key-1234567890abcdef' }
      }
    }

    const result = (await handler(trustedEvent(), request)) as { ok: boolean }

    expect(result.ok).toBe(true)
    // API Key 进 SecretStore
    expect(secretStore.get('modelApiKey')).toBe('sk-test-key-1234567890abcdef')
    // config.json 不含明文 key
    const onDisk = fs.readFileSync(configPath, 'utf8')
    expect(onDisk).not.toContain('sk-test-key-1234567890abcdef')
    expect(onDisk).not.toContain('apiKey')
  })

  it('expectedSchemaVersion 不匹配时拒绝（乐观锁）', async () => {
    const configStore = createConfigStore({ configPath, logger: noopLogger() })
    configStore.setup()
    const secretStore = createMemorySecretStore()

    registerConfigHandlers({ configStore, secretStore, logger: noopLogger() })

    const handler = getHandler('companion:config:update')
    const request: ConfigUpdateRequest = {
      expectedSchemaVersion: 999,
      domains: {
        model: { reasoningEffort: 'high' }
      }
    }

    const result = (await handler(trustedEvent(), request)) as {
      ok: boolean
      error?: { code: string }
    }

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('CFG_INVALID')
    // 配置未被修改
    expect(configStore.get().model.reasoningEffort).toBe('off')
  })

  it('未提供 apiKey 字段时不覆盖 SecretStore 中已有的 key', async () => {
    const configStore = createConfigStore({ configPath, logger: noopLogger() })
    configStore.setup()
    const secretStore = createMemorySecretStore()
    secretStore.set('modelApiKey', 'sk-existing-key')

    registerConfigHandlers({ configStore, secretStore, logger: noopLogger() })

    const handler = getHandler('companion:config:update')
    const request: ConfigUpdateRequest = {
      expectedSchemaVersion: 1,
      domains: {
        // 不含 apiKey（思考模式开关走的就是这条路径）
        model: { reasoningEffort: 'low' }
      }
    }

    const result = (await handler(trustedEvent(), request)) as { ok: boolean }

    expect(result.ok).toBe(true)
    // 已有 key 未被覆盖
    expect(secretStore.get('modelApiKey')).toBe('sk-existing-key')
    // 但其他字段正常更新
    expect(configStore.get().model.reasoningEffort).toBe('low')
  })
})
