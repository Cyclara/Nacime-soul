// src/renderer/src/live2d/motion/lipsync.test.ts
// P3B-17：attack/release 200ms 平滑、静默停写交还 motion、缺 ParamMouthOpenY 只禁 lip-sync。

import { describe, expect, it } from 'vitest'
import type {
  ILive2DRenderer,
  Live2DFrameDriver,
  Live2DParameterUpdate,
  Live2DRendererMetrics
} from '../ILive2DRenderer'
import type { MotionPlugin } from './pipeline'
import { createLipSyncController, createLipSyncPlugin } from './lipsync'

interface MouthRecordingRenderer extends ILive2DRenderer {
  readonly mouthValues: number[]
  mouthOk: boolean
}

function renderer(mouthOk = true): MouthRecordingRenderer {
  const mouthValues: number[] = []
  const implementation: MouthRecordingRenderer = {
    mouthValues,
    get mouthOk() {
      return mouthOk
    },
    set mouthOk(value: boolean) {
      mouthOk = value
    },
    attach() {
      /* 不涉及 */
    },
    async load() {
      /* 不加载模型 */
    },
    unload() {
      /* 不涉及 */
    },
    resize() {
      /* 不涉及 */
    },
    setZoom() {
      /* 不涉及 */
    },
    setOffset() {
      /* 不涉及 */
    },
    pause() {
      /* 不涉及 */
    },
    resume() {
      /* 不涉及 */
    },
    setFrameDriver(_driver: Live2DFrameDriver | null) {
      void _driver
    },
    async setExpression() {
      return true
    },
    async playMotion() {
      return true
    },
    setParameter(update: Live2DParameterUpdate) {
      void update
      return true
    },
    setMouthOpen(value: number) {
      mouthValues.push(value)
      return implementation.mouthOk
    },
    setEyeOpen() {
      return true
    },
    hitTest() {
      return []
    },
    getMetrics(): Live2DRendererMetrics {
      return {
        fps: 60,
        frameCount: 1,
        modelLoadMs: 33,
        contextLossCount: 0,
        paused: false,
        hasModel: true
      }
    },
    dispose() {
      /* 不涉及 */
    }
  }
  return implementation
}

function levelSource(initial = 0): { level: number; readLevel(): number } {
  return {
    level: initial,
    readLevel() {
      return this.level
    }
  }
}

/** 以 60fps 推进 n 帧并收集写入。 */
function run(controller: ReturnType<typeof createLipSyncController>, frames: number): void {
  for (let i = 0; i < frames; i += 1) controller.update(1000 / 60)
}

