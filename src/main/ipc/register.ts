// src/main/ipc/register.ts
// IPC 统一注册：registerValidatedHandler + IpcContext + toIpcFailure + sendEvent
// 依据：S-003 §3.6/§3.7、S-001 P1-11、P3A-05 sender capability guard
//
// 设计要点：
//   1. registerValidatedHandler 包装 ipcMain.handle，自动做 sender 信任校验 + capability + payload 校验
//   2. 非法载荷返回 IPC_VALIDATION，非受信/越权 sender 返回 IPC_UNAUTHORIZED
//   3. handler 逻辑拆为纯函数 (ctx,payload)=>result（S-004 §3.2）
//   4. toIpcFailure 把 AppError/未知错误转为安全 IpcError（不含 stack/cause）
//   5. HMR 安全：注册前先 removeHandler

import { ipcMain, type WebContents, type IpcMainInvokeEvent } from 'electron'
import { randomUUID } from 'node:crypto'
import type { Logger } from '@shared/observability/types'
import { isAppError, type IpcError } from '@shared/errors'
import type {
  IpcResult,
  IpcInvokeMap,
  IpcInvokeChannel,
  IpcEventMap,
  IpcEventChannel
} from '@shared/ipc/contracts'
import { validateIpcPayload, isTrustedSender, type IpcGuardConfig } from './validators'
import { IPC_INVOKE_CHANNELS } from '@shared/ipc/channels'

/** P3A-05：一个 webContents 只能持有一种最小能力，不以「已受信」代替授权。 */
export type IpcSenderCapability = 'chat' | 'live2d-stage'

const STAGE_INVOKE_CHANNELS: ReadonlySet<IpcInvokeChannel> = new Set([
  'companion:stage:ready',
  'companion:stage:report-state'
])

const STAGE_EVENT_CHANNELS: ReadonlySet<IpcEventChannel> = new Set([
  'companion:event:stage-command'
])

/** noop logger，未注入真实 Logger 时的占位 */
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

/** handler 执行上下文。依据 S-003 §3.6 IpcContext */
export interface IpcContext {
  requestId: string
  sender: WebContents
}

/** handler 签名 */
export type IpcHandler<K extends IpcInvokeChannel> = (
  ctx: IpcContext,
  payload: IpcInvokeMap[K]['req']
) => Promise<IpcInvokeMap[K]['res']> | IpcInvokeMap[K]['res']

/** P3A-05：entry 生命周期与 IpcGuardConfig 独立，避免旧 set 覆盖/残留 sender capability。 */
export interface IpcCapabilityEntry {
  readonly webContentsId: number
  readonly capability: IpcSenderCapability
}

/** 扩展后的 guard 配置；兼容原有 trustedWebContentsIds 调用端。 */
export interface CapabilityIpcGuardConfig extends IpcGuardConfig {
  readonly senderCapabilities?: ReadonlyMap<number, IpcSenderCapability>
}

// === 模块级配置 ===

let guardConfig: IpcGuardConfig = {
  trustedOrigins: new Set<string>(),
  trustedWebContentsIds: new Set<number>()
}
let senderCapabilities = new Map<number, IpcSenderCapability>()
let ipcLogger: Logger = noopLogger

/**
 * 配置 IPC guard。main 入口在每次 chat/stage 窗口创建或销毁后调用。
 * 未显式指定 capability 的 legacy trusted sender 默认为 chat；stage 必须显式登记。
 */
export function configureIpcGuard(config: CapabilityIpcGuardConfig, logger?: Logger): void {
  guardConfig = {
    trustedOrigins: new Set(config.trustedOrigins),
    trustedWebContentsIds: new Set(config.trustedWebContentsIds)
  }
  senderCapabilities = new Map(config.senderCapabilities)
  for (const id of guardConfig.trustedWebContentsIds) {
    if (!senderCapabilities.has(id)) senderCapabilities.set(id, 'chat')
  }
  ipcLogger = logger ?? noopLogger
}

/** 读取当前 capability 快照，供 main 维护窗口集合时合并而不触碰内部可变 Map。 */
export function getIpcSenderCapabilities(): ReadonlyMap<number, IpcSenderCapability> {
  return new Map(senderCapabilities)
}

/** 窗口销毁时必须调用。后续复用到相同 id 的 renderer 绝不能继承旧权限。 */
export function removeIpcSenderCapability(webContentsId: number): void {
  senderCapabilities.delete(webContentsId)
  const trustedIds = new Set(guardConfig.trustedWebContentsIds)
  trustedIds.delete(webContentsId)
  guardConfig = {
    trustedOrigins: new Set(guardConfig.trustedOrigins),
    trustedWebContentsIds: trustedIds
  }
}

function hasChannelCapability(
  senderId: number,
  channel: IpcInvokeChannel | IpcEventChannel,
  direction: 'invoke' | 'event'
): boolean {
  const capability = senderCapabilities.get(senderId)
  if (capability === undefined) return false
  const stageOnly =
    direction === 'invoke'
      ? STAGE_INVOKE_CHANNELS.has(channel as IpcInvokeChannel)
      : STAGE_EVENT_CHANNELS.has(channel as IpcEventChannel)
  return stageOnly ? capability === 'live2d-stage' : capability === 'chat'
}

