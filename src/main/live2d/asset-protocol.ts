// src/main/live2d/asset-protocol.ts
// P3A-11：nacime-live2d:// 受控模型资源协议。
//
// stage 只能拿到这种 URL；handler 将 modelId + 相对路径交给 ModelService 再做白名单/real
// file checks。绝不把 `file:///C:/Users/...` 或用户输入路径发入 renderer。

import type { Session } from 'electron'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Live2dModelService } from './model-service'

export const LIVE2D_ASSET_SCHEME = 'nacime-live2d'

export function parseLive2dAssetRequest(url: string): { modelId: string; path: string } | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== `${LIVE2D_ASSET_SCHEME}:`) return null
    if (
      parsed.hostname === 'runtime' &&
      (parsed.pathname === '/cubism-core' || parsed.pathname === '/cubism2')
    ) {
      return { modelId: 'runtime', path: parsed.pathname.slice(1) }
    }
    if (parsed.hostname !== 'model') return null
    const [empty, encodedModelId, ...encodedPath] = parsed.pathname.split('/')
    if (empty !== '' || encodedModelId === undefined || encodedPath.length === 0) return null
    const modelId = decodeURIComponent(encodedModelId)
    const path = encodedPath.map((segment) => decodeURIComponent(segment)).join('/')
    if (modelId.length === 0 || path.length === 0 || modelId.includes('/') || path.includes('\0'))
      return null
    return { modelId, path }
  } catch {
    return null
  }
}

function assetResponse(content: Uint8Array, contentType: string): Response {
  const body = new Blob([content as BlobPart])
  return new Response(body, {
    headers: {
      'content-type': contentType,
      // stage page is file:// in production; explicit CORS is required for custom-scheme XHR,
      // while the handler itself remains confined to the allowlisted model root.
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    }
  })
}

export function createLive2dAssetProtocolHandler(options: {
  readonly service: Live2dModelService
  readonly cubismCorePath: string
  readonly cubism2Path?: string
}) {
  return async (request: Request): Promise<Response> => {
    const parsed = parseLive2dAssetRequest(request.url)
    if (parsed === null) return new Response('Not found', { status: 404 })
    if (
      parsed.modelId === 'runtime' &&
      parsed.path === 'cubism-core' &&
      existsSync(options.cubismCorePath)
    ) {
      const content = await readFile(options.cubismCorePath)
      return assetResponse(content, 'application/javascript; charset=utf-8')
    }
    if (
      parsed.modelId === 'runtime' &&
      parsed.path === 'cubism2' &&
      options.cubism2Path !== undefined &&
      existsSync(options.cubism2Path)
    ) {
      const content = await readFile(options.cubism2Path)
      return assetResponse(content, 'application/javascript; charset=utf-8')
    }
    const filePath = options.service.resolveAssetPath(parsed.modelId, parsed.path)
    if (filePath === null) return new Response('Not found', { status: 404 })
    if (
      extname(filePath).toLowerCase() === '.json' ||
      filePath.toLowerCase().endsWith('.model3.json')
    ) {
      const content = await readFile(filePath)
      return assetResponse(content, 'application/json; charset=utf-8')
    }
    const content = await readFile(filePath)
    const lower = filePath.toLowerCase()
    const contentType = lower.endsWith('.moc3')
      ? 'application/octet-stream'
      : lower.endsWith('.mp3')
        ? 'audio/mpeg'
        : lower.endsWith('.wav')
          ? 'audio/wav'
          : lower.endsWith('.png')
            ? 'image/png'
            : 'application/octet-stream'
    return assetResponse(content, contentType)
  }
}

/** defaultSession 和 stage WebContents 同 session，注册一次即可；重复时 Electron 自行替换 handler。 */
export function registerLive2dAssetProtocol(
  session: Session,
  options: {
    readonly service: Live2dModelService
    readonly cubismCorePath: string
    readonly cubism2Path?: string
  }
): void {
  session.protocol.handle(LIVE2D_ASSET_SCHEME, createLive2dAssetProtocolHandler(options))
}
