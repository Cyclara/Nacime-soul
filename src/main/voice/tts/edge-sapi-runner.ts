// src/main/voice/tts/edge-sapi-runner.ts
// P3B-03：Edge 占位 provider 的真实合成执行层——spawn Windows PowerShell + System.Speech (SAPI)。
//
// 安全设计（这是 src/main 第一次引入子进程 spawn，给 P3B-04 GPT-SoVITS 打样）：
//   - 用户文本**永不进命令行**：写到 UTF-8(BOM) 临时文件，PS 用 ReadAllText 读回。
//   - 命令经 -EncodedCommand（base64 UTF-16LE）传递，单引号字面量只承载我们生成的
//     uuid 路径与白名单化的 voice 名，无拼接注入面。
//   - windowsHide: true；-NoProfile -NonInteractive；30s 硬超时；AbortSignal 即杀进程。
//   - 临时目录 finally 递归清理，不留孤儿 wav/txt。
//
// 该文件只做进程编排；WAV 解码/重采样在 edge-provider.ts（经 decodeWavToMonoF32）。

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppError } from '@shared/errors'
import { sanitizeSapiVoiceName, type EdgeSapiSynthesisInput } from './edge-provider'

export const EDGE_SAPI_TIMEOUT_MS = 30_000

/**
 * 构造 PowerShell 脚本并编码为 -EncodedCommand 参数。纯函数，可单测。
 * 返回值是 base64(utf16le)；用户文本只在 textPath 文件里，不进脚本。
 */
export function buildSapiEncodedCommand(input: {
  readonly wavPath: string
  readonly textPath: string
  readonly voice: string | null
  readonly rate: number
}): string {
  const lines = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    // voice 名已过白名单（无引号/反斜杠），SelectVoice 失败回退默认 voice（占位语义）
    input.voice !== null ? `try { $s.SelectVoice('${input.voice}') } catch { }` : '',
    `$s.Rate = ${input.rate}`,
    `$s.SetOutputToWaveFile('${input.wavPath}')`,
    `$t = [System.IO.File]::ReadAllText('${input.textPath}', [System.Text.Encoding]::UTF8)`,
    '$s.Speak($t)',
    '$s.Dispose()',
    'exit 0'
  ]
  const script = lines.filter((line) => line.length > 0).join('\n')
  return Buffer.from(script, 'utf16le').toString('base64')
}

function abortError(): Error {
  const err = new Error('edge tts runner aborted')
  err.name = 'AbortError'
  return err
}

/** 真实执行：spawn powershell -> 等 close -> 读 WAV -> 清理临时目录。 */
export async function runEdgeSapiSynthesis(input: EdgeSapiSynthesisInput): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), 'nacime-tts-'))
  const id = randomUUID()
  const textPath = join(dir, `${id}.txt`)
  const wavPath = join(dir, `${id}.wav`)
  try {
    // BOM 前缀：[System.Text.Encoding]::UTF8 显式读取 + BOM 双保险，中文文本不串码
    await writeFile(textPath, '\uFEFF' + input.text, 'utf8')

    const encoded = buildSapiEncodedCommand({
      wavPath,
      textPath,
      voice: sanitizeSapiVoiceName(input.voice),
      rate: input.rate
    })
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: EDGE_SAPI_TIMEOUT_MS, signal: input.signal }
    )
    const stderrTail: Buffer[] = []
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrTail.length < 8) stderrTail.push(chunk)
    })

    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', () => resolve())
    })

    if (input.signal.aborted) throw abortError()
    if (child.exitCode === null) {
      // 被超时 kill（Windows TerminateProcess -> exitCode null）；abort 分支已在上面拦截
      throw new AppError({
        code: 'TTS_TIMEOUT',
        userMessage: '语音合成超时，本轮改为纯文字。',
        severity: 'error',
        retryable: true,
        cause: new Error(`edge sapi exceeded ${EDGE_SAPI_TIMEOUT_MS}ms`)
      })
    }
    if (child.exitCode !== 0) {
      const stderr = Buffer.concat(stderrTail).toString('utf8').slice(-512)
      throw new AppError({
        code: 'TTS_ENGINE_DOWN',
        userMessage: '语音合成失败，本轮改为纯文字。',
        severity: 'error',
        retryable: true,
        cause: new Error(`powershell exit ${child.exitCode}${stderr ? `: ${stderr}` : ''}`)
      })
    }

    const wav = await readFile(wavPath)
    if (wav.length === 0) {
      throw new AppError({
        code: 'TTS_ENGINE_DOWN',
        userMessage: '语音合成失败，本轮改为纯文字。',
        severity: 'error',
        retryable: true,
        cause: new Error('edge sapi produced empty wav')
      })
    }
    return wav
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      /* best-effort 清理：临时目录失败不影响结果，系统重启自清 */
    })
  }
}
