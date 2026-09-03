// src/main/migrations/atomic-json.ts
// JSON 原子写 + 版本读取。所有 JSON 存储统一走这里（F5-013 §3 规范位置）。
// 从 config/store.ts 上移至此，config/store 经 re-export 保持向后兼容。

import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * 原子写 JSON：写 {file}.tmp -> fsync -> rename -> best-effort fsync 目录。
 * 写入中断不损坏旧文件（rename 在同分区是原子的）。依据 F5-013 §3。
 * 一律用此函数写 JSON 存储，禁止裸 fs.writeFileSync。
 */
export function atomicWriteJson(filePath: string, data: unknown): void {
  const tmpPath = filePath + '.tmp'
  const json = JSON.stringify(data, null, 2) + '\n'
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const fd = fs.openSync(tmpPath, 'w', 0o600)
  try {
    fs.writeFileSync(fd, json, 'utf8')
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  // rename 原子替换（同分区 rename 在 POSIX 和 Windows 上都是原子的）
  fs.renameSync(tmpPath, filePath)
  // best-effort fsync 目录（某些 Windows 文件系统不支持，忽略失败）
  try {
    const dirFd = fs.openSync(path.dirname(filePath), 'r')
    try {
      fs.fsyncSync(dirFd)
    } finally {
      fs.closeSync(dirFd)
    }
  } catch {
    // best-effort：目录 fsync 失败不影响数据完整性（rename 已原子完成）
  }
}

/**
 * 读 JSON 存储的顶层 schemaVersion。
 * 文件缺失/无法读取/JSON 解析失败/字段缺失或非整数，一律视为 0（F5-013 §3）。
 * 用户手工把 schemaVersion 删/改乱时返回 0，由上层走"无法识别"处理。
 *
 * @deprecated 新代码用 {@link readJsonVersion} 区分 missing/invalid/ok 三态。
 *   本函数保留是为了向后兼容（它把 missing 和 invalid 都折叠成 0，无法区分）。
 */
export function getJsonVersion(filePath: string): number {
  const r = readJsonVersion(filePath)
  if (r.kind === 'ok') return r.version
  return 0
}

/**
 * JSON 存储版本读取的三态结果。依据 F5-013 §3（doc:192）：
 * - missing：文件不存在 -> 正常首次初始化
 * - invalid：文件存在但坏了 -> 阻断启动 + 引导恢复（不许猜）
 * - ok：文件可读且 schemaVersion 是合法整数
 *
 * **为什么不在这里判版本号大小**：本函数只回答"文件能不能读、版本字段是不是整数"。
 * 版本号是否匹配 EXPECTED_VERSIONS 是调用方（迁移 runner / store）的职责--
 * runner 需要知道"文件版本 3 但代码期望 4"来决定跑哪条迁移，不能在这里折叠成 invalid。
 */
export type JsonVersionResult =
  | { kind: 'missing' }
  | { kind: 'invalid'; reason: 'unreadable' | 'bad-json' | 'bad-version' }
  | { kind: 'ok'; version: number }

/**
 * 读 JSON 存储的 schemaVersion，区分三态。依据 F5-013 §3。
 *
 * - 文件不存在 -> `{ kind: 'missing' }`（首次启动，正常）
 * - 文件存在但读不了/JSON 语法错 -> `{ kind: 'invalid', reason: 'unreadable' | 'bad-json' }`
 * - schemaVersion 缺失/非整数（如字符串 "1"）-> `{ kind: 'invalid', reason: 'bad-version' }`
 * - 正常 -> `{ kind: 'ok', version }`
 */
export function readJsonVersion(filePath: string): JsonVersionResult {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return { kind: 'missing' }
  }
  let parsed: { schemaVersion?: unknown }
  try {
    parsed = JSON.parse(raw) as { schemaVersion?: unknown }
  } catch {
    return { kind: 'invalid', reason: 'bad-json' }
  }
  if (typeof parsed.schemaVersion === 'number' && Number.isInteger(parsed.schemaVersion)) {
    return { kind: 'ok', version: parsed.schemaVersion }
  }
  return { kind: 'invalid', reason: 'bad-version' }
}

/**
 * 写 JSON 存储的 schemaVersion 字段（不动其余字段）。
 * 供 MigrationRunner 在 JSON 迁移成功后提升版本号，与 db 分支的 setDbVersion 对称。
 * 依据 F5-013 §3 + 2026-08-03 裁定 T-01（JSON 分支版本号写入对称）。
 *
 * 文件不存在或 JSON 语法错 -> 抛错（迁移的 up() 应已产出合法文件，这里是提交确认）。
 */
export function setJsonVersion(filePath: string, version: number): void {
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`setJsonVersion: invalid version ${version}`)
  }
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch (e) {
    throw new Error(
      `setJsonVersion: cannot read ${filePath} (migration up() should have created it): ${
        e instanceof Error ? e.message : String(e)
      }`
    )
  }
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch (e) {
    throw new Error(
      `setJsonVersion: ${filePath} is not valid JSON (migration up() corrupted it?): ${
        e instanceof Error ? e.message : String(e)
      }`
    )
  }
  parsed.schemaVersion = version
  atomicWriteJson(filePath, parsed)
}
