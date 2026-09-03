// src/main/voice/asr/download-catalog.test.ts
// P3V-01：下载目录的自洽性护栏。
//
// 这里测的不是「代码逻辑」，而是**手抄进来的常量有没有错位**——逐文件字节数
// 与 sha256 是从上游一条条抄来的，抄错一位就会在真机下载 660MB 之后才失败。
// 所以最重要的一条断言是：逐文件之和 === shared 目录对用户承诺的下载体积。

import { describe, expect, it } from 'vitest'
import {
  ASR_ENGINE_DOWNLOAD_CATALOG,
  asrEngineDirName,
  asrEngineDownloadBytes,
  asrEngineRequiredFiles,
  isStreamingAsrEngine
} from './download-catalog'
import { ASR_MODEL_CATALOG, findAsrModelCatalogEntry } from '@shared/voice/asr-catalog'
import type { AsrEngineId } from '@shared/voice/asr-settings-types'

const ENGINE_IDS = Object.keys(ASR_ENGINE_DOWNLOAD_CATALOG) as AsrEngineId[]

describe('P3V-01 下载目录：与 shared 展示目录一致', () => {
  it('每个引擎的下载字节数 === shared 目录向用户承诺的体积', () => {
    for (const engineId of ENGINE_IDS) {
      const promised = findAsrModelCatalogEntry(engineId)?.downloadBytes
      expect(promised, `shared 目录缺少 ${engineId}`).toBeTypeOf('number')
      expect(asrEngineDownloadBytes(engineId), `${engineId} 体积不一致`).toBe(promised)
    }
  })

  it('两份目录的引擎集合完全相同（任一侧新增漏登记即失败）', () => {
    const shared = ASR_MODEL_CATALOG.map((entry) => entry.engineId).sort()
    expect([...ENGINE_IDS].sort()).toEqual(shared)
  })

  it('交接文档钉死的四个新模型体积逐一复核', () => {
    expect(asrEngineDownloadBytes('zipformer-bilingual-zh-en')).toBe(356_862_456)
    expect(asrEngineDownloadBytes('paraformer-bilingual-zh-en')).toBe(237_202_501)
    expect(asrEngineDownloadBytes('zipformer-streaming-zh-14m')).toBe(55_616_588)
    expect(asrEngineDownloadBytes('parakeet-tdt-v2')).toBe(661_190_513)
  })
})

describe('P3V-01 下载目录：完整性钉死', () => {
  it('多文件模型的每个文件都有 64 位十六进制 sha256', () => {
    for (const engineId of ENGINE_IDS) {
      const source = ASR_ENGINE_DOWNLOAD_CATALOG[engineId].source
      if (source.kind !== 'files') continue
      for (const file of source.files) {
        expect(file.sha256, `${engineId}/${file.name}`).toMatch(/^[0-9a-f]{64}$/)
        expect(file.bytes, `${engineId}/${file.name}`).toBeGreaterThan(0)
      }
    }
  })

  it('sha256 全局互不相同（同一摘要出现两次 = 复制粘贴时漏改）', () => {
    const digests: string[] = []
    for (const engineId of ENGINE_IDS) {
      const source = ASR_ENGINE_DOWNLOAD_CATALOG[engineId].source
      if (source.kind !== 'files') continue
      digests.push(...source.files.map((file) => file.sha256))
    }
    expect(new Set(digests).size).toBe(digests.length)
  })

  it('URL 钉死不可变 commit，而不是 main/分支名', () => {
    for (const engineId of ENGINE_IDS) {
      const source = ASR_ENGINE_DOWNLOAD_CATALOG[engineId].source
      if (source.kind !== 'files') continue
      for (const file of source.files) {
        const revision = /\/resolve\/([^/]+)\//.exec(file.url)?.[1]
        expect(revision, `${engineId}/${file.name} 缺 revision`).toMatch(/^[0-9a-f]{40}$/)
      }
    }
  })

  it('全部走 https，且只指向 huggingface.co / github.com', () => {
    for (const engineId of ENGINE_IDS) {
      const source = ASR_ENGINE_DOWNLOAD_CATALOG[engineId].source
      const urls =
        source.kind === 'archive' ? [source.archiveUrl] : source.files.map((file) => file.url)
      for (const url of urls) {
        const parsed = new URL(url)
        expect(parsed.protocol, url).toBe('https:')
        expect(['huggingface.co', 'github.com']).toContain(parsed.hostname)
      }
    }
  })

  it('没有任何引擎指向云识别服务（ASR 全本地红线）', () => {
    for (const engineId of ENGINE_IDS) {
      const source = ASR_ENGINE_DOWNLOAD_CATALOG[engineId].source
      const urls =
        source.kind === 'archive' ? [source.archiveUrl] : source.files.map((file) => file.url)
      for (const url of urls) {
        expect(url).not.toMatch(/openai|azure|googleapis|deepgram|assemblyai/i)
      }
    }
  })
})

