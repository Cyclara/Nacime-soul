// src/main/windows/live2d-window-manager.test.ts
// P3A-04/05：单窗口生命周期 + stage instance 防串台 + capability 注册/清理。

import { describe, expect, it } from 'vitest'
import type { BrowserWindow, Rectangle, WebContents } from 'electron'
import type { Live2dStageCommand } from '@shared/live2d/stage-types'
import { Live2dWindowManager } from './live2d-window-manager'

class FakeStageWindow {
  private readonly contents: WebContents
  private destroyed = false
  private visible = false
  private readonly listeners = new Map<string, () => void>()
  alwaysOnTop = true
  bounds: Rectangle = { x: 100, y: 100, width: 520, height: 720 }

  constructor(id: number) {
    this.contents = {
      id,
      isDestroyed: () => this.destroyed,
      send() {
        /* noop */
      }
    } as unknown as WebContents
  }

  /**
   * 真实 BrowserWindow 在销毁后读 `webContents` 会抛 "Object has been destroyed"。
   * 复刻这一行为，否则「销毁后回查 webContents」的 main 未捕获异常测不出来
   * （该异常会弹致命错误框并占住单实例锁，让后续所有启动静默退出）。
   */
  get webContents(): WebContents {
    if (this.destroyed) throw new TypeError('Object has been destroyed')
    return this.contents
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isVisible(): boolean {
    return this.visible
  }

  show(): void {
    this.visible = true
    this.listeners.get('show')?.()
  }

  hide(): void {
    this.visible = false
    this.listeners.get('hide')?.()
  }

  minimize(): void {
    this.visible = false
    this.listeners.get('minimize')?.()
  }

  restore(): void {
    this.visible = true
    this.listeners.get('restore')?.()
  }

  getBounds(): Rectangle {
    return { ...this.bounds }
  }

  setPosition(x: number, y: number): void {
    this.bounds = { ...this.bounds, x, y }
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.listeners.get('closed')?.()
  }

  setAlwaysOnTop(value: boolean): void {
    this.alwaysOnTop = value
  }

  on(event: string, listener: () => void): this {
    this.listeners.set(event, listener)
    return this
  }

  crash(): void {
    this.listeners.get('render-process-gone')?.()
  }
}

describe('P3A-04/05 Live2dWindowManager', () => {
  it('show/destroy/recreate 幂等，且关闭时恰好移除旧 stage capability', () => {
    const created: number[] = []
    const destroyed: number[] = []
    const windows = [new FakeStageWindow(10), new FakeStageWindow(11)]
    const manager = new Live2dWindowManager({
      createWindow: () => {
        const window = windows.shift()
        if (window === undefined) throw new Error('unexpected window')
        created.push(window.webContents.id)
        return window as unknown as BrowserWindow
      },
      onStageCreated: (id) => created.push(id),
      onStageDestroyed: (id) => destroyed.push(id),
      getModelLoadPlan: () => ({
        attempts: [],
        exhaustedError: {
          code: 'FILE_NOT_FOUND',
          retryable: false,
          suggestedAction: 'choose-model'
        }
      }),
      getStageModelUrl: () => null,
      getCubismCoreUrl: () => null,
      getZoom: () => 1,
      getOffset: () => ({ x: 0, y: 0 }),
      sendStageCommand: () => {}
    })

    expect(manager.show()).toMatchObject({
      status: 'starting',
      webContentsId: 10,
      loadedModelId: null,
      visible: false
    })
    expect(manager.show()).toMatchObject({ webContentsId: 10 })
    expect(created).toEqual([10, 10]) // factory once + capability once

    manager.destroy()
    manager.destroy()
    expect(manager.getSnapshot()).toMatchObject({ status: 'closed', webContentsId: null })
    expect(destroyed).toEqual([10])

    expect(manager.show()).toMatchObject({ status: 'starting', webContentsId: 11 })
    expect(created).toEqual([10, 10, 11, 11])
  })

  it('ready 性能报告只含数字并交给 main 性能采样入口', () => {
    const window = new FakeStageWindow(19)
    const reports: Array<{ senderId: number; fps?: number; modelLoadMs?: number }> = []
    const manager = new Live2dWindowManager({
      createWindow: () => window as unknown as BrowserWindow,
      onStageCreated: () => {},
      onStageDestroyed: () => {},
      getModelLoadPlan: () => ({
        attempts: [],
        exhaustedError: {
          code: 'FILE_NOT_FOUND',
          retryable: false,
          suggestedAction: 'choose-model'
        }
      }),
      getStageModelUrl: () => null,
      getCubismCoreUrl: () => null,
      getZoom: () => 1,
      getOffset: () => ({ x: 0, y: 0 }),
      onPerformanceReport: (sender, report) =>
        reports.push({ senderId: sender.id, fps: report.fps, modelLoadMs: report.modelLoadMs })
    })
    manager.show()
    manager.acceptStageReady(window.webContents, { stageInstanceId: 'stage-metrics' })
    manager.acceptStageReport(window.webContents, {
      stageInstanceId: 'stage-metrics',
      status: 'ready',
      fps: 60,
      modelLoadMs: 120
    })
    expect(reports).toEqual([{ senderId: 19, fps: 60, modelLoadMs: 120 }])
  })

  it('bootstrap 携带 config zoom，运行中缩放走 stage command，重置位置由 main 按当前屏幕居中', () => {
    const window = new FakeStageWindow(18)
    const commands: Live2dStageCommand[] = []
    const manager = new Live2dWindowManager({
      createWindow: () => window as unknown as BrowserWindow,
      onStageCreated: () => {},
      onStageDestroyed: () => {},
      getModelLoadPlan: () => ({
        attempts: [],
        exhaustedError: {
          code: 'FILE_NOT_FOUND',
          retryable: false,
          suggestedAction: 'choose-model'
        }
      }),
      getStageModelUrl: () => null,
      getCubismCoreUrl: () => null,
      getZoom: () => 1.75,
      getOffset: () => ({ x: 0, y: 0 }),
      getDisplayWorkArea: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
      sendStageCommand: (_wc, command) => commands.push(command)
    })

    manager.show()
    const bootstrap = manager.acceptStageReady(window.webContents, {
      stageInstanceId: 'stage-placement'
    })
    expect(bootstrap.zoom).toBe(1.75)
    manager.setZoom(9)
    expect(commands).toEqual([{ type: 'set-zoom', zoom: 3 }])
    expect(manager.resetWindowPlacement()).toBe(true)
    expect(window.bounds).toEqual({ x: 700, y: 180, width: 520, height: 720 })
  })

  it('setEmotion 下发 stage 命令；窗口未开时静默 no-op，不投影进公开快照', () => {
    const window = new FakeStageWindow(24)
    const commands: Live2dStageCommand[] = []
    let stateChanges = 0
    const manager = new Live2dWindowManager({
      createWindow: () => window as unknown as BrowserWindow,
      onStageCreated: () => {},
      onStageDestroyed: () => {},
      getModelLoadPlan: () => ({
        attempts: [],
        exhaustedError: {
          code: 'FILE_NOT_FOUND',
          retryable: false,
          suggestedAction: 'choose-model'
        }
      }),
      getStageModelUrl: () => null,
      getCubismCoreUrl: () => null,
      getZoom: () => 1,
      getOffset: () => ({ x: 0, y: 0 }),
      sendStageCommand: (_wc, command) => commands.push(command),
      onStateChange: () => {
        stateChanges++
      }
    })

    // 窗口未开：不发命令也不报错（hook 每轮都会调，绝不能因此抛进 turn.end）。
    manager.setEmotion('smile')
    expect(commands).toEqual([])

    // stage 尚未 ready 时同样丢弃：没有 stageInstanceId 就没有合法收件人。
    manager.show()
    manager.setEmotion('smile')
    expect(commands).toEqual([])

    manager.acceptStageReady(window.webContents, { stageInstanceId: 'stage-emotion' })
    const before = stateChanges
    manager.setEmotion('surprised')
    expect(commands).toEqual([{ type: 'set-emotion', emotion: 'surprised' }])
    // 表情每轮都变、3 分钟自动回 neutral，投影出去只会让 chat store 空抖。
    expect(stateChanges).toBe(before)
    expect(manager.getSnapshot()).not.toHaveProperty('emotion')
  })

  it('窗口被外部关闭时按建窗时记下的 id 注销能力，不回查已销毁的 webContents', () => {
    const window = new FakeStageWindow(31)
    const destroyed: number[] = []
    const manager = new Live2dWindowManager({
      createWindow: () => window as unknown as BrowserWindow,
      onStageCreated: () => {},
      onStageDestroyed: (id) => destroyed.push(id),
      getModelLoadPlan: () => ({
        attempts: [],
        exhaustedError: {
          code: 'FILE_NOT_FOUND',
          retryable: false,
          suggestedAction: 'choose-model'
        }
      }),
      getStageModelUrl: () => null,
      getCubismCoreUrl: () => null,
      getZoom: () => 1,
      getOffset: () => ({ x: 0, y: 0 }),
      sendStageCommand: () => {}
    })

    manager.show()
    manager.acceptStageReady(window.webContents, { stageInstanceId: 'stage-closed' })
    // 用户直接关掉角色窗口：'closed' 在窗口已销毁后触发。
    expect(() => window.destroy()).not.toThrow()
    expect(destroyed).toEqual([31])
    // 快照仍可安全读取，且不再声称持有 webContents。
    expect(manager.getSnapshot()).toMatchObject({
      status: 'closed',
      visible: false,
      webContentsId: null
    })
  })

  it('取景预览只推 stage 命令；预览期间 config 变更不抢画面，结束时按落盘构图归位', () => {
    const window = new FakeStageWindow(24)
    const commands: Live2dStageCommand[] = []
    const saved = { zoom: 1, x: 0, y: 0 }
    const manager = new Live2dWindowManager({
      createWindow: () => window as unknown as BrowserWindow,
      onStageCreated: () => {},
      onStageDestroyed: () => {},
      getModelLoadPlan: () => ({
        attempts: [],
        exhaustedError: {
          code: 'FILE_NOT_FOUND',
          retryable: false,
          suggestedAction: 'choose-model'
        }
      }),
      getStageModelUrl: () => null,
      getCubismCoreUrl: () => null,
      getZoom: () => saved.zoom,
      getOffset: () => ({ x: saved.x, y: saved.y }),
      sendStageCommand: (_wc, command) => commands.push(command)
    })

    manager.show()
    manager.acceptStageReady(window.webContents, { stageInstanceId: 'stage-preview' })

    manager.previewFraming({ zoom: 0.5, offsetX: -10, offsetY: 50 })
    // 预览期间 config 订阅照常触发，但不得覆盖用户正在看的草稿构图。
    manager.setZoom(3)
    manager.setOffset(100, 100)
    expect(commands).toEqual([
      { type: 'set-zoom', zoom: 0.5 },
      { type: 'set-offset', offsetX: -10, offsetY: 50 }
    ])

    // 保存成功：config 已是新值，结束预览即归位到新值。
    saved.zoom = 0.5
    saved.y = 50
    commands.length = 0
    manager.previewFraming(null)
    expect(commands).toEqual([
      { type: 'set-zoom', zoom: 0.5 },
      { type: 'set-offset', offsetX: 0, offsetY: 50 }
    ])

    // 预览已结束：config 变更重新生效，且重复 endPreview 不再发命令。
    commands.length = 0
    manager.previewFraming(null)
    manager.setZoom(2)
    expect(commands).toEqual([{ type: 'set-zoom', zoom: 2 }])
  })

  it('预览中窗口被销毁后，新 stage 的 config 变更不会被残留预览标志吞掉', () => {
    const first = new FakeStageWindow(25)
    const second = new FakeStageWindow(26)
    const windows = [first, second]
    const commands: Live2dStageCommand[] = []
    const manager = new Live2dWindowManager({
      createWindow: () => windows.shift() as unknown as BrowserWindow,
      onStageCreated: () => {},
      onStageDestroyed: () => {},
      getModelLoadPlan: () => ({
        attempts: [],
        exhaustedError: {
          code: 'FILE_NOT_FOUND',
          retryable: false,
          suggestedAction: 'choose-model'
        }
      }),
      getStageModelUrl: () => null,
      getCubismCoreUrl: () => null,
      getZoom: () => 1,
      getOffset: () => ({ x: 0, y: 0 }),
      sendStageCommand: (_wc, command) => commands.push(command)
    })

    manager.show()
    manager.acceptStageReady(first.webContents, { stageInstanceId: 'stage-1' })
    manager.previewFraming({ zoom: 2, offsetX: 0, offsetY: 0 })
    manager.destroy()

    manager.show()
    manager.acceptStageReady(second.webContents, { stageInstanceId: 'stage-2' })
    commands.length = 0
    manager.setZoom(1.5)
    expect(commands).toEqual([{ type: 'set-zoom', zoom: 1.5 }])
  })

  it('只接受当前 stage instance；ready 报告后显示窗口，旧 renderer report 被拒绝', () => {
    const first = new FakeStageWindow(20)
    const second = new FakeStageWindow(21)
    const commands: Live2dStageCommand[] = []
    const windows = [first, second]
    const manager = new Live2dWindowManager({
      createWindow: () => windows.shift() as unknown as BrowserWindow,
      onStageCreated: () => {},
      onStageDestroyed: () => {},
      getModelLoadPlan: () => ({
        attempts: [],
        exhaustedError: {
          code: 'FILE_NOT_FOUND',
          retryable: false,
          suggestedAction: 'choose-model'
        }
      }),
      getStageModelUrl: () => null,
      getCubismCoreUrl: () => null,
      getZoom: () => 1,
      getOffset: () => ({ x: 0, y: 0 }),
      scheduleResume: (callback) => callback(),
      cancelScheduledResume: () => {},
      sendStageCommand: (_wc, command) => commands.push(command)
    })

    manager.show()
    expect(
      manager.acceptStageReady(first.webContents, { stageInstanceId: 'stage-a' })
    ).toMatchObject({
      status: 'loading-model'
    })
    manager.acceptStageReport(first.webContents, {
      stageInstanceId: 'stage-a',
      status: 'ready',
      fps: 60
    })
    expect(manager.getSnapshot()).toMatchObject({ status: 'ready', visible: true })
    manager.sendStageCommand({ type: 'pause' })
    expect(commands).toEqual([{ type: 'resume' }, { type: 'pause' }])

    first.hide()
    first.minimize()
    first.restore()
    expect(commands).toEqual([
      { type: 'resume' },
      { type: 'pause' },
      { type: 'pause' },
      { type: 'pause' },
      { type: 'resume' }
    ])

    // 真实场景里迟到的 IPC 带的是旧 sender 对象本身，而不是「销毁后的窗口再回查 webContents」，
    // 所以引用要在销毁前取；销毁后回查会抛 Object has been destroyed（那是另一条已修的崩溃路径）。
    const staleSender = first.webContents
    manager.destroy()
    manager.show()
    expect(() =>
      manager.acceptStageReport(staleSender, { stageInstanceId: 'stage-a', status: 'ready' })
    ).toThrow('状态已过期')
    expect(() =>
      manager.acceptStageReady(second.webContents, { stageInstanceId: 'stage-b' })
    ).not.toThrow()
  })

  it('模型失败按 selected → retry → Mao → Hiyori 推进，耗尽后保持 error 而不无限循环', () => {
    const window = new FakeStageWindow(25)
    const commands: Live2dStageCommand[] = []
    const manager = new Live2dWindowManager({
      createWindow: () => window as unknown as BrowserWindow,
      onStageCreated: () => {},
      onStageDestroyed: () => {},
      getModelLoadPlan: () => ({
        attempts: [
          { modelId: 'user', reason: 'selected' },
          { modelId: 'user', reason: 'retry-selected' },
          { modelId: 'mao', reason: 'fallback-mao' },
          { modelId: 'hiyori', reason: 'fallback-hiyori' }
        ],
        exhaustedError: {
          code: 'FILE_NOT_FOUND',
          retryable: false,
          suggestedAction: 'choose-model'
        }
      }),
      getStageModelUrl: (id) => `nacime-live2d://model/${id}/model.model3.json`,
      // 真机复现的关键：首选模型没有任何 expression，降级目标才有。
      getModelExpressionNames: (id) => (id === 'user' ? [] : [`${id}_exp_01`, `${id}_exp_02`]),
      getCubismCoreUrl: () => 'nacime-live2d://runtime/cubism-core',
      getZoom: () => 1,
      getOffset: () => ({ x: 0, y: 0 }),
      sendStageCommand: (_wc, command) => commands.push(command)
    })

    manager.show()
    expect(
      manager.acceptStageReady(window.webContents, { stageInstanceId: 'stage-fallback' })
    ).toMatchObject({
      initialModelUrl: 'nacime-live2d://model/user/model.model3.json',
      expressionNames: []
    })
    for (let i = 0; i < 4; i++) {
      manager.acceptStageReport(window.webContents, {
        stageInstanceId: 'stage-fallback',
        status: 'error',
        errorCode: 'L2D_MODEL_LOAD'
      })
    }
    // 每条 load-model 都必须带**该模型自己的** expression 名单：bootstrap 那份属于首次尝试，
    // 降级后就过期了。2026-08-29 真机实测正是因此表情静默失效（首选损坏 → 降级 Mao → 名单仍为空）。
    expect(commands).toEqual([
      {
        type: 'load-model',
        modelUrl: 'nacime-live2d://model/user/model.model3.json',
        expressionNames: []
      },
      {
        type: 'load-model',
        modelUrl: 'nacime-live2d://model/mao/model.model3.json',
        expressionNames: ['mao_exp_01', 'mao_exp_02']
      },
      {
        type: 'load-model',
        modelUrl: 'nacime-live2d://model/hiyori/model.model3.json',
        expressionNames: ['hiyori_exp_01', 'hiyori_exp_02']
      }
    ])
    expect(manager.getSnapshot().status).toBe('error')
  })

  it('stage crash 只把自身标记 error，不销毁或重建 chat window', () => {
    const window = new FakeStageWindow(30)
    const manager = new Live2dWindowManager({
      createWindow: () => window as unknown as BrowserWindow,
      onStageCreated: () => {},
      onStageDestroyed: () => {},
      getModelLoadPlan: () => ({
        attempts: [],
        exhaustedError: {
          code: 'FILE_NOT_FOUND',
          retryable: false,
          suggestedAction: 'choose-model'
        }
      }),
      getStageModelUrl: () => null,
      getCubismCoreUrl: () => null,
      getZoom: () => 1,
      getOffset: () => ({ x: 0, y: 0 }),
      sendStageCommand: () => {},
      // 不调度重建：本用例只看崩溃那一刻的状态
      scheduleCrashRebuild: () => {}
    })

    manager.show()
    window.crash()
    expect(manager.getSnapshot().status).toBe('error')
    expect(window.isDestroyed()).toBe(false)
  })
})

// S-006-补充 §1.7.7：stage 崩溃恢复——有界重建 1 次（新 webContentsId + 新 stageInstanceId），
// 连续第二次崩溃保持 error；一次成功 ready 归零计数；不重建 chat。
describe('S-006 §1.7.7 Live2dWindowManager 崩溃有界重建', () => {
  function harness(opts?: { audioOnly?: boolean }): {
    manager: Live2dWindowManager
    windows: FakeStageWindow[]
    created: number[]
    destroyed: number[]
    runRebuild: () => void
  } {
    const windows: FakeStageWindow[] = []
    const created: number[] = []
    const destroyed: number[] = []
    let pendingRebuild: (() => void) | null = null
    let nextId = 100
    const manager = new Live2dWindowManager({
      createWindow: () => {
        const window = new FakeStageWindow(nextId++)
        windows.push(window)
        return window as unknown as BrowserWindow
      },
      onStageCreated: (id) => created.push(id),
      onStageDestroyed: (id) => destroyed.push(id),
      getModelLoadPlan: () => ({
        attempts: [{ modelId: 'mao', reason: 'selected' }],
        exhaustedError: {
          code: 'FILE_NOT_FOUND',
          retryable: false,
          suggestedAction: 'choose-model'
        }
      }),
      getStageModelUrl: (id) => `nacime-live2d://model/${id}/model.model3.json`,
      getCubismCoreUrl: () => null,
      getZoom: () => 1,
      getOffset: () => ({ x: 0, y: 0 }),
      sendStageCommand: () => {},
      scheduleCrashRebuild: (callback) => {
        pendingRebuild = callback
      }
    })
    if (opts?.audioOnly === true) manager.ensureAudioOnlyStage()
    else manager.show()
    return {
      manager,
      windows,
      created,
      destroyed,
      runRebuild: () => {
        const callback = pendingRebuild
        pendingRebuild = null
        callback?.()
      }
    }
  }

  it('崩溃一次：标 error → 重建为新窗口/新 webContentsId，旧 ID 出 trust set', () => {
    const h = harness()
    const first = h.windows[0]!
    manager_ready(h.manager, first, 'stage-a')

    first.crash()
    expect(h.manager.getSnapshot().status).toBe('error')
    h.runRebuild()

    expect(h.windows).toHaveLength(2)
    expect(first.isDestroyed()).toBe(true)
    expect(h.destroyed).toEqual([100])
    expect(h.created).toEqual([100, 101])
    expect(h.manager.getSnapshot()).toMatchObject({ status: 'starting', webContentsId: 101 })
    // 新 stage 用新 instance id 重新 ready，一切照常
    const bootstrap = h.manager.acceptStageReady(h.windows[1]!.webContents, {
      stageInstanceId: 'stage-b'
    })
    expect(bootstrap.initialModelUrl).toBe('nacime-live2d://model/mao/model.model3.json')
  })

  it('连续第二次崩溃：不再重建，保持 error 等用户显式恢复', () => {
    const h = harness()
    manager_ready(h.manager, h.windows[0]!, 'stage-a')
    h.windows[0]!.crash()
    h.runRebuild()
    expect(h.windows).toHaveLength(2)

    // 重建的 stage 还没 ready 就又崩了（连续崩溃）
    h.windows[1]!.crash()
    h.runRebuild()
    expect(h.windows).toHaveLength(2) // 没有第三个窗口
    expect(h.manager.getSnapshot().status).toBe('error')
  })

  it('重建后成功 ready 归零计数：之后再崩仍允许一次重建', () => {
    const h = harness()
    manager_ready(h.manager, h.windows[0]!, 'stage-a')
    h.windows[0]!.crash()
    h.runRebuild()
    manager_ready(h.manager, h.windows[1]!, 'stage-b')

    h.windows[1]!.crash()
    h.runRebuild()
    expect(h.windows).toHaveLength(3)
  })

  it('用户在重建调度前主动关闭：不重建（不与显式 destroy 打架）', () => {
    const h = harness()
    manager_ready(h.manager, h.windows[0]!, 'stage-a')
    h.windows[0]!.crash()
    h.manager.destroy()
    h.runRebuild()
    expect(h.windows).toHaveLength(1)
    expect(h.manager.getSnapshot().status).toBe('closed')
  })

  it('audio-only 宿主崩溃：按 audio-only 模式重建（不 show、不加载模型）', () => {
    const h = harness({ audioOnly: true })
    const first = h.windows[0]!
    h.manager.acceptStageReady(first.webContents, { stageInstanceId: 'audio-a' })
    first.crash()
    h.runRebuild()
    expect(h.windows).toHaveLength(2)
    expect(h.manager.getSnapshot()).toMatchObject({ audioOnly: true, visible: false })
    const bootstrap = h.manager.acceptStageReady(h.windows[1]!.webContents, {
      stageInstanceId: 'audio-b'
    })
    expect(bootstrap.mode).toBe('audio-only')
    expect(h.windows[1]!.isVisible()).toBe(false)
  })

  /** ready 全流程：stage ready → report ready（窗口 show）。 */
  function manager_ready(
    manager: Live2dWindowManager,
    window: FakeStageWindow,
    stageInstanceId: string
  ): void {
    manager.acceptStageReady(window.webContents, { stageInstanceId })
    manager.acceptStageReport(window.webContents, { stageInstanceId, status: 'ready', fps: 60 })
  }
})

// P3B-15（F5-007 §1.14 / 验收 C23）：audio-only-hidden stage——TTS 开而 Live2D 关时
// 建 show:false 轻量宿主：不加载模型、ready 后不显示窗口、bootstrap 带 mode 标志。
describe('P3B-15 Live2dWindowManager audio-only hidden stage', () => {
  function makeManager(deps: {
    createWindow: () => BrowserWindow
    onStageReady?: (wc: WebContents) => void
  }): { manager: Live2dWindowManager; readyHooks: Array<{ id: number }> } {
    const readyHooks: Array<{ id: number }> = []
    const manager = new Live2dWindowManager({
      createWindow: deps.createWindow,
      onStageCreated: () => {},
      onStageDestroyed: () => {},
      getModelLoadPlan: () => ({
        attempts: [],
        exhaustedError: {
          code: 'FILE_NOT_FOUND',
          retryable: false,
          suggestedAction: 'choose-model'
        }
      }),
      getStageModelUrl: () => null,
      getCubismCoreUrl: () => null,
      getZoom: () => 1,
      getOffset: () => ({ x: 0, y: 0 }),
      sendStageCommand: () => {},
      onStageReady: (wc) => {
        readyHooks.push({ id: wc.id })
        deps.onStageReady?.(wc)
      }
    })
    return { manager, readyHooks }
  }

  const fakeSender = (id: number): WebContents => ({ id }) as unknown as WebContents

  it('ensureAudioOnlyStage 建隐藏窗口：snapshot.audioOnly=true、ready 后不 show', () => {
    const window = new FakeStageWindow(30)
    const { manager } = makeManager({ createWindow: () => window as unknown as BrowserWindow })

    const snap = manager.ensureAudioOnlyStage()
    expect(snap).toMatchObject({ status: 'starting', webContentsId: 30, audioOnly: true })
    expect(window.isVisible()).toBe(false)

    // audio-only bootstrap：无模型 URL + mode 标志 + cubism 资源为 null
    const bootstrap = manager.acceptStageReady(fakeSender(30), { stageInstanceId: 's30' })
    expect(bootstrap).toMatchObject({
      stageInstanceId: 's30',
      mode: 'audio-only',
      initialModelUrl: null,
      cubismCoreUrl: null
    })

    // ready 报告：audioOnly 下窗口保持隐藏
    manager.acceptStageReport(fakeSender(30), { stageInstanceId: 's30', status: 'ready' })
    expect(manager.getSnapshot()).toMatchObject({ status: 'ready', audioOnly: true })
    expect(window.isVisible()).toBe(false)
  })

  it('ensureAudioOnlyStage 幂等复用；show() 后 audioOnly 清除（升级为可见模式）', () => {
    const window = new FakeStageWindow(31)
    const { manager } = makeManager({ createWindow: () => window as unknown as BrowserWindow })

    manager.ensureAudioOnlyStage()
    manager.ensureAudioOnlyStage()
    expect(manager.getSnapshot().audioOnly).toBe(true)

    manager.show()
    expect(manager.getSnapshot().audioOnly).toBe(false)
    expect(window.isVisible()).toBe(true)
  })

  it('onStageReady 钩子在 valid ready 时触发（P3B-15 建 port 的时机）', () => {
    const window = new FakeStageWindow(32)
    const preview = makeManager({ createWindow: () => window as unknown as BrowserWindow })
    const manager = preview.manager

    manager.ensureAudioOnlyStage()
    manager.acceptStageReady(fakeSender(32), { stageInstanceId: 's32' })
    expect(preview.readyHooks).toEqual([{ id: 32 }])

    // 可见模式同样触发——PlaybackHost=stage renderer 恒成立（§1.14 唯一 host）
    const visibleWindow = new FakeStageWindow(33)
    const visible = makeManager({ createWindow: () => visibleWindow as unknown as BrowserWindow })
    visible.manager.show()
    visible.manager.acceptStageReady(fakeSender(33), { stageInstanceId: 's33' })
    expect(visible.readyHooks).toEqual([{ id: 33 }])
  })

  it('销毁后 audioOnly 复位；再 ensure 得到新 generation 窗口', () => {
    const windows = [new FakeStageWindow(34), new FakeStageWindow(35)]
    const { manager } = makeManager({
      createWindow: () => windows.shift() as unknown as BrowserWindow
    })
    manager.ensureAudioOnlyStage()
    manager.destroy()
    expect(manager.getSnapshot()).toMatchObject({ status: 'closed', audioOnly: false })
    manager.ensureAudioOnlyStage()
    expect(manager.getSnapshot()).toMatchObject({ webContentsId: 35, audioOnly: true })
  })
})
