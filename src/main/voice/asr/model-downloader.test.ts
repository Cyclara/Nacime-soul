// src/main/voice/asr/model-downloader.test.ts
// P3B-14：下载器合同——流式进度/可中止/解压/校验/原子落盘。
// 假 fetch（可 abort 的 body 流）+ 假解压器 + 真实临时目录；真 manifest 校验用
// 真 model-store（集成点：下载产物必须被 discover/validate 认账）。

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createModelDownloader, type ModelDownloadState } from './model-downloader'
import { createAsrFileSetStore, createAsrModelStore } from './model-store'
import type { AsrDownloadFile } from './download-catalog'

/**
 * 假 fetch：分批推送；chunks 推完后——未设 hangAfterPushes 则关流（正常完成）；
 * 设了则在推满指定块数后挂起，等 init.signal abort（模拟长下载被 downloader
 * 的 AbortController 中断）。
 */
function makeFakeFetch(opts: {
  status?: number
  bytes?: Uint8Array
  chunks?: Uint8Array[]
  hangAfterPushes?: number
  contentLength?: number
}): { fetchImpl: typeof globalThis.fetch; pushedBytes: () => number } {
  const chunks = [...(opts.chunks ?? [opts.bytes ?? new Uint8Array(0)])]
  const contentLength =
    opts.contentLength ?? opts.bytes?.byteLength ?? chunks.reduce((s, c) => s + c.byteLength, 0)
  let pushed = 0
  let pushes = 0
  const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
    const signal = init?.signal
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (chunks.length > 0) {
          const chunk = chunks.shift()!
          pushed += chunk.byteLength
          pushes++
          controller.enqueue(chunk)
          return
        }
        if (opts.hangAfterPushes !== undefined && pushes <= opts.hangAfterPushes) {
          // 预检已中止的 signal（真 fetch 在已中止 signal 下会立即拒绝；本 fake
          // 必须同样处理——abort 早于本次挂起时 listener 不会触发）
          if (signal?.aborted === true) {
            controller.error(new Error('aborted'))
            return
          }
          await new Promise<never>((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), {
              once: true
            })
          })
          return
        }
        controller.close()
      }
    })
    return new Response(stream, {
      status: opts.status ?? 200,
      headers: { 'content-length': String(contentLength) }
    })
  }
  return { fetchImpl, pushedBytes: () => pushed }
}

/** 假解压器：在 destDir 下生成两文件（模拟官方归档内布局）。 */
function makeExtractor(): {
  extract: (archivePath: string, destDir: string) => Promise<void>
} {
  return {
    extract: async (_archivePath, destDir) => {
      const inner = join(destDir, 'model-dir')
      await mkdir(inner, { recursive: true })
      await writeFile(join(inner, 'model.int8.onnx'), 'FAKE-ONNX-MODEL')
      await writeFile(join(inner, 'tokens.txt'), 'a b c')
    }
  }
}

function makeDownloader(
  rootDir: string,
  overrides?: {
    status?: number
    bytes?: Uint8Array
    chunks?: Uint8Array[]
    hangAfterPushes?: number
    extractor?: (a: string, d: string) => Promise<void>
  }
): {
  downloader: ReturnType<typeof createModelDownloader>
  fetch: { fetchImpl: typeof globalThis.fetch; pushedBytes: () => number }
  extractor: { extract: (archivePath: string, destDir: string) => Promise<void> }
  states: Array<{ target: string; state: ModelDownloadState }>
} {
  const fetch = makeFakeFetch(overrides ?? {})
  const extractor = makeExtractor()
  const states: Array<{ target: string; state: ModelDownloadState }> = []
  const downloader = createModelDownloader({
    rootDir,
    fetchImpl: fetch.fetchImpl,
    extractArchive: overrides?.extractor ?? extractor.extract,
    engineDirName: (id) => (id === 'sherpa-sensevoice' ? 'sense-voice' : 'paraformer'),
    onStateChange: (target, state) => states.push({ target, state }),
    progressThrottleMs: 0
  })
  return { downloader, fetch, extractor, states }
}

