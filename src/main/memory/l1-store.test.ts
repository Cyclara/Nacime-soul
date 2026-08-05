// src/main/memory/l1-store.test.ts
// P2-05 L1Store：正则分流、窗口滚动（3 轮内替换）、去重、事件、持久化。
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createL1Store } from './l1-store'

const dirs: string[] = []
function f(): string {
  const d = mkdtempSync(join(tmpdir(), 'nacime-l1-'))
  dirs.push(d)
  return join(d, 'l1-state.json')
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      /* best-effort */
    }
  }
})

describe('P2-05 L1Store', () => {
  it('routes goal-like text to recentGoals, others to recentPreferences', () => {
    const s = createL1Store({ filePath: f(), now: () => 1 })
    s.record('我想要学钢琴') // 想要
    s.record('下周计划去旅行') // 计划
    s.record('我喜欢喝咖啡') // 偏好
    expect(s.get().recentGoals.map((e) => e.text)).toEqual(['我想要学钢琴', '下周计划去旅行'])
    expect(s.get().recentPreferences.map((e) => e.text)).toEqual(['我喜欢喝咖啡'])
  })

  it('rolls window keeping last 3 (replaces within 3 turns)', () => {
    const s = createL1Store({ filePath: f(), now: () => 1 })
    for (let i = 0; i < 5; i++) s.record(`偏好${i}`) // 均不含目标词
    expect(s.get().recentPreferences.map((e) => e.text)).toEqual(['偏好2', '偏好3', '偏好4'])
  })

  it('dedupes identical text (moves to end)', () => {
    const s = createL1Store({ filePath: f() })
    s.record('A')
    s.record('B')
    s.record('A')
    expect(s.get().recentPreferences.map((e) => e.text)).toEqual(['B', 'A'])
  })

  it('emits l1.refreshed on record', () => {
    const s = createL1Store({ filePath: f() })
    let n = 0
    s.on('l1.refreshed', () => n++)
    s.record('x')
    expect(n).toBe(1)
  })

  it('ignores blank input', () => {
    const s = createL1Store({ filePath: f() })
    s.record('   ')
    expect(s.get().recentGoals).toEqual([])
    expect(s.get().recentPreferences).toEqual([])
  })

  it('persists and reloads across instances', () => {
    const p = f()
    const s1 = createL1Store({ filePath: p })
    s1.record('计划去旅行')
    const s2 = createL1Store({ filePath: p })
    expect(s2.get().recentGoals.map((e) => e.text)).toEqual(['计划去旅行'])
  })
})

describe('C-α-2 L1 损坏 = 阻断启动（不许静默清空）', () => {
  it('文件不存在 -> 正常空初始化，不报错', () => {
    const s = createL1Store({ filePath: f() })
    expect(s.get().recentGoals).toEqual([])
    expect(s.get().recentPreferences).toEqual([])
  })

  it('JSON 语法错误 -> 抛 MEM_DB_CORRUPT fatal，坏文件不被覆盖', () => {
    const path = f()
    const corrupt = '{ not valid json'

    writeFileSync(path, corrupt)
    expect(() => createL1Store({ filePath: path })).toThrow()
    expect(readFileSync(path, 'utf8')).toBe(corrupt)
  })

  it('schemaVersion 不符 -> 抛 MEM_DB_CORRUPT fatal', () => {
    const path = f()

    writeFileSync(
      path,
      JSON.stringify({ schemaVersion: 99, recentGoals: [], recentPreferences: [] })
    )
    expect(() => createL1Store({ filePath: path })).toThrow(/版本不匹配/)
  })

  it('schemaVersion 是字符串 -> 抛（bad-version）', () => {
    const path = f()

    writeFileSync(path, JSON.stringify({ schemaVersion: '1', recentGoals: [] }))
    expect(() => createL1Store({ filePath: path })).toThrow()
  })

  it('正常文件 -> 正常加载', () => {
    const path = f()
    const s1 = createL1Store({ filePath: path, now: () => 111 })
    s1.record('目标完成项目')
    const s2 = createL1Store({ filePath: path })
    expect(s2.get().recentGoals.map((e) => e.text)).toEqual(['目标完成项目'])
  })
})
