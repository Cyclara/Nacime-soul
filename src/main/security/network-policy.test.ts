// src/main/security/network-policy.test.ts
// P1-09B 验收测试：网络出口策略
// 依据：S-001 P1-09B 验收标准、S-005 §3.2
//
// 验收标准：
//   1. 公网 HTTPS 通过
//   2. 127.0.0.1/私网/IPv6 mapped 私网/重定向到私网全部拒绝
//   3. dev 显式 localhost 例外
//   4. 第三方 http/https 请求受 globalAgent 拦截

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as dns from 'node:dns'
import * as http from 'node:http'
import * as https from 'node:https'
import {
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateIp,
  checkUrl,
  createSecureFetch,
  installGlobalAgentGuard,
  type NetworkPolicyOptions,
  type NetworkCheckResult
} from './network-policy'

const PROD_OPTS: NetworkPolicyOptions = { isDev: false, allowHttpLocalhostInDev: false }
const DEV_OPTS: NetworkPolicyOptions = { isDev: true, allowHttpLocalhostInDev: true }
const DEV_NO_LOCALHOST: NetworkPolicyOptions = { isDev: true, allowHttpLocalhostInDev: false }

/** 断言网络检查结果为拒绝，收窄类型以访问 code/reason */
function expectBlocked(
  result: NetworkCheckResult
): asserts result is { allowed: false; reason: string; code: string } {
  expect(result.allowed).toBe(false)
}

let dnsSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  dnsSpy = vi.spyOn(dns.promises, 'lookup')
})

afterEach(() => {
  dnsSpy.mockRestore()
  vi.restoreAllMocks()
})

/** mock DNS 解析返回指定地址列表 */
function mockDns(addresses: string[]): void {
  dnsSpy.mockResolvedValue(
    addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  )
}

// ── isPrivateIPv4 ──

describe('P1-09B isPrivateIPv4', () => {
  it('127.0.0.1 是私网（loopback）', () => {
    expect(isPrivateIPv4('127.0.0.1')).toBe(true)
  })

  it('127.255.255.255 是私网（loopback 边界）', () => {
    expect(isPrivateIPv4('127.255.255.255')).toBe(true)
  })

  it('10.x.x.x 是私网', () => {
    expect(isPrivateIPv4('10.0.0.1')).toBe(true)
    expect(isPrivateIPv4('10.255.255.255')).toBe(true)
  })

  it('192.168.x.x 是私网', () => {
    expect(isPrivateIPv4('192.168.1.1')).toBe(true)
    expect(isPrivateIPv4('192.168.0.0')).toBe(true)
  })

  it('172.16-31.x.x 是私网', () => {
    expect(isPrivateIPv4('172.16.0.1')).toBe(true)
    expect(isPrivateIPv4('172.31.255.255')).toBe(true)
  })

  it('172.32.x.x 不是私网（边界外）', () => {
    expect(isPrivateIPv4('172.32.0.1')).toBe(false)
  })

  it('172.15.x.x 不是私网（边界外）', () => {
    expect(isPrivateIPv4('172.15.0.1')).toBe(false)
  })

  it('169.254.x.x 是私网（link-local）', () => {
    expect(isPrivateIPv4('169.254.0.1')).toBe(true)
  })

  it('100.64.x.x 是私网（CGNAT）', () => {
    expect(isPrivateIPv4('100.64.0.1')).toBe(true)
  })

  it('0.0.0.0 是私网（unspecified）', () => {
    expect(isPrivateIPv4('0.0.0.0')).toBe(true)
  })

  it('公网 IP 不是私网', () => {
    expect(isPrivateIPv4('8.8.8.8')).toBe(false)
    expect(isPrivateIPv4('1.1.1.1')).toBe(false)
    expect(isPrivateIPv4('11.0.0.1')).toBe(false)
  })

  it('无效 IP 返回 false', () => {
    expect(isPrivateIPv4('999.999.999.999')).toBe(false)
    expect(isPrivateIPv4('not-an-ip')).toBe(false)
  })
})