describe('P3B-17 LipSyncController', () => {
  it('attack：200ms 内无跳变地升至目标（每帧步长 ≤ delta/attack）', () => {
    const fake = renderer()
    const source = levelSource()
    const controller = createLipSyncController({ renderer: fake, source })
    source.level = 1

    const writes: number[] = []
    for (let i = 0; i < 13; i += 1) {
      controller.update(1000 / 60)
      writes.push(controller.level)
    }

    // 16.67ms/帧 → 每帧 +0.0833；第 12 帧达到 1
    expect(controller.level).toBe(1)
    expect(fake.mouthValues.at(-1)).toBe(1)
    for (let i = 1; i < writes.length; i += 1) {
      expect(writes[i]! - writes[i - 1]!).toBeLessThanOrEqual(1000 / 60 / 200 + 1e-9)
    }
    // 无跳变：从未出现一步到位（首帧值远小于 1）
    expect(writes[0]).toBeCloseTo(1 / 12, 5)
    // 写入口型与 level 一致
    expect(fake.mouthValues).toHaveLength(13)
  })

  it('release：目标归 0 后 200ms 收敛；写一次 0 后停写（交还 motion）', () => {
    const fake = renderer()
    const source = levelSource(1)
    const controller = createLipSyncController({ renderer: fake, source })
    run(controller, 13)
    expect(controller.level).toBe(1)

    source.level = 0
    // 14 帧 > 12+1：线性收敛在浮点下会多走一帧 epsilon，随后一帧落定精确 0
    run(controller, 14)
    expect(controller.level).toBe(0)
    expect(fake.mouthValues.at(-1)).toBe(0)
    expect(controller.active).toBe(false)

    // 静默期不再写参数：motion/expression 重新接管
    const writeCountAfterSilence = fake.mouthValues.length
    run(controller, 60)
    expect(fake.mouthValues).toHaveLength(writeCountAfterSilence)
  })

  it('沉默后重新说话：恢复写入', () => {
    const fake = renderer()
    const source = levelSource(0)
    const controller = createLipSyncController({ renderer: fake, source })
    run(controller, 5) // 静默：无写入
    expect(fake.mouthValues).toHaveLength(0)

    source.level = 0.8
    controller.update(1000 / 60)
    expect(fake.mouthValues).toHaveLength(1)
    // attack 步长 = delta/attackMs = 16.67/200，与目标值大小无关
    expect(fake.mouthValues[0]).toBeCloseTo(1 / 12, 5)
  })

  it('模型缺 ParamMouthOpenY：第一次写失败即禁用，音频照播（不再写参数）', () => {
    const fake = renderer(false)
    const source = levelSource(1)
    const controller = createLipSyncController({ renderer: fake, source })

    controller.update(1000 / 60)
    expect(fake.mouthValues).toHaveLength(1)
    expect(controller.disabled).toBe(true)

    run(controller, 30)
    expect(fake.mouthValues).toHaveLength(1) // 之后不再写
    expect(controller.level).toBeCloseTo(1 / 12, 5) // level 停在失败那帧
  })

  it('电平越界安全：NaN→0，负数→0，>1 clamp 到 1', () => {
    const fake = renderer()
    const source = { readLevel: () => Number.NaN }
    const controller = createLipSyncController({ renderer: fake, source })
    run(controller, 10)
    expect(controller.level).toBe(0)
    expect(fake.mouthValues).toHaveLength(0)

    const highSource = { readLevel: () => 5 }
    const highController = createLipSyncController({ renderer: fake, source: highSource })
    highController.update(1000 / 60)
    expect(highController.level).toBeCloseTo(1 / 12, 5)

    const negSource = { readLevel: () => -3 }
    const negController = createLipSyncController({ renderer: fake, source: negSource })
    run(negController, 5)
    expect(negController.level).toBe(0)
  })

  it('dispose：active 时补写一次 0；inactive 时无写入', () => {
    const fake = renderer()
    const source = levelSource(1)
    const controller = createLipSyncController({ renderer: fake, source })
    controller.update(1000 / 60)
    expect(fake.mouthValues).toHaveLength(1)

    controller.dispose()
    expect(fake.mouthValues).toHaveLength(2)
    expect(fake.mouthValues[1]).toBe(0)

    controller.dispose() // 幂等
    expect(fake.mouthValues).toHaveLength(2)

    const idle = renderer()
    const idleController = createLipSyncController({ renderer: idle, source: levelSource() })
    idleController.dispose()
    expect(idle.mouthValues).toHaveLength(0)
  })
})

describe('P3B-17 LipSyncPlugin', () => {
  it('插件形状：priority 140 / final / onFrame 用 frame.deltaMs 驱动；dispose 闭嘴', () => {
    const fake = renderer()
    const source = levelSource(1)
    const plugin: MotionPlugin & { controller: ReturnType<typeof createLipSyncController> } =
      createLipSyncPlugin({ renderer: fake, source })

    expect(plugin.id).toBe('audio-lipsync')
    expect(plugin.priority).toBe(140)
    expect(plugin.phases).toEqual(['final'])

    plugin.onFrame({
      frame: { deltaMs: 16.67, nowMs: 0 },
      phase: 'final',
      handled: false,
      markHandled: () => {
        /* 不短路后续插件 */
      }
    })
    expect(fake.mouthValues).toHaveLength(1)

    plugin.dispose?.()
    expect(fake.mouthValues).toHaveLength(2)
    expect(fake.mouthValues[1]).toBe(0)
  })
})

describe('P3A-22 onSpeakingFrame（说话帧刷新表情期限）', () => {
  it('level > 0 的帧每帧回调；沉默帧（含收敛写 0 那帧）不回调', () => {
    const fake = renderer()
    const source = levelSource(1)
    let speakingFrames = 0
    const controller = createLipSyncController({
      renderer: fake,
      source,
      onSpeakingFrame: () => {
        speakingFrames += 1
      }
    })
    run(controller, 5)
    expect(speakingFrames).toBe(5)

    source.level = 0
    run(controller, 30) // 收敛到 0 后停写；收敛过程中 level>0 的帧仍算说话帧
    const afterSilence = speakingFrames
    run(controller, 10)
    expect(speakingFrames).toBe(afterSilence) // 静默期零回调
  })
})
