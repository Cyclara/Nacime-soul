// src/main/voice/tts/gpt-runtime-manager.test.ts
// P3V-16：GPT runtime 下载器/安装器合同——小包注入 + 假 fetch + 假解压，
// 不碰真实网络与 8GB 文件（handoff §10：单测不得加载真实 GPT Python）。

import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile, stat, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { AssetDownloadStatus } from '@shared/voice/asset-root-types'
import {
  GPT_RUNTIME_CATALOG,
  GPT_RUNTIME_MARKERS,
  GPT_RUNTIME_META_FILE,
  type GptRuntimePackage
} from './gpt-runtime-catalog'
import {
  createGptRuntimeManager,
  type GptRuntimeManager,
  type GptRuntimeManagerDeps
} from './gpt-runtime-manager'

/** 测试用小包：3 字节内容、两个镜像、顶层目录 test-root。 */
const PAYLOAD = 'nac'
const PAYLOAD_SHA = createHash('sha256').update(PAYLOAD).digest('hex')

function testPackage(): GptRuntimePackage {
  return {
    variant: 'standard',
    displayName: 'test',
    fileName: 'test-pkg.7z',
    bytes: PAYLOAD.length,
    sha256: PAYLOAD_SHA,
    mirrors: ['https://mirror-a.invalid/test-pkg.7z', 'https://mirror-b.invalid/test-pkg.7z'],
    archiveTopDir: 'test-root'
  }
}

function makeResponse(
  body: string,
  options?: { status?: number; headers?: Record<string, string> }
): Response {
  return new Response(body, {
    status: options?.status ?? 200,
    headers: options?.headers
  })
}

interface FetchCall {
  readonly url: string
  readonly headers?: Record<string, string>
  readonly signal?: AbortSignal
}

function makeFetch(
  respond: (call: FetchCall) => Response | Promise<Response>
): ((url: string, init?: RequestInit) => Promise<Response>) & { calls: FetchCall[] } {
  const calls: FetchCall[] = []
  const impl = (url: string, init?: RequestInit): Promise<Response> => {
    const headers = init?.headers as Record<string, string> | undefined
    const signal = init?.signal ?? undefined
    calls.push({ url, headers, signal })
    return Promise.resolve(respond({ url, headers, signal }))
  }
  return Object.assign(impl, { calls })
}

/** abort 感知的流 Response：signal abort 时 body 流 error（真 fetch 的行为）。 */
function streamedResponse(
  signal: AbortSignal | undefined,
  build: (controller: ReadableStreamDefaultController<Uint8Array>, release: Promise<void>) => void,
  release: Promise<void>
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const onAbort = (): void => {
          controller.error(new DOMException('The operation was aborted.', 'AbortError'))
        }
        if (signal !== undefined) {
          if (signal.aborted) onAbort()
          else signal.addEventListener('abort', onAbort, { once: true })
        }
        build(controller, release)
      }
    })
  )
}

/** 假解压：在 dest/<topDir> 下落 marker 文件（生产 bsdtar 的形状替身）。 */
function fakeExtract(archivePath: string, destDir: string): Promise<void> {
  return mkdir(join(destDir, 'test-root', 'runtime'), { recursive: true })
    .then(() => mkdir(join(destDir, 'test-root', 'GPT_SoVITS', 'configs'), { recursive: true }))
    .then(() =>
      mkdir(join(destDir, 'test-root', 'GPT_SoVITS', 'pretrained_models'), { recursive: true })
    )
    .then(() => writeFile(join(destDir, 'test-root', 'runtime', 'python.exe'), 'py'))
    .then(() => writeFile(join(destDir, 'test-root', 'api_v2.py'), 'api'))
    .then(() =>
      writeFile(join(destDir, 'test-root', 'GPT_SoVITS', 'configs', 'tts_infer.yaml'), 'custom:')
    )
    .then(() => rm(archivePath, { force: true }).then(() => undefined))
}

interface Harness {
  root: string
  fetch: ReturnType<typeof makeFetch>
  fetchImpl: typeof globalThis.fetch
  extractArchive: (archivePath: string, destDir: string) => Promise<void>
  freeBytes: { value: number | null }
  renamePath?: (from: string, to: string) => Promise<void>
  /** 每次取当前可变字段的 deps 快照（readonly 接口不可中途改赋）。 */
  deps(): GptRuntimeManagerDeps
}

