// src/main/live2d/cubism-runtime.ts
// P3A-11：为 stage 提供受控 Cubism Core 资源 URL。资源随包，不使用不可靠 CDN。

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export const CUBISM_CORE_FILE_NAME = 'live2dcubismcore.min.js'
export const CUBISM2_FILE_NAME = 'live2d.min.js'

export function createCubismCoreUrl(coreDirectory: string): string | null {
  const path = resolve(coreDirectory, CUBISM_CORE_FILE_NAME)
  return existsSync(path) ? 'nacime-live2d://runtime/cubism-core' : null
}

export function createCubism2Url(coreDirectory: string): string | null {
  const path = resolve(coreDirectory, CUBISM2_FILE_NAME)
  return existsSync(path) ? 'nacime-live2d://runtime/cubism2' : null
}
