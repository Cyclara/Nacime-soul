// tests/helpers/fake-live2d-adapter.ts
// P3-00C：假 Live2D adapter——pixi-live2d-display 最小表面的测试替身。
//
// 用途：
//   - P3A-03 PixiLive2DRenderer 单测：注入本替身，测试不加载真实 Cubism/WebGL
//   - P3A-07 首帧冒烟：fake model 立即可用
//   - 动画管线（P3A-16..22）：参数读写/表情/update 全在内存发生
//
// 设计约束：
//   - 只模拟 PixiLive2DRenderer 需要的最小表面（ticker/stage/model 参数/表情/update/destroy），
//     不是 pixi.js 的完整 fake；真实接口冻结（P3A-02/03）后如需扩展在此追加
//   - 所有调用进 calls 日志，测试可断言顺序与次数
//   - failNextLoads 注入加载失败；liveModelCount/liveTickerCount 供"dispose 后引用归零"断言

export interface FakeAdapterCall {
  target: 'application' | 'ticker' | 'model'
  method: string
  args: unknown[]
}

export interface FakeTicker {
  add(fn: (deltaMs: number) => void): void
  remove(fn: (deltaMs: number) => void): void
  start(): void
  stop(): void
  destroy(): void
  /** 测试手动驱动帧推进 */
  tick(deltaMs: number): void
  readonly started: boolean
  readonly destroyed: boolean
  readonly listenerCount: number
}

export interface FakeLive2DModel {
  /** 参数读写（ParamAngleX/ParamEyeLOpen/ParamMouthOpenY 等任意名字） */
  setParameter(id: string, value: number): void
  getParameter(id: string): number
  hasParameter(id: string): boolean
  /** 表情/动作 */
  expression(name: string): boolean
  motion(group: string, index?: number): boolean
  /** 每帧更新（真实库里驱动 physics/pose；fake 只记日志 + 累计帧数） */
  update(deltaMs: number): void
  hitTest(x: number, y: number): string[]
  destroy(): void
  readonly destroyed: boolean
  readonly manifestPath: string
  updateCount: number
  x: number
  y: number
  scale: { x: number; y: number }
}

export interface FakePixiApplication {
  ticker: FakeTicker
  stage: {
    addChild(child: unknown): void
    removeChild(child: unknown): void
    readonly childCount: number
  }
  resize(width: number, height: number): void
  destroy(): void
  readonly destroyed: boolean
  width: number
  height: number
}

export interface FakeLive2DAdapter {
  createApplication(opts: { width: number; height: number }): FakePixiApplication
  loadModel(manifestPath: string): Promise<FakeLive2DModel>
  /** 让接下来 N 次 loadModel 以 error Reject（默认 Error('fake load failure')） */
  failNextLoads(count: number, error?: Error): void
  readonly calls: FakeAdapterCall[]
  /** 存活计数：测试断言 dispose 后归零 */
  readonly liveModelCount: number
  readonly liveApplicationCount: number
  reset(): void
}

export function createFakeLive2DAdapter(): FakeLive2DAdapter {
  const calls: FakeAdapterCall[] = []
  let liveModelCount = 0
  let liveApplicationCount = 0
  let pendingFailures: Error[] = []

  function makeTicker(): FakeTicker {
    const listeners = new Set<(deltaMs: number) => void>()
    let started = false
    let destroyed = false
    return {
      add(fn) {
        calls.push({ target: 'ticker', method: 'add', args: [] })
        listeners.add(fn)
      },
      remove(fn) {
        calls.push({ target: 'ticker', method: 'remove', args: [] })
        listeners.delete(fn)
      },
      start() {
        calls.push({ target: 'ticker', method: 'start', args: [] })
        started = true
      },
      stop() {
        calls.push({ target: 'ticker', method: 'stop', args: [] })
        started = false
      },
      destroy() {
        calls.push({ target: 'ticker', method: 'destroy', args: [] })
        listeners.clear()
        started = false
        destroyed = true
      },
      tick(deltaMs: number) {
        if (!started || destroyed) return
        for (const fn of [...listeners]) fn(deltaMs)
      },
      get started() {
        return started
      },
      get destroyed() {
        return destroyed
      },
      get listenerCount() {
        return listeners.size
      }
    }
  }

  return {
    createApplication(opts) {
      liveApplicationCount++
      let destroyed = false
      const children = new Set<unknown>()
      const app: FakePixiApplication = {
        ticker: makeTicker(),
        stage: {
          addChild(child) {
            calls.push({ target: 'application', method: 'stage.addChild', args: [] })
            children.add(child)
          },
          removeChild(child) {
            calls.push({ target: 'application', method: 'stage.removeChild', args: [] })
            children.delete(child)
          },
          get childCount() {
            return children.size
          }
        },
        resize(width, height) {
          calls.push({ target: 'application', method: 'resize', args: [width, height] })
          app.width = width
          app.height = height
        },
        destroy() {
          if (destroyed) return
          calls.push({ target: 'application', method: 'destroy', args: [] })
          children.clear()
          app.ticker.destroy()
          destroyed = true
          liveApplicationCount--
        },
        get destroyed() {
          return destroyed
        },
        width: opts.width,
        height: opts.height
      }
      calls.push({ target: 'application', method: 'create', args: [opts.width, opts.height] })
      return app
    },

    async loadModel(manifestPath) {
      calls.push({ target: 'model', method: 'load', args: [manifestPath] })
      const failure = pendingFailures.shift()
      if (failure) throw failure

      liveModelCount++
      const params = new Map<string, number>()
      let destroyed = false
      const model: FakeLive2DModel = {
        setParameter(id, value) {
          calls.push({ target: 'model', method: 'setParameter', args: [id, value] })
          params.set(id, value)
        },
        getParameter(id) {
          return params.get(id) ?? 0
        },
        hasParameter(id) {
          return params.has(id)
        },
        expression(name) {
          calls.push({ target: 'model', method: 'expression', args: [name] })
          return true
        },
        motion(group, index) {
          calls.push({ target: 'model', method: 'motion', args: [group, index] })
          return true
        },
        update(deltaMs) {
          model.updateCount++
          calls.push({ target: 'model', method: 'update', args: [deltaMs] })
        },
        hitTest(x, y) {
          calls.push({ target: 'model', method: 'hitTest', args: [x, y] })
          return []
        },
        destroy() {
          if (destroyed) return
          calls.push({ target: 'model', method: 'destroy', args: [] })
          params.clear()
          destroyed = true
          liveModelCount--
        },
        get destroyed() {
          return destroyed
        },
        manifestPath,
        updateCount: 0,
        x: 0,
        y: 0,
        scale: { x: 1, y: 1 }
      }
      return model
    },

    failNextLoads(count, error) {
      for (let i = 0; i < count; i++) {
        pendingFailures.push(error ?? new Error('fake load failure'))
      }
    },

    get calls() {
      return calls
    },
    get liveModelCount() {
      return liveModelCount
    },
    get liveApplicationCount() {
      return liveApplicationCount
    },
    reset() {
      calls.length = 0
      pendingFailures = []
    }
  }
}
