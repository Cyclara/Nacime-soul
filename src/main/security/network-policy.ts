// src/main/security/network-policy.ts
// P1-09B: 网络出口策略 - 两层私网拦截
// 依据：S-001 P1-09B、S-005 §3.2 Provider/CSP/网络联动合同
//
// 两层拦截（S-001 P1-09B 明确要求）：
//   Layer 1: http/https.globalAgent 钩子 — 拦截直接用 IP 访问私网的请求
//   Layer 2: createSecureFetch 包装器 — DNS 解析 + IP 检查 + 每次重定向后复验
//
// 两层都要，因为现代 fetch（undici）不走 Node globalAgent。
//
// 策略：
//   生产：只允许 HTTPS 公网 Provider，拒绝所有私网/环回/链路本地
//   dev：allowHttpLocalhostInDev=true 时允许 localhost HTTP（宽泛开关，仅限 Provider）
//   未来本地服务（GPT-SoVITS 等）：按精确 origin+端口白名单，不复用 Provider 宽泛开关
//
// Q-002 处理：P1-09B 验收只覆盖拦截/重定向复验/白名单；
//           SEC_* 安全事件日志集成等 P1-12 完成后接入（当前用 noopLogger 占位）。

import * as dns from 'node:dns'
import * as http from 'node:http'
import * as https from 'node:https'
import type { Logger } from '@shared/observability/types'

/** 网络策略选项 */
export interface NetworkPolicyOptions {
  /** 是否为开发构建 */
  isDev: boolean
  /**
   * 是否允许 dev 模式下 localhost HTTP 例外。
   * 受 isDev 双条件限制：isDev && allowHttpLocalhostInDev 同时为 true 才生效。
   * 这是 Provider 的宽泛开关，未来本地服务不复用此开关。
   */
  allowHttpLocalhostInDev: boolean
}

/** 网络检查结果 */
export type NetworkCheckResult =
  { allowed: true } | { allowed: false; reason: string; code: string }

/** noop logger，P1-12 真实 Logger 注入前的占位 */
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

// ── IP 地址判断 ──

/** 判断 hostname 是否为 IP 地址（IPv4 或 IPv6） */
function isIpAddress(hostname: string): boolean {
  // IPv4: x.x.x.x
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
    return hostname.split('.').every((part) => {
      const n = Number(part)
      return Number.isInteger(n) && n >= 0 && n <= 255
    })
  }
  // IPv6: 含冒号
  if (hostname.includes(':')) return true
  return false
}

/** 将 IPv4 字符串转为 32 位无符号整数 */
function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number)
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

/** 私网/环回/链路本地 IPv4 范围 */
const PRIVATE_IPV4_RANGES: ReadonlyArray<{ start: number; end: number; name: string }> = [
  { start: ipv4ToInt('0.0.0.0'), end: ipv4ToInt('0.255.255.255'), name: 'unspecified' },
  { start: ipv4ToInt('10.0.0.0'), end: ipv4ToInt('10.255.255.255'), name: 'private-10' },
  { start: ipv4ToInt('100.64.0.0'), end: ipv4ToInt('100.127.255.255'), name: 'cgnat' },
  { start: ipv4ToInt('127.0.0.0'), end: ipv4ToInt('127.255.255.255'), name: 'loopback' },
  { start: ipv4ToInt('169.254.0.0'), end: ipv4ToInt('169.254.255.255'), name: 'link-local' },
  { start: ipv4ToInt('172.16.0.0'), end: ipv4ToInt('172.31.255.255'), name: 'private-172' },
  { start: ipv4ToInt('192.168.0.0'), end: ipv4ToInt('192.168.255.255'), name: 'private-192' }
]

/** 检查 IPv4 地址是否为私网/环回/链路本地 */
export function isPrivateIPv4(ip: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return false
  if (!ip.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255)) return false
  const num = ipv4ToInt(ip)
  return PRIVATE_IPV4_RANGES.some((r) => num >= r.start && num <= r.end)
}