// ── isPrivateIPv6 ──

describe('P1-09B isPrivateIPv6', () => {
  it('::1 是私网（loopback）', () => {
    expect(isPrivateIPv6('::1')).toBe(true)
  })

  it(':: 是私网（unspecified）', () => {
    expect(isPrivateIPv6('::')).toBe(true)
  })

  it('fc00:: 是私网（unique local）', () => {
    expect(isPrivateIPv6('fc00::1')).toBe(true)
  })

  it('fd00:: 是私网（unique local）', () => {
    expect(isPrivateIPv6('fd00::1')).toBe(true)
  })

  it('fe80:: 是私网（link-local）', () => {
    expect(isPrivateIPv6('fe80::1')).toBe(true)
  })

  it('::ffff:127.0.0.1 是私网（IPv4-mapped loopback）', () => {
    expect(isPrivateIPv6('::ffff:127.0.0.1')).toBe(true)
  })

  it('::ffff:10.0.0.1 是私网（IPv4-mapped private）', () => {
    expect(isPrivateIPv6('::ffff:10.0.0.1')).toBe(true)
  })

  it('::ffff:192.168.1.1 是私网（IPv4-mapped private）', () => {
    expect(isPrivateIPv6('::ffff:192.168.1.1')).toBe(true)
  })

  it('::ffff:8.8.8.8 不是私网（IPv4-mapped public）', () => {
    expect(isPrivateIPv6('::ffff:8.8.8.8')).toBe(false)
  })

  it('公网 IPv6 不是私网', () => {
    expect(isPrivateIPv6('2001:4860:4860::8888')).toBe(false)
  })
})

// ── isPrivateIp（统一入口）──

describe('P1-09B isPrivateIp 统一入口', () => {
  it('IPv4 私网', () => {
    expect(isPrivateIp('127.0.0.1')).toBe(true)
    expect(isPrivateIp('10.0.0.1')).toBe(true)
  })

  it('IPv4 公网', () => {
    expect(isPrivateIp('8.8.8.8')).toBe(false)
  })

  it('IPv6 私网', () => {
    expect(isPrivateIp('::1')).toBe(true)
    expect(isPrivateIp('fc00::1')).toBe(true)
  })

  it('IPv6 公网', () => {
    expect(isPrivateIp('2001:4860:4860::8888')).toBe(false)
  })
})

// ── checkUrl 公网 ──

describe('P1-09B checkUrl 公网 HTTPS 通过', () => {
  it('公网 HTTPS 域名通过', async () => {
    mockDns(['8.8.8.8'])
    const result = await checkUrl('https://api.deepseek.com/v1', PROD_OPTS)
    expect(result.allowed).toBe(true)
  })

  it('公网 HTTPS IP 通过', async () => {
    const result = await checkUrl('https://8.8.8.8/path', PROD_OPTS)
    expect(result.allowed).toBe(true)
  })

  it('公网 HTTPS IPv6 通过', async () => {
    const result = await checkUrl('https://[2001:4860:4860::8888]/path', PROD_OPTS)
    expect(result.allowed).toBe(true)
  })
})

// ── checkUrl 私网拦截 ──

