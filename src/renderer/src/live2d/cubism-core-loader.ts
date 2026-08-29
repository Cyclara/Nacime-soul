// src/renderer/src/live2d/cubism-core-loader.ts
// P3A-11：按 main 给出的固定 nacime-live2d://runtime/cubism-core URL 加载 Cubism Core。
// 不使用 CDN，不接受任意 URL；重复 stage HMR 共享同一 promise，避免重复插 script。

const CUBISM_CORE_URL = 'nacime-live2d://runtime/cubism-core'
const CUBISM2_URL = 'nacime-live2d://runtime/cubism2'
const SCRIPT_ID = 'nacime-live2d-cubism-core'
const SCRIPT2_ID = 'nacime-live2d-cubism2'
let loading: Promise<void> | null = null

interface CubismWindow extends Window {
  Live2DCubismCore?: unknown
  Live2D?: unknown
}

function loadScript(url: string, scriptId: string, documentRef: Document): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const existing = documentRef.getElementById(scriptId) as HTMLScriptElement | null
    if (existing !== null) {
      if (existing.dataset['loaded'] === 'true') {
        resolvePromise()
      } else {
        existing.addEventListener('load', () => resolvePromise(), { once: true })
        existing.addEventListener('error', () => reject(new Error('CUBISM_CORE_LOAD_FAILED')), {
          once: true
        })
      }
      return
    }
    const script = documentRef.createElement('script')
    script.id = scriptId
    script.src = url
    script.async = false
    script.addEventListener(
      'load',
      () => {
        script.dataset['loaded'] = 'true'
        resolvePromise()
      },
      { once: true }
    )
    script.addEventListener('error', () => reject(new Error('CUBISM_CORE_LOAD_FAILED')), {
      once: true
    })
    documentRef.head.append(script)
  })
}

export function ensureCubismCore(
  url: string | null,
  documentRef: Document = document
): Promise<void> {
  const hostWindow = documentRef.defaultView as CubismWindow | null
  if (url !== CUBISM_CORE_URL || hostWindow === null) {
    return Promise.reject(new Error('CUBISM_CORE_UNAVAILABLE'))
  }
  if (hostWindow.Live2DCubismCore !== undefined) return Promise.resolve()
  if (loading !== null) return loading

  loading = loadScript(url, SCRIPT_ID, documentRef)
    .then(() => {
      if (hostWindow.Live2DCubismCore === undefined) throw new Error('CUBISM_CORE_PARSE_FAILED')
    })
    .catch((error: unknown) => {
      loading = null
      throw error
    })
  return loading
}

export function ensureCubism2(url: string | null, documentRef: Document = document): Promise<void> {
  if (url !== CUBISM2_URL) return Promise.reject(new Error('CUBISM_CORE_UNAVAILABLE'))
  const hostWindow = documentRef.defaultView as (Window & { Live2D?: unknown }) | null
  if (hostWindow?.Live2D !== undefined) return Promise.resolve()
  return loadScript(url, SCRIPT2_ID, documentRef).then(() => {
    if (hostWindow?.Live2D === undefined) throw new Error('CUBISM_CORE_PARSE_FAILED')
  })
}

/** 单测/HMR cleanup；生产不调用，core global 由浏览器页面生命周期回收。 */
export function resetCubismCoreLoaderForTest(): void {
  loading = null
}
