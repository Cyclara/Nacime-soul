// src/main/live2d/asset-protocol.test.ts
// P3A-11：自定义 scheme parser 无盘外路径/错误 host 回退。

import { describe, expect, it } from 'vitest'
import { parseLive2dAssetRequest } from './asset-protocol'

describe('P3A-11 nacime-live2d asset protocol', () => {
  it('解析受控 model URL，保留嵌套资源相对路径', () => {
    expect(parseLive2dAssetRequest('nacime-live2d://model/mao/Mao.2048/texture_00.png')).toEqual({
      modelId: 'mao',
      path: 'Mao.2048/texture_00.png'
    })
  })

  it('runtime Cubism Core 使用固定无参数 URL', () => {
    expect(parseLive2dAssetRequest('nacime-live2d://runtime/cubism-core')).toEqual({
      modelId: 'runtime',
      path: 'cubism-core'
    })
  })

  it('错误 scheme/host/空路径/坏 percent encoding 均拒绝', () => {
    expect(parseLive2dAssetRequest('file:///C:/secret.txt')).toBeNull()
    expect(parseLive2dAssetRequest('nacime-live2d://evil/mao/Mao.model3.json')).toBeNull()
    expect(parseLive2dAssetRequest('nacime-live2d://model/mao')).toBeNull()
    expect(parseLive2dAssetRequest('nacime-live2d://model/%ZZ/Mao.model3.json')).toBeNull()
  })
})
