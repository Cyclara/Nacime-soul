// src/main/voice/asr/engine-error.ts
// P3B-10：ASR 引擎错误类--把内部异常映射到共享错误码枚举（AsrErrorCode）。
//
// 引擎接口（@shared/voice/asr-types）抛的是普通 Error；adapter 用本类携带
// asrCode，管理器（P3B-14/18）按 code 决定 UI 引导（模型缺失->下载引导等）。
// message 不进 IPC/日志正文（F5-011：错误码可进，自由文本不跨进程）。

import type { AsrErrorCode } from '@shared/voice/asr-types'

export class AsrEngineError extends Error {
  readonly asrCode: AsrErrorCode

  constructor(code: AsrErrorCode, message: string) {
    super(message)
    this.name = 'AsrEngineError'
    this.asrCode = code
  }
}
