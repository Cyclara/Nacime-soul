// src/main/voice/vad/silero-vad-binding.test.ts
// P3B-12：生产绑定的原生件冒烟（无模型文件；本测试跑在 ELECTRON_RUN_AS_NODE
// 运行时 = sherpa-onnx N-API 免 rebuild 的直接证据，与 P3B-10 同纪律）。
//
// 坏路径行为（实测，见 silero-binding.ts 头注释）：原生对缺失路径静默返回
// nullptr handle（不抛错），绑定层用 statSync 预检兜住——这里验证的就是预检。
// 损坏文件会原生崩溃进程，不可测也不可 catch（残余风险由 P3B-14 下载器
// sha256 校验消除）；真模型逐窗识别验证归 P3B-14 测试录音 / P3B-20 E2E。

import { describe, expect, it } from 'vitest'
import { createNodeSileroVadBinding } from './silero-binding'

describe('P3B-12 createNodeSileroVadBinding（真原生件 + 预检）', () => {
  it('模型路径缺失：预检抛确定性错误（原生会静默返回空 handle）', () => {
    const binding = createNodeSileroVadBinding()
    expect(() =>
      binding.createVad({ modelPath: 'Z:/definitely/not/there/silero_vad.onnx' })
    ).toThrow(/not found/)
  })

  it('模型路径存在但为空文件：预检拒绝', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = await mkdtemp(join(tmpdir(), 'vad-binding-'))
    try {
      const empty = join(dir, 'silero_vad.onnx')
      await writeFile(empty, '')
      const binding = createNodeSileroVadBinding()
      expect(() => binding.createVad({ modelPath: empty })).toThrow(/empty/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