describe('P3V-01 下载目录：运行时装配规格', () => {
  it('安装目录名互不相同（两个引擎共用目录会互相覆盖模型）', () => {
    const dirs = ENGINE_IDS.map(asrEngineDirName)
    expect(new Set(dirs).size).toBe(dirs.length)
  })

  it('多文件模型：运行时需要的文件都在下载清单里', () => {
    for (const engineId of ENGINE_IDS) {
      const source = ASR_ENGINE_DOWNLOAD_CATALOG[engineId].source
      if (source.kind !== 'files') continue
      const downloaded = new Set(source.files.map((file) => file.name))
      for (const required of asrEngineRequiredFiles(engineId)) {
        expect(downloaded.has(required), `${engineId} 缺下载 ${required}`).toBe(true)
      }
    }
  })

  it('zipformer 双语模型带 bpe.vocab 与 cjkchar+bpe（少一样中英混说会解错）', () => {
    const runtime = ASR_ENGINE_DOWNLOAD_CATALOG['zipformer-bilingual-zh-en'].runtime
    expect(runtime.kind).toBe('online-transducer')
    if (runtime.kind !== 'online-transducer') return
    expect(runtime.modelingUnit).toBe('cjkchar+bpe')
    expect(runtime.bpeVocabFile).toBe('bpe.vocab')
    expect(asrEngineRequiredFiles('zipformer-bilingual-zh-en')).toContain('bpe.vocab')
  })

  it('纯中文 14M 模型用 cjkchar，且不需要 bpe.vocab', () => {
    const runtime = ASR_ENGINE_DOWNLOAD_CATALOG['zipformer-streaming-zh-14m'].runtime
    expect(runtime.kind).toBe('online-transducer')
    if (runtime.kind !== 'online-transducer') return
    expect(runtime.modelingUnit).toBe('cjkchar')
    expect(runtime.bpeVocabFile).toBeUndefined()
    expect(asrEngineRequiredFiles('zipformer-streaming-zh-14m')).not.toContain('bpe.vocab')
  })

  it('streaming 标志与 runtime kind 一致（标 streaming 却配离线识别器 = 装配必崩）', () => {
    for (const engineId of ENGINE_IDS) {
      const entry = ASR_ENGINE_DOWNLOAD_CATALOG[engineId]
      const isOnlineRuntime = entry.runtime.kind.startsWith('online-')
      expect(entry.streaming, engineId).toBe(isOnlineRuntime)
      expect(isStreamingAsrEngine(engineId), engineId).toBe(isOnlineRuntime)
    }
  })

  it('三个新流式模型标 streaming，Parakeet 标离线', () => {
    expect(isStreamingAsrEngine('zipformer-bilingual-zh-en')).toBe(true)
    expect(isStreamingAsrEngine('paraformer-bilingual-zh-en')).toBe(true)
    expect(isStreamingAsrEngine('zipformer-streaming-zh-14m')).toBe(true)
    expect(isStreamingAsrEngine('parakeet-tdt-v2')).toBe(false)
    // P3B 既有两个离线引擎不受影响
    expect(isStreamingAsrEngine('sherpa-sensevoice')).toBe(false)
    expect(isStreamingAsrEngine('funasr-paraformer')).toBe(false)
  })
})
