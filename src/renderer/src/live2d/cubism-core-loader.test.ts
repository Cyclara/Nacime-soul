// @vitest-environment jsdom
// P3A-11：仅允许 main 固定 runtime URL；load 后必须真有 Cubism global。

import { afterEach, describe, expect, it } from 'vitest'
import { ensureCubismCore, resetCubismCoreLoaderForTest } from './cubism-core-loader'

afterEach(() => {
  delete (window as Window & { Live2DCubismCore?: unknown }).Live2DCubismCore
  document.getElementById('nacime-live2d-cubism-core')?.remove()
  resetCubismCoreLoaderForTest()
})

describe('P3A-11 Cubism Core loader', () => {
  it('拒绝 null 或任何非 main 固定 URL', async () => {
    await expect(ensureCubismCore(null)).rejects.toThrow('CUBISM_CORE_UNAVAILABLE')
    await expect(ensureCubismCore('https://cdn.example/core.js')).rejects.toThrow(
      'CUBISM_CORE_UNAVAILABLE'
    )
  })

  it('固定 URL 只插入一次 script，load 后验证全局 runtime 存在', async () => {
    const first = ensureCubismCore('nacime-live2d://runtime/cubism-core')
    const second = ensureCubismCore('nacime-live2d://runtime/cubism-core')
    const script = document.getElementById('nacime-live2d-cubism-core') as HTMLScriptElement
    expect(script.src).toContain('nacime-live2d://runtime/cubism-core')
    expect(first).toBe(second)

    ;(window as Window & { Live2DCubismCore?: unknown }).Live2DCubismCore = {}
    script.dispatchEvent(new Event('load'))
    await expect(first).resolves.toBeUndefined()
  })
})