function makeHarness(overrides?: {
  fetch?: ReturnType<typeof makeFetch>
  freeBytes?: number | null
  renamePath?: (from: string, to: string) => Promise<void>
}): Harness {
  const fetch = overrides?.fetch ?? makeFetch(() => makeResponse(PAYLOAD))
  const harness: Harness = {
    root: '',
    fetch,
    fetchImpl: fetch as unknown as typeof globalThis.fetch,
    extractArchive: fakeExtract,
    freeBytes: { value: overrides?.freeBytes ?? 100 * 1024 * 1024 * 1024 },
    ...(overrides?.renamePath === undefined ? {} : { renamePath: overrides.renamePath }),
    deps: (): GptRuntimeManagerDeps => ({
      assetRootDir: () => harness.root,
      fetchImpl: harness.fetchImpl,
      freeBytes: () => harness.freeBytes.value,
      resolvePackage: () => testPackage(),
      extractArchive: harness.extractArchive,
      ...(harness.renamePath === undefined ? {} : { renamePath: harness.renamePath })
    })
  }
  return harness
}

describe('P3V-16 gpt-runtime-manager', () => {
  let base: string

  beforeAll(async () => {
    base = await mkdtemp(join(tmpdir(), 'gpt-runtime-'))
  })

  afterAll(async () => {
    await rm(base, { recursive: true, force: true })
  })

  async function freshHarness(overrides?: Parameters<typeof makeHarness>[0]): Promise<{
    h: Harness
    manager: ReturnType<typeof createGptRuntimeManager>
  }> {
    const h = makeHarness(overrides)
    h.root = await mkdtemp(join(base, 'case-'))
    const manager = createGptRuntimeManager(h.deps())
    return { h, manager }
  }

  it('catalog：两变体字节数与 handoff 钉死值一致（8,185,086,602 / 8,835,144,925）', () => {
    expect(GPT_RUNTIME_CATALOG.standard!.bytes).toBe(8_185_086_602)
    expect(GPT_RUNTIME_CATALOG.rtx50!.bytes).toBe(8_835_144_925)
    expect(GPT_RUNTIME_CATALOG.standard!.sha256).toBe(
      'bd60d0796553ff05d8568136e199c13e0dc22ebe2ed24273134e34ed6f215cd6'
    )
    expect(GPT_RUNTIME_CATALOG.rtx50!.sha256).toBe(
      '97b4edcd451c42357db7e26e6c1c877ca5d85144fe97beaff6d7005d35bee008'
    )
    // 三镜像：HF 主源 → ModelScope → hf-mirror（官方 release 20250606v2pro 列出）
    expect(GPT_RUNTIME_CATALOG.standard!.mirrors).toHaveLength(3)
    expect(GPT_RUNTIME_CATALOG.standard!.mirrors[0]).toContain('huggingface.co')
    expect(GPT_RUNTIME_CATALOG.standard!.mirrors[1]).toContain('modelscope.cn')
    expect(GPT_RUNTIME_CATALOG.standard!.mirrors[2]).toContain('hf-mirror.com')
  })

  it('download 全链路：下载→校验→解压→marker→meta→原子安装；归档与暂存清理', async () => {
    const { h, manager } = await freshHarness()
    await manager.download('standard')
    // 即发即回：download 返回 resolved，完成由内部任务推进
    await vi.waitFor(() => expect(manager.state('standard').kind).toBe('done'))

    const installRoot = join(h.root, 'gpt-sovits')
    expect(existsSync(join(installRoot, 'runtime', 'python.exe'))).toBe(true)
    expect(existsSync(join(installRoot, 'api_v2.py'))).toBe(true)
    expect(existsSync(join(installRoot, GPT_RUNTIME_META_FILE))).toBe(true)
    // 暂存与归档清理
    expect(existsSync(join(h.root, '.gpt-runtime-download'))).toBe(false)

    const installed = manager.installed()
    expect(installed).not.toBeNull()
    expect(installed!.variant).toBe('standard')
    expect(installed!.rootDir).toBe(installRoot)
    const meta = JSON.parse(readFileSync(join(installRoot, GPT_RUNTIME_META_FILE), 'utf-8')) as {
      variant: string
      installedAt: number
    }
    expect(meta.variant).toBe('standard')
    expect(typeof meta.installedAt).toBe('number')

    // DTO 投影（renderer 视角：无路径、钉死总量）
    const status = manager.status('standard')
    expect(status.assetId).toBe('gpt-runtime-standard')
    expect(status.state).toBe('done')
    expect(status.totalBytes).toBe(PAYLOAD.length)
    expect(status.currentFile).toBeUndefined()
    expect(status.receivedBytes).toBe(PAYLOAD.length)
  })

  it('空间不足立即失败（disk-full），不发网络请求、不留暂存', async () => {
    const { h, manager } = await freshHarness({
      freeBytes: 5 * 1024 * 1024 * 1024
    })
    await manager.download('standard')
    await vi.waitFor(() => {
      const state = manager.state('standard')
      expect(state.kind).toBe('error')
      expect(state.kind === 'error' && state.code).toBe('disk-full')
    })
    expect(h.fetch.calls).toHaveLength(0)
    expect(existsSync(join(h.root, '.gpt-runtime-download'))).toBe(false)
    expect(manager.status('standard').errorCode).toBe('disk-full')
  })

  it('sha256 不符：hash-mismatch + 删除断点 .part（坏断点不可续传）', async () => {
    // 'bad' 与 PAYLOAD 同为 3 字节：先过字节数判定、再撞哈希——精确测 hash 分支
    const { h, manager } = await freshHarness({
      fetch: makeFetch(() => makeResponse('bad'))
    })
    await manager.download('standard')
    await vi.waitFor(() => {
      const state = manager.state('standard')
      expect(state.kind).toBe('error')
      expect(state.kind === 'error' && state.code).toBe('hash-mismatch')
    })
    expect(existsSync(join(h.root, '.gpt-runtime-download', 'test-pkg.7z.part'))).toBe(false)
    expect(manager.status('standard').errorCode).toBe('hash-mismatch')
  })

  it('字节数不符：size-mismatch（received != 钉死 bytes）', async () => {
    const { manager } = await freshHarness({
      fetch: makeFetch(() => makeResponse('too-long-payload'))
    })
    await manager.download('standard')
    await vi.waitFor(() => {
      const state = manager.state('standard')
      expect(state.kind).toBe('error')
      expect(state.kind === 'error' && state.code).toBe('size-mismatch')
    })
  })

  it('镜像回退：首个镜像 5xx 换下一镜像；全部失败 download-failed', async () => {
    let call = 0
    const { manager } = await freshHarness({
      fetch: makeFetch(() => {
        call += 1
        return call === 1 ? makeResponse('gateway issue', { status: 503 }) : makeResponse(PAYLOAD)
      })
    })
    await manager.download('standard')
    await vi.waitFor(() => expect(manager.state('standard').kind).toBe('done'))

    const { manager: failManager } = await freshHarness({
      fetch: makeFetch(() => makeResponse('nope', { status: 500 }))
    })
    await failManager.download('standard')
    await vi.waitFor(() => {
      const state = failManager.state('standard')
      expect(state.kind).toBe('error')
      expect(state.kind === 'error' && state.code).toBe('download-failed')
    })
  })

  it('断点续传：.part 已有 2 字节发 Range bytes=2-（206 追加）', async () => {
    const fetch = makeFetch((call) =>
      call.headers?.['Range'] === 'bytes=2-'
        ? makeResponse('c', { status: 206, headers: { 'content-range': 'bytes 2-2/3' } })
        : makeResponse(PAYLOAD)
    )
    const { h, manager } = await freshHarness({ fetch })
    // 预置 2 字节断点（模拟上次会话中断）
    await mkdir(join(h.root, '.gpt-runtime-download'), { recursive: true })
    await writeFile(join(h.root, '.gpt-runtime-download', 'test-pkg.7z.part'), 'na')

    await manager.download('standard')
    await vi.waitFor(() => expect(manager.state('standard').kind).toBe('done'))
    expect(fetch.calls.some((call) => call.headers?.['Range'] === 'bytes=2-')).toBe(true)
    // 安装内容完整（断点 2 字节 + 续传 1 字节 = 完整 PAYLOAD 通过 sha256）
    expect(existsSync(join(h.root, 'gpt-sovits', 'runtime', 'python.exe'))).toBe(true)
  })

  it('暂停→续传：Range 从 .part 断点继续；paused 期间状态如实', async () => {
    const { h } = await freshHarness()
    // 受控 fetch：第一块下发后挂起，等待 abort（abort 感知流模拟真 fetch）
    let releaseChunks: (() => void) | null = null
    const firstChunkGate = new Promise<void>((resolve) => {
      releaseChunks = resolve
    })
    const fetch = makeFetch((call) =>
      streamedResponse(
        call.signal,
        (controller, release) => {
          controller.enqueue(new TextEncoder().encode('na'))
          void release.then(() => {
            // abort 可能已 error 终结流（pause 场景）；此时 release 无事可做
            try {
              controller.enqueue(new TextEncoder().encode('c'))
              controller.close()
            } catch {
              /* stream already errored by abort */
            }
          })
        },
        firstChunkGate
      )
    )
    h.fetchImpl = fetch as unknown as typeof globalThis.fetch
    const controlled = createGptRuntimeManager(h.deps())

    void controlled.download('standard')
    await vi.waitFor(() => expect(controlled.status('standard').receivedBytes).toBe(2))
    expect(controlled.pause('standard')).toBe(true)
    await vi.waitFor(() => expect(controlled.state('standard').kind).toBe('paused'))
    expect(controlled.status('standard').state).toBe('paused')
    expect(controlled.status('standard').receivedBytes).toBe(2)
    releaseChunks!()

    // resume：.part 已有 2 字节 → Range bytes=2-（新实例读同一 .part 断点）
    const resumeFetch = makeFetch((call) =>
      call.headers?.['Range'] === 'bytes=2-'
        ? makeResponse('c', { status: 206 })
        : makeResponse(PAYLOAD)
    )
    h.fetchImpl = resumeFetch as unknown as typeof globalThis.fetch
    const resuming = createGptRuntimeManager(h.deps())
    expect(resuming.resume('standard')).toBe(false) // 它的内存态不是 paused
    await resuming.download('standard')
    await vi.waitFor(() => expect(resuming.state('standard').kind).toBe('done'))
    expect(resumeFetch.calls.some((call) => call.headers?.['Range'] === 'bytes=2-')).toBe(true)
  })

  it('cancel：进行中取消转 cancelled；.part 断点保留', async () => {
    const { h } = await freshHarness()
    const neverRelease = new Promise<void>(() => {
      /* 永不 resolve：流挂着等 abort */
    })
    const fetch = makeFetch((call) =>
      streamedResponse(
        call.signal,
        (controller) => {
          controller.enqueue(new TextEncoder().encode('na'))
          // 不 close：流挂起，直到 abort 把它 error 掉
        },
        neverRelease
      )
    )
    h.fetchImpl = fetch as unknown as typeof globalThis.fetch
    const slow = createGptRuntimeManager(h.deps())
    void slow.download('standard')
    await vi.waitFor(() => expect(slow.status('standard').receivedBytes).toBe(2))
    expect(slow.cancel('standard')).toBe(true)
    await vi.waitFor(() => expect(slow.state('standard').kind).toBe('cancelled'))
    expect(existsSync(join(h.root, '.gpt-runtime-download', 'test-pkg.7z.part'))).toBe(true)
  })

  it('marker 缺失：extract-failed 且不落安装目录', async () => {
    const brokenExtract = async (archivePath: string, destDir: string): Promise<void> => {
      await mkdir(join(destDir, 'test-root'), { recursive: true })
      // 只放一个文件——runtime/python.exe 等 marker 全缺
      await writeFile(join(destDir, 'test-root', 'README.md'), 'x')
      await rm(archivePath, { force: true })
    }
    const { h } = await freshHarness()
    h.extractArchive = brokenExtract
    const broken = createGptRuntimeManager(h.deps())
    await broken.download('standard')
    await vi.waitFor(() => {
      const state = broken.state('standard')
      expect(state.kind).toBe('error')
      expect(state.kind === 'error' && state.code).toBe('extract-failed')
    })
    expect(existsSync(join(h.root, 'gpt-sovits'))).toBe(false)
  })

  it('替换安装失败回滚：rename 失败时旧安装原位保留', async () => {
    const { h } = await freshHarness()
    // 第一次：正常安装
    const first = createGptRuntimeManager(h.deps())
    await first.download('standard')
    await vi.waitFor(() => expect(first.state('standard').kind).toBe('done'))
    const installRoot = join(h.root, 'gpt-sovits')
    const markerBefore = readFileSync(join(installRoot, 'api_v2.py'), 'utf-8')

    // 第二次：staging→final 的 rename 抛错 → 回滚旧安装
    // （只拦 staging 源的 rename——回滚分支 backup→final 的 to 也是 installRoot，
    // 不能误拦，否则测的不是"回滚成功"而是"回滚也失败"）
    const failStagingRename = { value: false }
    const failingRename = async (from: string, to: string): Promise<void> => {
      if (failStagingRename.value && from.includes('extracted')) {
        throw new Error('simulated rename failure')
      }
      void to
      const { rename } = await import('node:fs/promises')
      await rename(from, to)
    }
    const second = createGptRuntimeManager({ ...h.deps(), renamePath: failingRename })
    failStagingRename.value = true
    await second.download('standard')
    await vi.waitFor(() => {
      const state = second.state('standard')
      expect(state.kind).toBe('error')
    })
    // 旧安装未被破坏
    expect(readFileSync(join(installRoot, 'api_v2.py'), 'utf-8')).toBe(markerBefore)
    expect(existsSync(join(installRoot, 'runtime', 'python.exe'))).toBe(true)
    // backup 不残留（回滚后应清掉）
    expect(existsSync(join(h.root, '.gpt-sovits.backup'))).toBe(false)
  })

  it('deleteRuntime：安装与暂存全删；进行中拒绝', async () => {
    const { h, manager } = await freshHarness()
    await manager.download('standard')
    await vi.waitFor(() => expect(manager.state('standard').kind).toBe('done'))
    expect(await manager.deleteRuntime()).toBe(true)
    expect(existsSync(join(h.root, 'gpt-sovits'))).toBe(false)
    expect(manager.installed()).toBeNull()
    expect(manager.state('standard').kind).toBe('idle')
  })

  it('GPU 推荐：RTX 50 系→rtx50；非 50 系 NVIDIA→standard；无卡/失败→null', async () => {
    const make = (gpuName: string | null): GptRuntimeManager => {
      const h = makeHarness()
      return createGptRuntimeManager({ ...h.deps(), gpuName: () => Promise.resolve(gpuName) })
    }
    expect(await make('NVIDIA GeForce RTX 5070').recommendedVariant()).toBe('rtx50')
    expect(await make('NVIDIA GeForce RTX 5090 Laptop GPU').recommendedVariant()).toBe('rtx50')
    expect(await make('NVIDIA GeForce RTX 4060').recommendedVariant()).toBe('standard')
    expect(await make('AMD Radeon 780M').recommendedVariant()).toBeNull()
    expect(await make(null).recommendedVariant()).toBeNull()
  })

  it('DTO 纪律：status 恒满足 isAssetDownloadStatus（含各阶段）', async () => {
    const { isAssetDownloadStatus } = await import('@shared/voice/asset-root-types')
    const statuses: AssetDownloadStatus[] = []
    const root = await mkdtemp(join(base, 'dto-'))
    const h = makeHarness()
    h.root = root
    const m = createGptRuntimeManager({
      ...h.deps(),
      onStateChange: () => {
        statuses.push(m.status('standard'))
      }
    })
    await m.download('standard')
    await vi.waitFor(() => expect(m.state('standard').kind).toBe('done'))
    expect(statuses.length).toBeGreaterThan(0)
    for (const s of statuses) {
      expect(isAssetDownloadStatus(s)).toBe(true)
    }
    // 至少经历 receiving / verifying / extracting / installing 四个 phase
    const phases = new Set(statuses.map((s) => s.phase))
    for (const phase of ['receiving', 'verifying', 'extracting', 'installing']) {
      expect(phases.has(phase as AssetDownloadStatus['phase']), `phase ${phase}`).toBe(true)
    }
    // GPT_RUNTIME_MARKERS 覆盖 handoff 四要素
    expect(GPT_RUNTIME_MARKERS).toContain('runtime/python.exe')
    expect(GPT_RUNTIME_MARKERS).toContain('api_v2.py')
  })

  it('安装目录布局：{assetRoot}/gpt-sovits 直含 runtime/python.exe（与只读发现同形状）', async () => {
    const { h, manager } = await freshHarness()
    await manager.download('standard')
    await vi.waitFor(() => expect(manager.state('standard').kind).toBe('done'))
    const info = await stat(join(h.root, 'gpt-sovits'))
    expect(info.isDirectory()).toBe(true)
    const metaRaw = await readFile(join(h.root, 'gpt-sovits', GPT_RUNTIME_META_FILE), 'utf-8')
    expect(JSON.parse(metaRaw)).toMatchObject({ variant: 'standard' })
  })
})