/** 生成 request ID */
function createRequestId(): string {
  return randomUUID()
}

/** 构造失败结果 */
function fail(code: IpcError['code'], requestId: string, message?: string): IpcResult<never> {
  const messages: Record<string, string> = {
    IPC_UNAUTHORIZED: '请求来源不受信任',
    IPC_VALIDATION: '请求数据格式无效',
    IPC_INTERNAL: '内部错误'
  }
  return {
    ok: false,
    error: {
      code,
      message: message ?? messages[code] ?? '错误',
      retryable: false,
      requestId
    }
  }
}

/**
 * 将 handler 抛出的错误转为安全 IpcError。
 * 依据 S-003 §3.6：log cause，但只把安全文案返回 renderer。
 * AppError 用其 code/userMessage；未知错误统一 IPC_INTERNAL。
 */
function toIpcFailure(cause: unknown, requestId: string): IpcResult<never> {
  if (isAppError(cause)) {
    ipcLogger.error('IPC handler threw AppError', {
      scope: 'ipc',
      code: cause.code,
      detail: cause.message
    })
    return {
      ok: false,
      error: {
        code: cause.code,
        message: cause.userMessage ?? cause.code,
        retryable: cause.retryable,
        requestId
      }
    }
  }

  ipcLogger.error('IPC handler threw unknown error', {
    scope: 'ipc',
    code: 'UNKNOWN',
    detail: cause instanceof Error ? cause.message : String(cause)
  })
  return fail('IPC_INTERNAL', requestId)
}

/**
 * 注册带校验的 IPC handler。
 * 流程：sender trust → capability allowlist → payload validator → handler。
 */
export function registerValidatedHandler<K extends IpcInvokeChannel>(
  channel: K,
  handler: IpcHandler<K>
): void {
  ipcMain.removeHandler(channel)

  ipcMain.handle(
    channel,
    async (event: IpcMainInvokeEvent, raw: unknown): Promise<IpcResult<IpcInvokeMap[K]['res']>> => {
      const requestId = createRequestId()
      const senderUrl = event.senderFrame?.url ?? ''
      const senderId = event.sender.id
      if (
        !isTrustedSender({ url: senderUrl, webContentsId: senderId }, guardConfig) ||
        !hasChannelCapability(senderId, channel, 'invoke')
      ) {
        ipcLogger.warn('IPC unauthorized sender rejected', {
          scope: 'ipc',
          tags: { channel, senderId: String(senderId), reason: 'IPC_UNAUTHORIZED' }
        })
        return fail('IPC_UNAUTHORIZED', requestId)
      }

      if (!validateIpcPayload(channel, raw)) {
        ipcLogger.warn('IPC payload validation failed', {
          scope: 'ipc',
          code: 'IPC_VALIDATION',
          tags: { channel }
        })
        return fail('IPC_VALIDATION', requestId)
      }

      try {
        const data = await handler({ requestId, sender: event.sender }, raw)
        return { ok: true, data }
      } catch (cause) {
        return toIpcFailure(cause, requestId)
      }
    }
  )
}

/**
 * main → renderer 事件发送。
 * stage-only event 只能发给 stage capability，其他所有 event 只能发给 chat capability。
 */
export function sendEvent<K extends IpcEventChannel>(
  webContents: WebContents,
  channel: K,
  payload: IpcEventMap[K]
): void {
  if (webContents.isDestroyed()) {
    ipcLogger.debug('skip IPC event for destroyed webContents', {
      scope: 'ipc',
      tags: { channel, senderId: String(webContents.id) }
    })
    return
  }
  // 既有 chat event 由 main 明确持有目标 webContents，不可由 renderer 自选目标；保留原
  // sendEvent 语义，避免给 updater/memory 等已有通道引入启动时序耦合。唯 stage command
  // 可驱动图形/资源生命周期，必须再经 capability 验证，chat 绝不能收到它。
  if (
    STAGE_EVENT_CHANNELS.has(channel) &&
    !hasChannelCapability(webContents.id, channel, 'event')
  ) {
    ipcLogger.debug('skip stage event for unauthorized webContents', {
      scope: 'ipc',
      tags: { channel, senderId: String(webContents.id) }
    })
    return
  }
  try {
    webContents.send(channel, payload)
  } catch (error) {
    // isDestroyed() 与 send() 之间存在竞态：窗口可能在检查后立刻关闭。
    // 事件发送属于尽力而为，不能让退出/重建路径升级为 main 崩溃。
    ipcLogger.debug('IPC event send failed', {
      scope: 'ipc',
      tags: { channel, senderId: String(webContents.id) },
      detail: error instanceof Error ? error.message : String(error)
    })
  }
}

/** 注销所有已注册的 invoke handler。测试/清理时调用。 */
export function removeAllHandlers(): void {
  for (const channel of IPC_INVOKE_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
}
