// src/main/migrations/registry.ts
// 迁移脚本注册表，id 升序。新增迁移 = 加一行 import + 追加到数组，并同步 EXPECTED_VERSIONS。
// 生产 wiring 把本数组注入 createMigrationRunner。

import type { Migration } from './types'
import { migration as m001 } from './scripts/001_init'
import { migration as m002 } from './scripts/002_extraction_key'
import { migration as m004 } from './scripts/004_dmae_state_v2'

export const MIGRATIONS: Migration[] = [m001, m002, m004]
