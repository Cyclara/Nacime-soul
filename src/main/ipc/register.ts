// src/main/ipc/register.ts
// IPC 统一注册：registerValidatedHandler + IpcContext + toIpcFailure + sendEvent
// 依据：S-003 §3.6/§3.7、S-001 P1-11
//
// 设计要点：
//   1. registerValidatedHandler 包装 ipcMain.handle，自动做 sender 信任校验 + payload 校验
//   2. 非法载荷返回 IPC_VALIDATION，非受信 sender 返回 IPC_UNAUTHORIZED
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

// === 模块级配置 ===

let guardConfig: IpcGuardConfig = {
  trustedOrigins: new Set<string>(),
  trustedWebContentsIds: new Set<number>()
}
let ipcLogger: Logger = noopLogger

/**
 * 配置 IPC guard。在 main 入口、窗口创建后调用。
 * 传入受信任的 sender origin 和 webContents.id 集合。
 */
export function configureIpcGuard(config: IpcGuardConfig, logger?: Logger): void {
  guardConfig = {
    trustedOrigins: new Set(config.trustedOrigins),
    trustedWebContentsIds: new Set(config.trustedWebContentsIds)
  }
  ipcLogger = logger ?? noopLogger
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
      detail: cause.message // electron-log 写盘前会过 scrub
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

  // 未知错误 -> IPC_INTERNAL，不泄露 stack/cause
  ipcLogger.error('IPC handler threw unknown error', {
    scope: 'ipc',
    code: 'UNKNOWN',
    detail: cause instanceof Error ? cause.message : String(cause)
  })
  return fail('IPC_INTERNAL', requestId)
}

/**
 * 注册带校验的 IPC handler。
 *
 * 流程（依据 S-003 §3.6）：
 *   1. 创建 requestId
 *   2. isTrustedSender 校验 -> 不通过返回 IPC_UNAUTHORIZED
 *   3. validateIpcPayload 校验 -> 不通过返回 IPC_VALIDATION
 *   4. try handler -> catch toIpcFailure
 *   5. 返回 IpcResult<T>
 *
 * HMR 安全：注册前先 removeHandler（S-003 §4 边界条件）。
 */
export function registerValidatedHandler<K extends IpcInvokeChannel>(
  channel: K,
  handler: IpcHandler<K>
): void {
  // HMR 安全：先移除旧 handler
  ipcMain.removeHandler(channel)

  ipcMain.handle(
    channel,
    async (event: IpcMainInvokeEvent, raw: unknown): Promise<IpcResult<IpcInvokeMap[K]['res']>> => {
      const requestId = createRequestId()

      // 1. sender 信任校验
      const senderUrl = event.senderFrame?.url ?? ''
      const senderId = event.sender.id
      if (!isTrustedSender({ url: senderUrl, webContentsId: senderId }, guardConfig)) {
        ipcLogger.warn('IPC unauthorized sender rejected', {
          scope: 'ipc',
          tags: { channel, senderId: String(senderId), reason: 'IPC_UNAUTHORIZED' }
        })
        return fail('IPC_UNAUTHORIZED', requestId)
      }

      // 2. payload 校验
      if (!validateIpcPayload(channel, raw)) {
        ipcLogger.warn('IPC payload validation failed', {
          scope: 'ipc',
          code: 'IPC_VALIDATION',
          tags: { channel }
        })
        return fail('IPC_VALIDATION', requestId)
      }

      // 3. 执行 handler
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
 * 向 renderer 发送事件。
 * 依据 S-003 §3.3/§3.7：main->renderer event 走 webContents.send。
 * 发送前检查 webContents.isDestroyed()（S-003 §4 边界条件）。
 */
export function sendEvent<K extends IpcEventChannel>(
  webContents: WebContents,
  channel: K,
  payload: IpcEventMap[K]
): void {
  if (webContents.isDestroyed()) {
    ipcLogger.debug('skip send to destroyed webContents', {
      scope: 'ipc',
      tags: { channel }
    })
    return
  }
  webContents.send(channel, payload)
}

/**
 * 注销所有已注册的 invoke handler。
 * 测试/清理时调用。
 */
export function removeAllHandlers(): void {
  for (const channel of IPC_INVOKE_CHANNELS) {
    ipcMain.removeHandler(channel)
  }
}
