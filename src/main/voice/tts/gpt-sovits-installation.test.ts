// src/main/voice/tts/gpt-sovits-installation.test.ts
// 只读发现测试：临时目录模拟整合包；不碰用户 E:\GPT-SoVITS 真文件。

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { discoverGptSovitsInstallation } from './gpt-sovits-installation'

const roots: string[] = []

function fixture(opts?: { missingRef?: boolean; missingWeights?: boolean }): string {
  const workspace = mkdtempSync(join(tmpdir(), 'nacime-gpt-sovits-'))
  roots.push(workspace)
  const root = join(workspace, 'bundle', 'app')
  mkdirSync(join(root, 'runtime'), { recursive: true })
  mkdirSync(join(root, 'GPT_SoVITS', 'configs'), { recursive: true })
  mkdirSync(join(root, 'GPT_weights_v2ProPlus'), { recursive: true })
  mkdirSync(join(root, 'SoVITS_weights_v2ProPlus'), { recursive: true })
  writeFileSync(join(root, 'runtime', process.platform === 'win32' ? 'python.exe' : 'python'), '')
  writeFileSync(join(root, 'api_v2.py'), '')
  writeFileSync(
    join(root, 'GPT_SoVITS', 'configs', 'tts_infer.yaml'),
    [
      'custom:',
      '  device: cuda',
      '  t2s_weights_path: "GPT_weights_v2ProPlus/\\u7231\\u8389\\u5E0C\\u96C52.0-e15.ckpt"',
      '  version: v2ProPlus',
      '  vits_weights_path: "SoVITS_weights_v2ProPlus/\\u7231\\u8389\\u5E0C\\u96C52.0_e8_s5864.pth"',
      'v1:',
      '  version: v1'
    ].join('\n')
  )
  if (opts?.missingWeights !== true) {
    writeFileSync(join(root, 'GPT_weights_v2ProPlus', '爱莉希雅2.0-e15.ckpt'), 'gpt')
    writeFileSync(join(root, 'SoVITS_weights_v2ProPlus', '爱莉希雅2.0_e8_s5864.pth'), 'sovits')
  }
  if (opts?.missingRef !== true) {
    const refs = join(workspace, '爱莉希雅', 'v4', 'reference_audios', '中文', 'emotions')
    mkdirSync(refs, { recursive: true })
    writeFileSync(join(refs, '【默认】由此点亮名为未来的奇迹。.wav'), 'wav')
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('GPT-SoVITS 本地整合包只读发现', () => {
  it('解析 custom 模型、中文 unicode 路径与参考音频；renderer-facing id 不含路径', () => {
    const root = fixture()
    const found = discoverGptSovitsInstallation([root], false)
    expect(found).not.toBeNull()
    expect(found).toMatchObject({
      rootDir: root,
      version: 'v2ProPlus',
      voice: {
        displayName: '爱莉希雅2.0（v2ProPlus）',
        promptText: '由此点亮名为未来的奇迹。',
        promptLang: 'zh',
        defaultTextLang: 'zh'
      }
    })
    expect(found!.voice.id).toMatch(/^gpt-sovits:[0-9a-f]{12}$/)
    expect(found!.voice.id).not.toContain(root)
    expect(found!.gptWeightsPath).toContain('爱莉希雅2.0-e15.ckpt')
    expect(found!.sovitsWeightsPath).toContain('爱莉希雅2.0_e8_s5864.pth')
    expect(found!.voice.refAudioPath).toContain('【默认】')
  })

  it('权重缺失时不注册 provider（返回 null，不伪装 ready）', () => {
    expect(discoverGptSovitsInstallation([fixture({ missingWeights: true })], false)).toBeNull()
  })

  it('参考音频缺失时返回 null（/tts 必填 ref_audio_path）', () => {
    expect(discoverGptSovitsInstallation([fixture({ missingRef: true })], false)).toBeNull()
  })
})
