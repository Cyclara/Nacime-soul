// src/renderer/src/live2d/motion/parameter-layer.ts
// P3A-21：按 activeLastFrame → activeThisFrame 追踪写入者；表情采用 Multiply 叠加，
// 不复制模型默认值。每帧 post/final 可清理已失效写入，避免旧表情残留。

import type { ILive2DRenderer, Live2DParameterUpdate } from '../ILive2DRenderer'

export interface ParameterLayerValue {
  readonly id: string
  readonly value: number
  readonly weight?: number
  readonly blend: 'set' | 'multiply'
}

export interface ParameterLayer {
  set(update: Omit<ParameterLayerValue, 'blend'>): void
  multiply(update: Omit<ParameterLayerValue, 'blend'>): void
  apply(): void
  clear(): void
  readonly activeLastFrame: readonly string[]
  readonly activeThisFrame: readonly string[]
}

export function createParameterLayer(renderer: ILive2DRenderer): ParameterLayer {
  let lastFrame = new Map<string, ParameterLayerValue>()
  let thisFrame = new Map<string, ParameterLayerValue>()

  const set = (update: Omit<ParameterLayerValue, 'blend'>): void => {
    thisFrame.set(update.id, { ...update, blend: 'set' })
  }
  const multiply = (update: Omit<ParameterLayerValue, 'blend'>): void => {
    thisFrame.set(update.id, { ...update, blend: 'multiply' })
  }
  const apply = (): void => {
    for (const value of thisFrame.values()) {
      const update: Live2DParameterUpdate = {
        id: value.id,
        value: value.value,
        ...(value.weight === undefined ? {} : { weight: value.weight }),
        blend: value.blend
      }
      renderer.setParameter(update)
    }
    lastFrame = thisFrame
    thisFrame = new Map()
  }
  const clear = (): void => {
    lastFrame = new Map()
    thisFrame = new Map()
  }

  return {
    set,
    multiply,
    apply,
    clear,
    get activeLastFrame() {
      return [...lastFrame.keys()]
    },
    get activeThisFrame() {
      return [...thisFrame.keys()]
    }
  }
}