/** 检查 IPv6 地址是否为私网/环回/链路本地 */
export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  // ::1 loopback
  if (lower === '::1') return true
  // :: unspecified
  if (lower === '::') return true
  // fc00::/7 unique local (fc 或 fd 开头)
  if (/^f[cd]/.test(lower)) return true
  // fe80::/10 link-local (fe8/fe9/fea/feb)
  if (/^fe[89ab]/.test(lower)) return true
  // ::ffff:x.x.x.x IPv4-mapped IPv6 — 检查映射的 IPv4
  const v4mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/)
  if (v4mapped) return isPrivateIPv4(v4mapped[1])
  // ::ffff:0:0/96 的十六进制形式
  const v4mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/)
  if (v4mappedHex) {
    // 将两个 16 位组拼成 32 位 IPv4
    const hi = parseInt(v4mappedHex[1], 16)
    const lo = parseInt(v4mappedHex[2], 16)
    const v4 = `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
    return isPrivateIPv4(v4)
  }
  return false
}

/** 检查 IP 地址（IPv4 或 IPv6）是否为私网/环回/链路本地 */
export function isPrivateIp(ip: string): boolean {
  if (ip.includes(':')) return isPrivateIPv6(ip)
  return isPrivateIPv4(ip)
}

/** 判断 hostname 是否为 localhost（环回域名） */
function isLocalhostHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
}

// ── DNS 解析 ──

const DNS_TIMEOUT_MS = 10_000

/** 解析 hostname 到 IP 地址列表。localhost 直接返回 127.0.0.1 */
async function resolveHost(hostname: string, signal?: AbortSignal): Promise<string[]> {
  if (hostname === 'localhost') return ['127.0.0.1']

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`DNS resolution timeout for ${hostname} after ${DNS_TIMEOUT_MS}ms`))
    }, DNS_TIMEOUT_MS)

    const onAbort = (): void => {
      clearTimeout(timeoutId)
      reject(new Error(`DNS resolution aborted for ${hostname}`))
    }

    if (signal?.aborted) {
      clearTimeout(timeoutId)
      reject(new Error(`DNS resolution aborted for ${hostname}`))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    dns.promises
      .lookup(hostname, { all: true })
      .then((results) => {
        clearTimeout(timeoutId)
        signal?.removeEventListener('abort', onAbort)
        resolve(results.map((r) => r.address))
      })
      .catch((e) => {
        clearTimeout(timeoutId)
        signal?.removeEventListener('abort', onAbort)
        reject(
          new Error(
            `DNS resolution failed for ${hostname}: ${e instanceof Error ? e.message : String(e)}`
          )
        )
      })
  })
}

// ── URL 检查 ──

/**
 * 检查 URL 是否允许访问。
 * 这是网络策略的核心纯函数，fetch 层和 globalAgent 层都依赖它。
 */
export async function checkUrl(
  url: string,
  opts: NetworkPolicyOptions,
  signal?: AbortSignal
): Promise<NetworkCheckResult> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { allowed: false, reason: 'Invalid URL', code: 'NET_INVALID_URL' }
  }

  const protocol = parsed.protocol
  // WHATWG URL 对 IPv6 hostname 保留方括号（如 [::1]），去掉用于后续 IP 检查
  const rawHostname = parsed.hostname
  const hostname =
    rawHostname.startsWith('[') && rawHostname.endsWith(']')
      ? rawHostname.slice(1, -1)
      : rawHostname

  // 1. 协议检查：只允许 http/https
  if (protocol !== 'http:' && protocol !== 'https:') {
    return {
      allowed: false,
      reason: `Disallowed protocol: ${protocol}`,
      code: 'NET_BAD_PROTOCOL'
    }
  }

  // 2. 解析 hostname 到 IP 地址列表（支持 abort signal 取消/超时）
  let addresses: string[]
  if (isIpAddress(hostname)) {
    addresses = [hostname]
  } else {
    try {
      addresses = await resolveHost(hostname, signal)
    } catch (e) {
      if (signal?.aborted) {
        return {
          allowed: false,
          reason: `DNS resolution aborted: ${hostname}`,
          code: 'NET_TIMEOUT'
        }
      }
      return {
        allowed: false,
        reason: `DNS resolution failed: ${hostname}: ${e instanceof Error ? e.message : String(e)}`,
        code: 'NET_DNS'
      }
    }
  }

  // 3. 检查是否解析到私网 IP
  const privateAddr = addresses.find((addr) => isPrivateIp(addr))
  if (privateAddr) {
    // dev localhost 例外：isDev && allowHttpLocalhostInDev 双条件
    if (isLocalhostHost(hostname) && opts.isDev && opts.allowHttpLocalhostInDev) {
      return { allowed: true }
    }
    return {
      allowed: false,
      reason: `Private network address: ${privateAddr} (${hostname})`,
      code: 'NET_PRIVATE_BLOCKED'
    }
  }

  // 4. 非 localhost 的 HTTP 拒绝（生产只允许 HTTPS；dev 也只对 localhost 放开 HTTP）
  if (protocol === 'http:') {
    return {
      allowed: false,
      reason: 'HTTP not allowed for public addresses (HTTPS only)',
      code: 'NET_HTTP_NOT_ALLOWED'
    }
  }

  return { allowed: true }
}

// ── Layer 1: globalAgent 钩子 ──

/**
 * 安装 globalAgent 私网拦截钩子。
 * 拦截直接用 IP 访问私网的 http/https 请求（如 http://127.0.0.1:8080）。
 * 对于 hostname 请求，globalAgent 层只能检查 localhost；真正的 DNS 解析检查在 fetch 层完成。
 * 返回卸载函数，调用后恢复原始 globalAgent。
 */
export function installGlobalAgentGuard(opts: NetworkPolicyOptions, logger?: Logger): () => void {
  const log = logger ?? noopLogger

  /**
   * 检查连接目标的 host。如果是私网 IP 且不满足 dev localhost 例外，抛错阻断连接。
   */
  const guardConnection = (host: string | undefined): void => {
    if (!host) return

    // 如果是 IP 地址，直接检查
    if (isIpAddress(host) && isPrivateIp(host)) {
      // dev localhost 例外
      if (isLocalhostHost(host) && opts.isDev && opts.allowHttpLocalhostInDev) {
        return
      }
      log.warn('globalAgent blocked private network connection', {
        scope: 'network',
        tags: { host, code: 'NET_PRIVATE_BLOCKED' }
      })
      throw new Error(`Network policy blocked: private network ${host}`)
    }

    // localhost 域名检查
    if (host === 'localhost' && opts.isDev && opts.allowHttpLocalhostInDev) {
      return
    }
    // 其他 hostname 的 DNS 解析检查由 fetch 层负责
    // globalAgent 层不解析 DNS（避免双重解析）
  }

  const origHttpCreate = http.globalAgent.createConnection
  const origHttpsCreate = https.globalAgent.createConnection

  // 覆盖 http.globalAgent.createConnection
  http.globalAgent.createConnection = function (this: http.Agent, options: http.RequestOptions) {
    guardConnection((options as { host?: string }).host)
    // eslint-disable-next-line prefer-rest-params
    return origHttpCreate.apply(this, arguments as unknown as Parameters<typeof origHttpCreate>)
  } as typeof http.globalAgent.createConnection

  // 覆盖 https.globalAgent.createConnection
  https.globalAgent.createConnection = function (this: https.Agent, options: https.RequestOptions) {
    guardConnection((options as { host?: string }).host)
    // eslint-disable-next-line prefer-rest-params
    return origHttpsCreate.apply(this, arguments as unknown as Parameters<typeof origHttpsCreate>)
  } as typeof https.globalAgent.createConnection

  // 返回卸载函数
  return () => {
    http.globalAgent.createConnection = origHttpCreate
    https.globalAgent.createConnection = origHttpsCreate
  }
}

// ── Layer 2: createSecureFetch ──

const MAX_REDIRECTS = 5

/**
 * 创建安全 fetch 包装器。
 * 请求前检查 URL，每次重定向后复验 URL（使用 redirect: 'manual' 手动跟随）。
 * 这是 Layer 2，与 globalAgent 钩子（Layer 1）互补。
 */
export function createSecureFetch(
  opts: NetworkPolicyOptions,
  logger?: Logger
): typeof globalThis.fetch {
  const log = logger ?? noopLogger

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const initialUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const signal = init?.signal instanceof AbortSignal ? init.signal : undefined

    // 提前检查 abort signal，避免无意义的网络检查
    if (signal?.aborted) {
      throw new Error('Network policy check aborted')
    }

    // 检查初始 URL
    const initialCheck = await checkUrl(initialUrl, opts, signal)
    if (!initialCheck.allowed) {
      log.warn('fetch blocked by network policy', {
        scope: 'network',
        tags: { code: initialCheck.code },
        detail: initialCheck.reason
      })
      throw new Error(`Network policy blocked: ${initialCheck.reason}`)
    }

    // 使用 manual redirect 以检查每个重定向目标
    let currentUrl = initialUrl
    let redirectCount = 0

    while (true) {
      if (signal?.aborted) {
        throw new Error('Network policy check aborted')
      }

      const response = await globalThis.fetch(currentUrl, { ...init, redirect: 'manual' })

      // 检查是否为重定向（3xx）
      if (response.status >= 300 && response.status < 400) {
        redirectCount++
        if (redirectCount > MAX_REDIRECTS) {
          throw new Error(`Too many redirects (>${MAX_REDIRECTS})`)
        }
        const location = response.headers.get('location')
        if (!location) {
          // 3xx 但无 Location header，返回响应让调用者处理
          return response
        }
        // 解析重定向 URL（可能为相对路径）
        const redirectUrl = new URL(location, currentUrl).href
        // 复验重定向目标 URL
        const redirectCheck = await checkUrl(redirectUrl, opts, signal)
        if (!redirectCheck.allowed) {
          log.warn('redirect blocked by network policy', {
            scope: 'network',
            tags: { code: redirectCheck.code },
            detail: redirectCheck.reason
          })
          throw new Error(
            `Network policy blocked redirect to ${redirectUrl}: ${redirectCheck.reason}`
          )
        }
        currentUrl = redirectUrl
        continue
      }

      return response
    }
  }
}
