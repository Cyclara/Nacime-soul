// P3X-01：迁移 010 为 dmae_turns 的预算后实际注入真值增加四列。

import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { migration as m003 } from './003_dmae_history'
import { migration as m005 } from './005_dmae_turn_stats'
import { migration as m010 } from './010_dmae_prompt_truth'

const noop = {
  fatal() {
    /* noop */
  },
  error() {
    /* noop */
  },
  warn() {
    /* noop */
  },
  info() {
    /* noop */
  },
  debug() {
    /* noop */
  },
  child() {
    return this
  }
}

describe('010_dmae_prompt_truth', () => {
  it('保留既有 dmae_turns 数据，并新增最终预算真值列', async () => {
    const db = new Database(':memory:')
    const context = { db, dataDir: '', log: noop, dryRun: false }
    await m003.up(context)
    await m005.up(context)
    db.prepare(
      `INSERT INTO dmae_turns (turn, ts, eligible_active, retrieval_hits, prompt_selected, max_active, user_hits, model_hits, model_hits_gated, model_reward_raw_sum, model_reward_effective_sum, total_decay, floor_revivals, true_floor_revivals, params_hash) VALUES (1,1,1,1,1,15,0,0,0,0,0,0,0,0,'hash')`
    ).run()

    await m010.up(context)
    expect((await m010.validate(context)).ok).toBe(true)
    expect(
      db
        .prepare(
          `SELECT prompt_included, prompt_trimmed, prompt_included_ids_json, prompt_trimmed_ids_json FROM dmae_turns WHERE turn=1`
        )
        .get()
    ).toEqual({
      prompt_included: null,
      prompt_trimmed: null,
      prompt_included_ids_json: null,
      prompt_trimmed_ids_json: null
    })
    db.close()
  })
})