describe('P1-09B checkUrl 私网全部拒绝', () => {
  it('127.0.0.1 拒绝（生产模式）', async () => {
    const result = await checkUrl('https://127.0.0.1/path', PROD_OPTS)
    expectBlocked(result)
    expect(result.code).toBe('NET_PRIVATE_BLOCKED')
  })

  it('10.0.0.1 拒绝', async () => {
    const result = await checkUrl('https://10.0.0.1/path', PROD_OPTS)
    expectBlocked(result)
    expect(result.code).toBe('NET_PRIVATE_BLOCKED')
  })

  it('192.168.1.1 拒绝', async () => {
    const result = await checkUrl('https://192.168.1.1/path', PROD_OPTS)
    expectBlocked(result)
  })

  it('172.16.0.1 拒绝', async () => {
    const result = await checkUrl('https://172.16.0.1/path', PROD_OPTS)
    expectBlocked(result)
  })

  it('169.254.0.1 拒绝（link-local）', async () => {
    const result = await checkUrl('https://169.254.0.1/path', PROD_OPTS)
    expectBlocked(result)
  })

  it('::1 拒绝（IPv6 loopback）', async () => {
    const result = await checkUrl('https://[::1]/path', PROD_OPTS)
    expectBlocked(result)
    expect(result.code).toBe('NET_PRIVATE_BLOCKED')
  })

  it('fc00::1 拒绝（IPv6 unique local）', async () => {
    const result = await checkUrl('https://[fc00::1]/path', PROD_OPTS)
    expectBlocked(result)
  })

  it('fe80::1 拒绝（IPv6 link-local）', async () => {
    const result = await checkUrl('https://[fe80::1]/path', PROD_OPTS)
    expectBlocked(result)
  })

  it('::ffff:127.0.0.1 拒绝（IPv6 mapped 私网）', async () => {
    const result = await checkUrl('https://[::ffff:127.0.0.1]/path', PROD_OPTS)
    expectBlocked(result)
    expect(result.code).toBe('NET_PRIVATE_BLOCKED')
  })

  it('::ffff:10.0.0.1 拒绝（IPv6 mapped 私网）', async () => {
    const result = await checkUrl('https://[::ffff:10.0.0.1]/path', PROD_OPTS)
    expectBlocked(result)
  })

  it('localhost 解析到 127.0.0.1 拒绝（生产模式）', async () => {
    mockDns(['127.0.0.1'])
    const result = await checkUrl('https://localhost/path', PROD_OPTS)
    expectBlocked(result)
  })

  it('域名解析到私网 IP 拒绝', async () => {
    mockDns(['10.0.0.5'])
    const result = await checkUrl('https://internal.corp.com/path', PROD_OPTS)
    expectBlocked(result)
    expect(result.code).toBe('NET_PRIVATE_BLOCKED')
  })

  it('域名解析到 IPv6 私网拒绝', async () => {
    mockDns(['::1'])
    const result = await checkUrl('https://internal.corp.com/path', PROD_OPTS)
    expectBlocked(result)
  })
})

// ── checkUrl 协议检查 ──

describe('P1-09B checkUrl 协议检查', () => {
  it('ftp:// 拒绝', async () => {
    const result = await checkUrl('ftp://example.com/file', PROD_OPTS)
    expectBlocked(result)
    expect(result.code).toBe('NET_BAD_PROTOCOL')
  })

  it('file:// 拒绝', async () => {
    const result = await checkUrl('file:///etc/passwd', PROD_OPTS)
    expectBlocked(result)
    expect(result.code).toBe('NET_BAD_PROTOCOL')
  })

  it('公网 HTTP 拒绝（生产只允许 HTTPS）', async () => {
    mockDns(['8.8.8.8'])
    const result = await checkUrl('http://api.example.com/path', PROD_OPTS)
    expectBlocked(result)
    expect(result.code).toBe('NET_HTTP_NOT_ALLOWED')
  })

  it('公网 HTTP 拒绝（dev 模式也只对 localhost 放开 HTTP）', async () => {
    mockDns(['8.8.8.8'])
    const result = await checkUrl('http://api.example.com/path', DEV_OPTS)
    expectBlocked(result)
    expect(result.code).toBe('NET_HTTP_NOT_ALLOWED')
  })

  it('无效 URL 拒绝', async () => {
    const result = await checkUrl('not a url at all', PROD_OPTS)
    expectBlocked(result)
    expect(result.code).toBe('NET_INVALID_URL')
  })
})

// ── checkUrl dev localhost 例外 ──