const SENSE_BYTES = 163_002_883
const PARAFORMER_BYTES = 234_051_698

describe('P3B-14 model-downloader：引擎归档全流程', () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dl-engine-'))
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('下载→解压→manifest→原子落位；产物被 model-store discover/validate 认账', async () => {
    const big = new Uint8Array(SENSE_BYTES)
    big.fill(7)
    const h = makeDownloader(root, { chunks: [big.subarray(0, 100_000), big.subarray(100_000)] })
    await expect(h.downloader.download('sherpa-sensevoice')).resolves.toBeUndefined()

    expect(h.downloader.state('sherpa-sensevoice').kind).toBe('done')
    const progresses = h.states.filter(
      (s) => s.target === 'sherpa-sensevoice' && s.state.kind === 'downloading'
    )
    expect(progresses.length).toBeGreaterThan(1)

    // 落盘路径与 model-store 约定一致，且 manifest 校验通过
    const store = createAsrModelStore(root)
    const files = store.discover()
    expect(files).not.toBeNull()
    await expect(store.validate(files!)).resolves.toBeUndefined()
    const manifest = JSON.parse(
      await readFile(join(root, 'sense-voice/manifest.json'), 'utf-8')
    ) as { files: Record<string, { bytes: number; sha256: string }> }
    expect(manifest.files['model.onnx']!.bytes).toBe('FAKE-ONNX-MODEL'.length)
  })

  it('体积与钉死差异 >5% → model-corrupt，不落正式目录', async () => {
    const h = makeDownloader(root, { bytes: new Uint8Array(1_000) })
    await expect(h.downloader.download('funasr-paraformer')).rejects.toThrow()
    expect(h.downloader.state('funasr-paraformer')).toMatchObject({
      kind: 'error',
      code: 'model-corrupt'
    })
    await expect(stat(join(root, 'paraformer'))).rejects.toThrow()
  })

  it('HTTP 404 → model-download-failed', async () => {
    const h = makeDownloader(root, { status: 404 })
    await expect(h.downloader.download('sherpa-sensevoice')).rejects.toThrow()
    expect(h.downloader.state('sherpa-sensevoice')).toMatchObject({
      kind: 'error',
      code: 'model-download-failed'
    })
  })

  it('解压缺 model/tokens → model-corrupt', async () => {
    const h = makeDownloader(root, {
      bytes: new Uint8Array(SENSE_BYTES),
      extractor: async (_a, destDir) => {
        await mkdir(destDir, { recursive: true })
        await writeFile(join(destDir, 'irrelevant.txt'), 'x')
      }
    })
    await expect(h.downloader.download('sherpa-sensevoice')).rejects.toThrow()
    expect(h.downloader.state('sherpa-sensevoice')).toMatchObject({
      kind: 'error',
      code: 'model-corrupt'
    })
  })

  it('归档模型不可暂停；busy 拒绝重复下载，cancel 后收尾 cancelled', async () => {
    const h = makeDownloader(root, { bytes: new Uint8Array(SENSE_BYTES), hangAfterPushes: 1 })
    const first = h.downloader.download('sherpa-sensevoice')
    await expect(h.downloader.download('sherpa-sensevoice')).rejects.toThrow(/already active/)
    // 等下载真的开始（进入 downloading 态）再取消
    await vi.waitFor(() => {
      expect(h.downloader.isActive('sherpa-sensevoice')).toBe(true)
    })
    expect(h.downloader.status('sherpa-sensevoice')).toMatchObject({
      state: 'downloading',
      currentFile: expect.stringContaining('sense-voice'),
      totalBytes: SENSE_BYTES,
      phase: 'receiving',
      resumable: false
    })
    expect(h.downloader.pause('sherpa-sensevoice')).toBe(false)
    expect(h.downloader.cancel('sherpa-sensevoice')).toBe(true)
    await expect(first).resolves.toBeUndefined()
    expect(h.downloader.state('sherpa-sensevoice').kind).toBe('cancelled')
  })
})

function shaBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function tinyFile(name: string, bytes: Uint8Array, suffix = ''): AsrDownloadFile {
  return {
    name,
    url: `https://models.example/${name}${suffix}`,
    bytes: bytes.byteLength,
    sha256: shaBytes(bytes)
  }
}

function responseOf(bytes: Uint8Array, status = 200): Response {
  return new Response(Buffer.from(bytes), {
    status,
    headers: { 'content-length': String(bytes.byteLength) }
  })
}

describe('P3V-04 model-downloader：多文件续传与安全安装', () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dl-files-'))
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('已有 .part 发 Range；206 只追加剩余字节并完成校验安装', async () => {
    const encoder = new Uint8Array([1, 2, 3, 4])
    const tokens = new Uint8Array([9, 8])
    const files = [tinyFile('encoder.onnx', encoder), tinyFile('tokens.txt', tokens)]
    const staging = join(root, '.partial/tiny')
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'encoder.onnx.part'), encoder.subarray(0, 2))
    const requests: Array<{ url: string; range: string | null }> = []
    const fetchImpl: typeof globalThis.fetch = async (input, init) => {
      const url = String(input)
      const range = new Headers(init?.headers).get('range')
      requests.push({ url, range })
      if (url.endsWith('encoder.onnx')) return responseOf(encoder.subarray(2), 206)
      return responseOf(tokens)
    }
    const downloader = createModelDownloader({
      rootDir: root,
      fetchImpl,
      extractArchive: async () => {},
      engineDirName: () => 'tiny',
      resolveFileSource: () => ({ kind: 'files', files }),
      progressThrottleMs: 0
    })
    await downloader.download('zipformer-bilingual-zh-en')

    expect(requests[0]).toEqual({
      url: 'https://models.example/encoder.onnx',
      range: 'bytes=2-'
    })
    expect(await readFile(join(root, 'tiny/encoder.onnx'))).toEqual(Buffer.from(encoder))
    const store = createAsrFileSetStore(root, {
      dirName: 'tiny',
      files: files.map((file) => file.name)
    })
    await expect(store.validate(store.discover()!)).resolves.toBeUndefined()
  })

  it('多文件下载可暂停并保留 .part；继续发 Range 后完成真实校验安装', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5])
    const file = tinyFile('pausable.onnx', bytes)
    let requestCount = 0
    const ranges: Array<string | null> = []
    const downloader = createModelDownloader({
      rootDir: root,
      fetchImpl: async (_input, init) => {
        requestCount++
        const signal = init?.signal
        ranges.push(new Headers(init?.headers).get('range'))
        if (requestCount === 1) {
          let pushed = false
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (!pushed) {
                pushed = true
                controller.enqueue(bytes.subarray(0, 2))
                return
              }
              if (signal?.aborted === true) {
                controller.error(new DOMException('paused', 'AbortError'))
                return
              }
              await new Promise<never>((_resolve, reject) => {
                signal?.addEventListener(
                  'abort',
                  () => reject(new DOMException('paused', 'AbortError')),
                  { once: true }
                )
              })
            }
          })
          return new Response(stream, {
            status: 200,
            headers: { 'content-length': String(bytes.byteLength) }
          })
        }
        return responseOf(bytes.subarray(2), 206)
      },
      extractArchive: async () => {},
      engineDirName: () => 'pausable',
      resolveFileSource: () => ({ kind: 'files', files: [file] }),
      progressThrottleMs: 0
    })

    const first = downloader.download('zipformer-bilingual-zh-en')
    await vi.waitFor(() => {
      expect(downloader.status('zipformer-bilingual-zh-en')).toMatchObject({
        state: 'downloading',
        receivedBytes: 2,
        totalBytes: 5,
        currentFile: 'pausable.onnx',
        phase: 'receiving',
        resumable: true
      })
    })
    expect(downloader.pause('zipformer-bilingual-zh-en')).toBe(true)
    await expect(first).resolves.toBeUndefined()
    expect(downloader.state('zipformer-bilingual-zh-en')).toEqual({
      kind: 'paused',
      progress: 0.4
    })
    expect(downloader.status('zipformer-bilingual-zh-en')).toMatchObject({
      state: 'paused',
      receivedBytes: 2,
      totalBytes: 5,
      currentFile: 'pausable.onnx',
      speedBytesPerSec: 0,
      resumable: true
    })
    expect((await stat(join(root, '.partial/pausable/pausable.onnx.part'))).size).toBe(2)

    expect(downloader.resume('zipformer-bilingual-zh-en')).toBe(true)
    await vi.waitFor(() => expect(downloader.state('zipformer-bilingual-zh-en').kind).toBe('done'))
    expect(ranges).toEqual([null, 'bytes=2-'])
    expect(await readFile(join(root, 'pausable/pausable.onnx'))).toEqual(Buffer.from(bytes))
    expect(downloader.status('zipformer-bilingual-zh-en')).toMatchObject({
      state: 'done',
      receivedBytes: 5,
      totalBytes: 5,
      resumable: true
    })
  })

  it('服务端忽略 Range 返回 200 时覆盖旧片段，不把完整响应追加两遍', async () => {
    const bytes = new Uint8Array([5, 6, 7, 8])
    const file = tinyFile('model.onnx', bytes)
    const staging = join(root, '.partial/no-range')
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'model.onnx.part'), bytes.subarray(0, 2))
    let range: string | null = null
    const downloader = createModelDownloader({
      rootDir: root,
      fetchImpl: async (_input, init) => {
        range = new Headers(init?.headers).get('range')
        return responseOf(bytes, 200)
      },
      extractArchive: async () => {},
      engineDirName: () => 'no-range',
      resolveFileSource: () => ({ kind: 'files', files: [file] }),
      progressThrottleMs: 0
    })
    await downloader.download('zipformer-bilingual-zh-en')
    expect(range).toBe('bytes=2-')
    expect((await readFile(join(root, 'no-range/model.onnx'))).byteLength).toBe(4)
  })

  it('后续文件失败后保留已校验文件；重试复用它而不再发网络请求', async () => {
    const first = new Uint8Array([1, 1, 1])
    const second = new Uint8Array([2, 2])
    const files = [tinyFile('first.onnx', first), tinyFile('second.onnx', second)]
    let firstRequests = 0
    let secondRequests = 0
    const failing = createModelDownloader({
      rootDir: root,
      fetchImpl: async (input) => {
        if (String(input).endsWith('first.onnx')) {
          firstRequests++
          return responseOf(first)
        }
        secondRequests++
        return new Response(null, { status: 500 })
      },
      extractArchive: async () => {},
      engineDirName: () => 'reuse',
      resolveFileSource: () => ({ kind: 'files', files }),
      progressThrottleMs: 0
    })
    await expect(failing.download('zipformer-bilingual-zh-en')).rejects.toThrow()
    expect(await readFile(join(root, '.partial/reuse/first.onnx'))).toEqual(Buffer.from(first))

    const retry = createModelDownloader({
      rootDir: root,
      fetchImpl: async (input) => {
        if (String(input).endsWith('first.onnx')) {
          firstRequests++
          throw new Error('completed file must not be fetched again')
        }
        secondRequests++
        return responseOf(second)
      },
      extractArchive: async () => {},
      engineDirName: () => 'reuse',
      resolveFileSource: () => ({ kind: 'files', files }),
      progressThrottleMs: 0
    })
    await retry.download('zipformer-bilingual-zh-en')
    expect(firstRequests).toBe(1)
    expect(secondRequests).toBe(2)
    expect(await readFile(join(root, 'reuse/first.onnx'))).toEqual(Buffer.from(first))
  })

  it('sha256 不匹配删除坏 .part，正式目录不出现', async () => {
    const good = new Uint8Array([1, 2, 3])
    const bad = new Uint8Array([3, 2, 1])
    const file = tinyFile('bad.onnx', good)
    const downloader = createModelDownloader({
      rootDir: root,
      fetchImpl: async () => responseOf(bad),
      extractArchive: async () => {},
      engineDirName: () => 'bad-hash',
      resolveFileSource: () => ({ kind: 'files', files: [file] }),
      progressThrottleMs: 0
    })
    await expect(downloader.download('zipformer-bilingual-zh-en')).rejects.toThrow(/sha256/)
    expect(downloader.state('zipformer-bilingual-zh-en')).toMatchObject({
      kind: 'error',
      code: 'model-corrupt'
    })
    await expect(stat(join(root, '.partial/bad-hash/bad.onnx.part'))).rejects.toThrow()
    await expect(stat(join(root, 'bad-hash'))).rejects.toThrow()
  })

  it('上次崩溃留下 backup 且 final 缺失时先恢复，不删除唯一旧安装', async () => {
    const backup = join(root, '.crash-recovery.backup')
    await mkdir(backup, { recursive: true })
    await writeFile(join(backup, 'old.marker'), 'survives-crash')
    const bytes = new Uint8Array([4, 4])
    const file = tinyFile('new.onnx', bytes)
    let calls = 0
    const downloader = createModelDownloader({
      rootDir: root,
      fetchImpl: async () => responseOf(bytes),
      extractArchive: async () => {},
      engineDirName: () => 'crash-recovery',
      resolveFileSource: () => ({ kind: 'files', files: [file] }),
      renamePath: async (from, to) => {
        calls++
        // 1: 恢复 backup→final；2: final→backup；3: staging→final（模拟再次失败）；
        // 4: backup→final 回滚。
        if (calls === 3) throw new Error('new install failed after crash recovery')
        await rename(from, to)
      },
      progressThrottleMs: 0
    })
    await expect(downloader.download('zipformer-bilingual-zh-en')).rejects.toThrow(
      /new install failed after crash recovery/
    )
    expect(await readFile(join(root, 'crash-recovery/old.marker'), 'utf-8')).toBe('survives-crash')
    await expect(stat(backup)).rejects.toThrow()
  })

  it('替换旧安装的第二次 rename 失败时回滚旧目录，不留下备份悬挂', async () => {
    const oldDir = join(root, 'rollback')
    await mkdir(oldDir, { recursive: true })
    await writeFile(join(oldDir, 'old.marker'), 'still-usable')
    const bytes = new Uint8Array([7, 7])
    const file = tinyFile('new.onnx', bytes)
    let calls = 0
    const downloader = createModelDownloader({
      rootDir: root,
      fetchImpl: async () => responseOf(bytes),
      extractArchive: async () => {},
      engineDirName: () => 'rollback',
      resolveFileSource: () => ({ kind: 'files', files: [file] }),
      renamePath: async (from, to) => {
        calls++
        if (calls === 2) throw new Error('simulated install rename failure')
        await rename(from, to)
      },
      progressThrottleMs: 0
    })
    await expect(downloader.download('zipformer-bilingual-zh-en')).rejects.toThrow(
      /simulated install rename failure/
    )
    expect(await readFile(join(oldDir, 'old.marker'), 'utf-8')).toBe('still-usable')
    await expect(stat(join(root, '.rollback.backup'))).rejects.toThrow()
  })

  it('P3V-13 deleteModel 删除正式目录 + 本引擎断点/事务目录，不碰其他模型', async () => {
    const dirName = 'delete-me'
    await mkdir(join(root, dirName), { recursive: true })
    await writeFile(join(root, dirName, 'model.onnx'), 'installed')
    await mkdir(join(root, '.partial', dirName), { recursive: true })
    await writeFile(join(root, '.partial', dirName, 'model.onnx.part'), 'partial')
    await mkdir(join(root, `.${dirName}.installing`), { recursive: true })
    await mkdir(join(root, `.${dirName}.backup`), { recursive: true })
    await mkdir(join(root, '.partial', 'other-model'), { recursive: true })
    await writeFile(join(root, '.partial', 'other-model', 'keep.part'), 'keep')
    const downloader = createModelDownloader({
      rootDir: root,
      fetchImpl: async () => responseOf(new Uint8Array([1])),
      extractArchive: async () => {},
      engineDirName: () => dirName,
      resolveFileSource: () => ({ kind: 'files', files: [] })
    })

    expect(await downloader.deleteModel('zipformer-bilingual-zh-en')).toBe(true)
    await expect(stat(join(root, dirName))).rejects.toThrow()
    await expect(stat(join(root, '.partial', dirName))).rejects.toThrow()
    await expect(stat(join(root, `.${dirName}.installing`))).rejects.toThrow()
    await expect(stat(join(root, `.${dirName}.backup`))).rejects.toThrow()
    expect(await readFile(join(root, '.partial', 'other-model', 'keep.part'), 'utf-8')).toBe('keep')
    expect(downloader.state('zipformer-bilingual-zh-en')).toEqual({ kind: 'idle' })
  })

  it('P3V-13 deleteModel 在下载 active 时拒绝，不删现有目录', async () => {
    const dirName = 'busy-model'
    await mkdir(join(root, dirName), { recursive: true })
    await writeFile(join(root, dirName, 'keep.onnx'), 'keep')
    const bytes = new Uint8Array([1])
    const downloader = createModelDownloader({
      rootDir: root,
      fetchImpl: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (signal?.aborted === true) {
            reject(new DOMException('cancelled', 'AbortError'))
            return
          }
          signal?.addEventListener('abort', () => {
            reject(new DOMException('cancelled', 'AbortError'))
          })
        }),
      extractArchive: async () => {},
      engineDirName: () => dirName,
      resolveFileSource: () => ({ kind: 'files', files: [tinyFile('new.onnx', bytes)] })
    })
    const active = downloader.download('zipformer-bilingual-zh-en')
    await vi.waitFor(() => expect(downloader.isActive('zipformer-bilingual-zh-en')).toBe(true))
    expect(await downloader.deleteModel('zipformer-bilingual-zh-en')).toBe(false)
    expect(await readFile(join(root, dirName, 'keep.onnx'), 'utf-8')).toBe('keep')
    downloader.cancel('zipformer-bilingual-zh-en')
    await expect(active).resolves.toBeUndefined()
    expect(downloader.state('zipformer-bilingual-zh-en')).toEqual({ kind: 'cancelled' })
  })
})

