// src/main/migrations/registry.ts
// 迁移脚本注册表，id 升序。新增迁移 = 加一行 import + 追加到数组，并同步 EXPECTED_VERSIONS。
// 生产 wiring 把本数组注入 createMigrationRunner。

import type { Migration } from './types'
import { migration as m001 } from './scripts/001_init'
import { migration as m002 } from './scripts/002_extraction_key'
import { migration as m003 } from './scripts/003_dmae_history'
import { migration as m004 } from './scripts/004_dmae_state_v2'
import { migration as m005 } from './scripts/005_dmae_turn_stats'
import { migration as m006 } from './scripts/006_l2_source'
import { migration as m007 } from './scripts/007_l2_pin_edit'
import { migration as m008 } from './scripts/008_search_fts'

export const MIGRATIONS: Migration[] = [m001, m002, m003, m004, m005, m006, m007, m008]