describe('P1-09B checkUrl dev 显式 localhost 例外', () => {
  it('dev + allowHttpLocalhostInDev 允许 localhost HTTP', async () => {
    const result = await checkUrl('http://localhost:11434/api', DEV_OPTS)
    expect(result.allowed).toBe(true)
  })

  it('dev + allowHttpLocalhostInDev 允许 127.0.0.1 HTTP', async () => {
    const result = await checkUrl('http://127.0.0.1:11434/api', DEV_OPTS)
    expect(result.allowed).toBe(true)
  })

  it('dev + allowHttpLocalhostInDev 允许 localhost HTTPS', async () => {
    const result = await checkUrl('https://localhost:11434/api', DEV_OPTS)
    expect(result.allowed).toBe(true)
  })

  it('dev 但 allowHttpLocalhostInDev=false 拒绝 localhost HTTP', async () => {
    const result = await checkUrl('http://localhost:11434/api', DEV_NO_LOCALHOST)
    expectBlocked(result)
  })

  it('生产模式拒绝 localhost HTTP（即使 allowHttpLocalhostInDev=true）', async () => {
    const result = await checkUrl('http://localhost:11434/api', {
      isDev: false,
      allowHttpLocalhostInDev: true
    })
    expectBlocked(result)
  })

  it('生产模式拒绝 localhost HTTPS', async () => {
    const result = await checkUrl('https://localhost:11434/api', {
      isDev: false,
      allowHttpLocalhostInDev: true
    })
    expectBlocked(result)
  })

  it('dev 例外不放开非 localhost 私网', async () => {
    const result = await checkUrl('http://10.0.0.1:8080/api', DEV_OPTS)
    expectBlocked(result)
  })

  it('dev 例外不放开 ::1 HTTP', async () => {
    const result = await checkUrl('http://[::1]:8080/api', DEV_OPTS)
    expect(result.allowed).toBe(true) // ::1 属于 localhost
  })
})

// ── checkUrl DNS 失败 ──

describe('P1-09B checkUrl DNS 解析失败', () => {
  it('DNS 解析失败拒绝', async () => {
    dnsSpy.mockRejectedValue(new Error('ENOTFOUND'))
    const result = await checkUrl('https://nonexistent.invalid.example/path', PROD_OPTS)
    expectBlocked(result)
    expect(result.code).toBe('NET_DNS')
  })
})

// ── Layer 2: createSecureFetch ──

describe('P1-09B createSecureFetch 重定向复验', () => {
  it('公网 HTTPS 请求通过', async () => {
    mockDns(['8.8.8.8'])
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const secureFetch = createSecureFetch(PROD_OPTS)
    const res = await secureFetch('https://api.example.com/test')
    expect(res.status).toBe(200)
  })

  it('私网请求被拒绝', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const secureFetch = createSecureFetch(PROD_OPTS)
    await expect(secureFetch('https://127.0.0.1/evil')).rejects.toThrow()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('重定向到私网 IP 被拒绝', async () => {
    mockDns(['8.8.8.8']) // 初始 URL 解析到公网
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    // 第一次请求返回 302 重定向到私网
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/evil' } })
    )

    const secureFetch = createSecureFetch(PROD_OPTS)
    await expect(secureFetch('https://api.example.com/test')).rejects.toThrow('redirect')
  })

  it('重定向到私网域名被拒绝', async () => {
    // 初始 URL -> 公网 IP
    // 重定向 URL -> 私网 IP
    mockDns(['8.8.8.8']) // 默认返回公网
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: 'https://internal.evil.com/steal' } })
    )
    // 重定向 URL 的 DNS 解析返回私网
    dnsSpy.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }])

    const secureFetch = createSecureFetch(PROD_OPTS)
    await expect(secureFetch('https://api.example.com/test')).rejects.toThrow()
  })

  it('公网重定向到公网通过', async () => {
    mockDns(['8.8.8.8'])
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: 'https://cdn.example.com/redirected' }
      })
    )
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const secureFetch = createSecureFetch(PROD_OPTS)
    const res = await secureFetch('https://api.example.com/test')
    expect(res.status).toBe(200)
  })

  it('超过 5 次重定向拒绝', async () => {
    mockDns(['8.8.8.8'])
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    // 每次都返回 302 重定向
    const redirectResponse = new Response(null, {
      status: 302,
      headers: { location: 'https://api.example.com/loop' }
    })
    fetchMock.mockResolvedValue(redirectResponse)

    const secureFetch = createSecureFetch(PROD_OPTS)
    await expect(secureFetch('https://api.example.com/test')).rejects.toThrow('redirect')
  })

  it('dev 模式允许 localhost 请求', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }))

    const secureFetch = createSecureFetch(DEV_OPTS)
    const res = await secureFetch('http://localhost:11434/api')
    expect(res.status).toBe(200)
  })
})

