// src/main/memory/revision-clock.ts
// 持久化全局 MemoryRevisionClock。依据 S-012 §1.4。
//
// S-012 修订：Revision 必须先有持久化的全局真源，不能复用 VectorStore.revision()。
// 现有 SQLiteVectorStore 的 revision 只是进程内索引版本：重启归零、init() 也会递增，
// 而且 L0/L1/growth 写入不会触发它。S-003 中"与 VectorStore.revision() 同源"在实现上不可成立。
//
// 真源：memory.db 的 app_meta.memory_revision 单行（由 002 迁移建立）。
// 应用重启后延续。DB 内 L2/growth 写可与业务事务同事务 next()；
// L0/L1 是 JSON 原子写，顺序固定为"JSON rename 成功 -> 短 DB 事务 next -> 广播"。
//
// 若 next 失败，记录待补发并在 focus/bulk 以当前投影重建；不得先广播后写 revision。

import type { Database } from 'better-sqlite3'

export interface MemoryRevisionClock {
  /** 当前持久化的 revision（重启后延续） */
  current(): number
  /**
   * 每次用户可见 memory/growth 变更成功提交后调用，持久化且严格单调。
   * 返回递增后的新 revision。
   */
  next(): number
}

/**
 * 创建持久化全局 MemoryRevisionClock。
 * 真源为 app_meta.memory_revision（002 迁移建立）。
 */
export function createMemoryRevisionClock(db: Database): MemoryRevisionClock {
  const getStmt = db.prepare(`SELECT value FROM app_meta WHERE key = 'memory_revision'`)
  const updateStmt = db.prepare(`UPDATE app_meta SET value = ? WHERE key = 'memory_revision'`)

  function current(): number {
    const row = getStmt.get() as { value: string } | undefined
    if (!row) return 0
    const v = parseInt(row.value, 10)
    return Number.isInteger(v) ? v : 0
  }

  function next(): number {
    const v = current() + 1
    // 短 DB 事务（可与业务事务同事务，也可独立）
    const txn = db.transaction(() => {
      updateStmt.run(String(v))
    })
    txn()
    return v
  }

  return { current, next }
}
