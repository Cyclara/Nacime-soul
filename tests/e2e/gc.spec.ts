// P3G-08：GC 回收站与冷存储的真实跨进程验收。
//
// 覆盖 F5-004 的顺序铁律：soft_deleted 可见可恢复 → 清空时先写冷存储 fsync → 才删热区行。
// 冷存储只保留文本与元数据（无向量），purge 后回收站与 L2 列表都不再出现该条。

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect, _electron as electron } from '@playwright/test'
import {
  createTmpUserData,
  writeMemoryConfig,
  writeFakeApiKey,
  cleanupTmpDir,
  shutdownApp,
  createElectronEnv,
  FAUX_EXTRACTION_ENVELOPE
} from './helpers'

test('P3G-08：软删进回收站→恢复→再清空时先落冷存储后删行', async () => {
  const tmpDir = createTmpUserData()
  writeMemoryConfig(tmpDir)
  writeFakeApiKey(tmpDir)

  const app = await electron.launch({
    args: ['out/main/index.js'],
    env: createElectronEnv({
      COMPANION_TEST_MODE: 'faux',
      COMPANION_FAUX_EXTRACTION: FAUX_EXTRACTION_ENVELOPE,
      COMPANION_USER_DATA: tmpDir
    })
  })

  try {
    const win = await app.firstWindow()
    await win.waitForSelector('textarea', { timeout: 30_000 })
    await win.fill('textarea', '我喜欢收集虚构的蓝色月票')
    await win.click('button:text("发送")')

    // 提取管线后台落库；拿到那条 L2 的真实 id 再走回收站流程。
    // 只匹配不随人称转换变化的片段：落库内容会被转成「你喜欢…」，且列表里还混有 seed 记忆。
    const marker = '虚构的蓝色月票'
    let memoryId: string | null = null
    await expect
      .poll(
        async () => {
          const list = await win.evaluate(() =>
            window.companion.memory.listL2({ limit: 200, offset: 0 })
          )
          if (!list.ok) return `list failed: ${list.error.code}`
          memoryId = list.data.items.find((item) => item.content.includes(marker))?.id ?? null
          return memoryId === null ? list.data.items.map((item) => item.content).join(' | ') : marker
        },
        { timeout: 40_000 }
      )
      .toContain(marker)
    expect(memoryId).not.toBeNull()

    // ── soft delete → 回收站可见 ──
    const softDeleted = await win.evaluate(
      (id) => window.companion.memory.softDelete({ memoryId: id, confirm: true }),
      memoryId!
    )
    expect(softDeleted.ok).toBe(true)

    const binAfterDelete = await win.evaluate(() =>
      window.companion.memory.listRecycleBin({ limit: 50, offset: 0 })
    )
    if (!binAfterDelete.ok) throw new Error('recycle bin list failed')
    expect(binAfterDelete.data.total).toBe(1)
    expect(binAfterDelete.data.items[0]?.id).toBe(memoryId)
    expect(binAfterDelete.data.items[0]?.softDeletedAt).toBeGreaterThan(0)

    // ── 恢复：回到 archived，不再占用回收站 ──
    const restored = await win.evaluate(
      (id) => window.companion.memory.restoreFromRecycleBin({ memoryId: id }),
      memoryId!
    )
    expect(restored.ok).toBe(true)
    const binAfterRestore = await win.evaluate(() =>
      window.companion.memory.listRecycleBin({ limit: 50, offset: 0 })
    )
    expect(binAfterRestore.ok && binAfterRestore.data.total).toBe(0)
    const archivedAgain = await win.evaluate(() =>
      window.companion.memory.listL2({ state: 'archived', limit: 50, offset: 0 })
    )
    if (!archivedAgain.ok) throw new Error('archived list failed')
    expect(archivedAgain.data.items.map((item) => item.id)).toContain(memoryId)

    // ── 再次软删后清空：先冷存储、后删行 ──
    const softDeletedAgain = await win.evaluate(
      (id) => window.companion.memory.softDelete({ memoryId: id, confirm: true }),
      memoryId!
    )
    expect(softDeletedAgain.ok).toBe(true)
    const emptied = await win.evaluate(() =>
      window.companion.memory.emptyRecycleBin({ confirm: true })
    )
    expect(emptied.ok && emptied.data.purged).toBe(1)

    // 冷存储先落盘：index.json 记录该 id，年度 gz 主文件存在。
    const coldDir = join(tmpDir, 'data', 'cold')
    expect(existsSync(join(coldDir, 'index.json'))).toBe(true)
    const coldIndex = JSON.parse(readFileSync(join(coldDir, 'index.json'), 'utf8')) as Array<{
      id: string
      year: number
      keywords: string[]
    }>
    expect(coldIndex.map((entry) => entry.id)).toContain(memoryId)
    expect(readdirSync(coldDir).some((name) => /^\d{4}\.jsonl\.gz$/.test(name))).toBe(true)
    // 冷记录只留文本与元数据；向量不进冷存储。
    expect(readFileSync(join(coldDir, 'index.json'), 'utf8')).not.toContain('embedding')

    // 热区已物理删除：回收站与全部可见状态都查不到。
    const binAfterEmpty = await win.evaluate(() =>
      window.companion.memory.listRecycleBin({ limit: 50, offset: 0 })
    )
    expect(binAfterEmpty.ok && binAfterEmpty.data.total).toBe(0)
    const remaining = await win.evaluate(() =>
      window.companion.memory.listL2({ limit: 200, offset: 0 })
    )
    if (!remaining.ok) throw new Error('l2 list failed')
    expect(remaining.data.items.map((item) => item.id)).not.toContain(memoryId)
  } finally {
    await shutdownApp(app)
    cleanupTmpDir(tmpDir)
  }
})