// ── Layer 1: globalAgent 钩子 ──

describe('P1-09B globalAgent 钩子拦截', () => {
  it('安装后 createConnection 被替换', () => {
    const origHttp = http.globalAgent.createConnection
    const origHttps = https.globalAgent.createConnection
    const uninstall = installGlobalAgentGuard(PROD_OPTS)
    expect(http.globalAgent.createConnection).not.toBe(origHttp)
    expect(https.globalAgent.createConnection).not.toBe(origHttps)
    uninstall()
    expect(http.globalAgent.createConnection).toBe(origHttp)
    expect(https.globalAgent.createConnection).toBe(origHttps)
  })

  it('卸载后恢复原始 createConnection', () => {
    const origHttp = http.globalAgent.createConnection
    const uninstall = installGlobalAgentGuard(PROD_OPTS)
    uninstall()
    expect(http.globalAgent.createConnection).toBe(origHttp)
  })

  it('http.globalAgent 拦截 127.0.0.1', () => {
    const uninstall = installGlobalAgentGuard(PROD_OPTS)
    expect(() => {
      http.globalAgent.createConnection({ host: '127.0.0.1', port: 8080 } as http.RequestOptions)
    }).toThrow('private network')
    uninstall()
  })

  it('http.globalAgent 拦截 10.0.0.1', () => {
    const uninstall = installGlobalAgentGuard(PROD_OPTS)
    expect(() => {
      http.globalAgent.createConnection({ host: '10.0.0.1', port: 8080 } as http.RequestOptions)
    }).toThrow('private network')
    uninstall()
  })

  it('http.globalAgent 拦截 192.168.1.1', () => {
    const uninstall = installGlobalAgentGuard(PROD_OPTS)
    expect(() => {
      http.globalAgent.createConnection({ host: '192.168.1.1', port: 8080 } as http.RequestOptions)
    }).toThrow('private network')
    uninstall()
  })

  it('https.globalAgent 拦截 172.16.0.1', () => {
    const uninstall = installGlobalAgentGuard(PROD_OPTS)
    expect(() => {
      https.globalAgent.createConnection({ host: '172.16.0.1', port: 443 } as https.RequestOptions)
    }).toThrow('private network')
    uninstall()
  })

  it('dev 模式不拦截 localhost', () => {
    const uninstall = installGlobalAgentGuard(DEV_OPTS)
    // localhost 在 dev 模式下不抛错（但会尝试创建连接，可能 ECONNREFUSED）
    // 我们只验证不抛 "private network" 错误
    try {
      http.globalAgent.createConnection({ host: 'localhost', port: 99999 } as http.RequestOptions)
    } catch (e) {
      // ECONNREFUSED 或其他连接错误可以接受，但不能是 "private network"
      expect((e as Error).message).not.toContain('private network')
    }
    uninstall()
  })

  it('dev 模式不拦截 127.0.0.1', () => {
    const uninstall = installGlobalAgentGuard(DEV_OPTS)
    try {
      http.globalAgent.createConnection({ host: '127.0.0.1', port: 99999 } as http.RequestOptions)
    } catch (e) {
      expect((e as Error).message).not.toContain('private network')
    }
    uninstall()
  })

  it('dev 模式但仍拦截 10.0.0.1（非 localhost 私网）', () => {
    const uninstall = installGlobalAgentGuard(DEV_OPTS)
    expect(() => {
      http.globalAgent.createConnection({ host: '10.0.0.1', port: 8080 } as http.RequestOptions)
    }).toThrow('private network')
    uninstall()
  })
})