describe('P3B-14 model-downloader：VAD 单文件', () => {
  let root: string
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dl-vad-'))
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('下载 VAD 到 {root}/vad/silero_vad.onnx + manifest；取消后不落盘', async () => {
    const bytes = new Uint8Array(643_854)
    bytes.fill(1)
    const h = makeDownloader(root, { bytes })
    await expect(h.downloader.download('vad')).resolves.toBeUndefined()
    expect(h.downloader.state('vad').kind).toBe('done')
    const manifest = JSON.parse(await readFile(join(root, 'vad/manifest.json'), 'utf-8')) as {
      files: Record<string, { bytes: number }>
    }
    expect(manifest.files['silero_vad.onnx']!.bytes).toBe(643_854)
    const content = await readFile(join(root, 'vad/silero_vad.onnx'))
    expect(content.byteLength).toBe(643_854)

    // 取消路径
    const h2 = makeDownloader(root, { bytes: new Uint8Array(PARAFORMER_BYTES), hangAfterPushes: 1 })
    const p = h2.downloader.download('funasr-paraformer')
    await vi.waitFor(() => {
      expect(h2.downloader.isActive('funasr-paraformer')).toBe(true)
    })
    expect(h2.downloader.cancel('funasr-paraformer')).toBe(true)
    await expect(p).resolves.toBeUndefined()
    expect(h2.downloader.state('funasr-paraformer').kind).toBe('cancelled')
  })

  it('无进行中下载 cancel 返回 false', async () => {
    const h = makeDownloader(root, { bytes: new Uint8Array(PARAFORMER_BYTES) })
    expect(h.downloader.cancel('sherpa-sensevoice')).toBe(false)
  })
})
