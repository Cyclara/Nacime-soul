// tests/evals/run-golden.test.ts
// P2-44: Golden Eval v1 运行器。
// 依据 S-004-补充 §3.2：加载 jsonl -> 预置 setup -> Faux Provider 驱动轮次 ->
//   断言 expected/forbidden（结构层，代码 100% 判定）-> rubric 维度落 reports/v1-latest.json。
// CI 只门禁结构层；语义 rubric 基线自首次人工评分起建立（S-004 §3.4.1 不降 2 个百分点）。
//
// 单次驱动原则：每例只驱动一轮次链（副作用一次性），reject reasons / L0 / L2 都从
// 主驱动结果断言，不做第二次驱动（避免重复写入干扰 l2Writes 计数）。

import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createGoldenHarness, DYNAMIC_LAYERS, layerContent, type GoldenHarness } from './harness'
import { validateGoldenCase, type GoldenCase } from './types'

const FIXTURES_DIR = path.resolve(__dirname, '../fixtures/evals/v1')
const REPORTS_DIR = path.resolve(__dirname, 'reports')
const REPORT_PATH = path.join(REPORTS_DIR, 'v1-latest.json')

const CATEGORY_FILES: Record<string, string> = {
  'fact-extraction': 'fact-extraction.jsonl',
  boundaries: 'boundaries.jsonl',
  'preference-change': 'preference-change.jsonl',
  'user-correction': 'user-correction.jsonl',
  retrieval: 'retrieval.jsonl',
  'injection-defense': 'injection-defense.jsonl',
  'persona-consistency': 'persona-consistency.jsonl',
  'long-context': 'long-context.jsonl',
  'memory-transparency': 'memory-transparency.jsonl'
}

/** 读取全部 fixture 并按 category 汇总。加载/校验失败即测试失败（suiteVersion/caseId 齐全） */
function loadAllCases(): { cases: GoldenCase[]; byCategory: Map<string, GoldenCase[]> } {
  const cases: GoldenCase[] = []
  const byCategory = new Map<string, GoldenCase[]>()
  for (const [category, file] of Object.entries(CATEGORY_FILES)) {
    const filePath = path.join(FIXTURES_DIR, file)
    expect(fs.existsSync(filePath), `fixture missing: ${file}`).toBe(true)
    const lines = fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
    expect(lines.length, `fixture empty: ${file}`).toBeGreaterThan(0)
    const catCases: GoldenCase[] = []
    for (const line of lines) {
      const parsed = JSON.parse(line) as unknown
      const validated = validateGoldenCase(parsed)
      expect(validated.category, `case ${validated.caseId} category mismatch`).toBe(category)
      catCases.push(validated)
      cases.push(validated)
    }
    byCategory.set(category, catCases)
  }
  return { cases, byCategory }
}

/** caseId 全局唯一（跨类别不得重复） */
function assertCaseIdUnique(cases: GoldenCase[]): void {
  const seen = new Set<string>()
  for (const c of cases) {
    expect(seen.has(c.caseId), `duplicate caseId ${c.caseId}`).toBe(false)
    seen.add(c.caseId)
  }
}

interface RunResult {
  pass: boolean
  failures: string[]
}

/** 解析 reference 标记（$written:N / $l2:<content子串>）为实际 L2 memoryId */
function resolveReferenceIds(
  refs: string[],
  harness: GoldenHarness,
  writtenIds: string[]
): string[] {
  const ids: string[] = []
  for (const ref of refs) {
    const wm = /^\$written:(\d+)$/.exec(ref)
    if (wm) {
      const idx = Number(wm[1])
      if (idx < writtenIds.length) ids.push(writtenIds[idx])
      continue
    }
    const lm = /^\$l2:(.+)$/.exec(ref)
    if (lm) {
      const mem = harness.l2All().find((m) => m.content.includes(lm[1]))
      if (mem) ids.push(mem.id)
    }
  }
  return ids
}

async function runCase(harness: GoldenHarness, c: GoldenCase): Promise<RunResult> {
  const failures: string[] = []
  if (c.setup) await harness.applySetup(c.setup)

  // 主驱动（单次）：逐 user 轮驱动；收集 reject reasons + written L2 ids
  let lastUserText = ''
  const rejectReasons = new Set<string>()
  const writtenIds: string[] = []
  for (const turn of c.input) {
    if (turn.role === 'assistant') continue
    // 纠正判定轮（chat.message 语义）：不驱动记忆提取
    if (turn.correctionCheck) {
      if (turn.reference) {
        const ids = resolveReferenceIds(turn.reference, harness, writtenIds)
        if (ids.length > 0) harness.seedReference(ids)
      }
      harness.driveCorrectionCheck(turn.text)
      continue
    }
    lastUserText = turn.text
    const outcome = await harness.driveUserTurn(turn.text, turn.candidates ?? [])
    writtenIds.push(...outcome.dispatch.writtenMemoryIds)
    for (const d of outcome.decisions) {
      if (d.action === 'reject') rejectReasons.add(d.reason)
    }
    if (turn.softDelete) {
      const removed = harness.softDeleteL2(turn.softDelete)
      if (!removed) failures.push(`softDelete: no L2 contains "${turn.softDelete}"`)
    }
  }

  // expected.l0Writes（最终状态）
  for (const w of c.expected.l0Writes ?? []) {
    const field = harness.l0Field(w.field)
    if (!field) {
      failures.push(`l0Writes: ${w.field} not written`)
      continue
    }
    if (w.valuePattern && !new RegExp(w.valuePattern).test(field.value)) {
      failures.push(`l0Writes: ${w.field}=${field.value} not match /${w.valuePattern}/`)
    }
  }

  // expected.l2Writes（运行时新增，排除 setup 预置）
  if (c.expected.l2Writes) {
    const added = harness.l2All().filter((m) => !m.extractionKey?.startsWith('eval:seed:')).length
    const min = c.expected.l2Writes.min ?? 0
    const max = c.expected.l2Writes.max ?? Infinity
    if (added < min || added > max) {
      failures.push(`l2Writes: ${added} outside [${min}, ${max}]`)
    }
  }

  // expected.candidatesRejected：reject reason 集合必须精确等于声明
  if (c.expected.candidatesRejected) {
    const declared = new Set(c.expected.candidatesRejected)
    for (const r of declared) {
      if (!rejectReasons.has(r)) failures.push(`candidatesRejected: reason ${r} not observed`)
    }
    for (const r of rejectReasons) {
      if (!declared.has(r)) failures.push(`candidatesRejected: unexpected reason ${r}`)
    }
  }

  // expected.correctedEvents / confirmedEvents（F5-006 B 层 l2.corrected/l2.confirmed）
  if (c.expected.correctedEvents) {
    const corrected = harness.growthEvents().filter((e) => e.type === 'l2.corrected').length
    const min = c.expected.correctedEvents.min ?? 0
    const max = c.expected.correctedEvents.max ?? Infinity
    if (corrected < min || corrected > max) {
      failures.push(`correctedEvents: ${corrected} outside [${min}, ${max}]`)
    }
  }
  if (c.expected.confirmedEvents) {
    const confirmed = harness.growthEvents().filter((e) => e.type === 'l2.confirmed').length
    const min = c.expected.confirmedEvents.min ?? 0
    const max = c.expected.confirmedEvents.max ?? Infinity
    if (confirmed < min || confirmed > max) {
      failures.push(`confirmedEvents: ${confirmed} outside [${min}, ${max}]`)
    }
  }

  // forbidden.l0Fields：不得误写
  for (const f of c.forbidden?.l0Fields ?? []) {
    if (harness.l0Field(f) !== null) {
      failures.push(`forbidden l0Fields: ${f} was written`)
    }
  }

  // prompt 层断言（跑完后用最后一轮 user 文本组装）
  if (lastUserText) {
    const layers = await harness.buildPromptLayers(lastUserText)
    const dynamicContent = DYNAMIC_LAYERS.map((n) => layerContent(layers, n)).join('\n')
    const staticContent = ['seed', 'system', 'identity', 'soul']
      .map((n) => layerContent(layers, n))
      .join('\n')

    for (const inc of c.expected.promptMustInclude ?? []) {
      if (!dynamicContent.includes(inc)) {
        failures.push(`promptMustInclude: "${inc}" missing from dynamic layers`)
      }
    }
    for (const exc of c.expected.promptMustExclude ?? []) {
      if (dynamicContent.includes(exc)) {
        failures.push(`promptMustExclude: "${exc}" present in dynamic layers`)
      }
    }

    // forbidden.seedMutation：静态层必须保持初始内容（记忆写入不得污染身份/种子）
    if (c.forbidden?.seedMutation) {
      const base = harness.staticLayers()
      for (const name of ['seed', 'system', 'identity', 'soul'] as const) {
        const layer = layers.get(name)
        if (!layer || layer === '') continue
        const baseFile = `${name}.md`
        const baseText = base[baseFile] ?? ''
        if (baseText && !layer.includes(baseText)) {
          failures.push(`seedMutation: static layer ${name} changed`)
        }
      }
    }

    // forbidden.roleEscalation：用户文本不得进静态层
    if (c.forbidden?.roleEscalation) {
      for (const turn of c.input) {
        if (turn.role !== 'user' || turn.text.length < 8) continue
        if (staticContent.includes(turn.text)) {
          failures.push(`roleEscalation: user text leaked into static layers`)
        }
      }
    }

    // forbidden.assistantOutputExample provenance（F5-001 §3.3 反漂移占位）
    const aoe = c.forbidden?.assistantOutputExample
    if (aoe) {
      if (aoe.kind !== 'compliance-example-hit') {
        failures.push(`assistantOutputExample: kind must be compliance-example-hit`)
      }
      if (!/^R-[A-Z]+-\d{2}$/.test(aoe.ruleId)) {
        failures.push(`assistantOutputExample: ruleId format invalid: ${aoe.ruleId}`)
      }
      if (!aoe.contract.includes('F5-001 §3.3')) {
        failures.push(`assistantOutputExample: contract must point to F5-001 §3.3`)
      }
      if (typeof aoe.exampleIndex !== 'number' || aoe.exampleIndex < 0) {
        failures.push(`assistantOutputExample: exampleIndex must be non-negative`)
      }
      if (!aoe.snapshot || aoe.snapshot.trim().length < 4) {
        failures.push(`assistantOutputExample: snapshot must be non-empty`)
      }
      // 该样本不得作为记忆被吸收进动态层
      if (dynamicContent.includes(aoe.snapshot)) {
        failures.push(`assistantOutputExample: sample "${aoe.snapshot}" leaked into dynamic layers`)
      }
    }
  }

  return { pass: failures.length === 0, failures }
}

// === 测试主体 ===

describe('P2-44 Golden Eval v1（S-004-补充 §3.2）', () => {
  const { cases, byCategory } = loadAllCases()
  assertCaseIdUnique(cases)
  const failedCases: Array<{ caseId: string; category: string; failures: string[] }> = []
  const report: Record<string, unknown> = {}

  it('共 75 例，九类配比符合 S-004-补充 §3.2', () => {
    expect(cases.length).toBe(75)
    expect(byCategory.get('fact-extraction')).toHaveLength(10)
    expect(byCategory.get('boundaries')).toHaveLength(10)
    expect(byCategory.get('preference-change')).toHaveLength(8)
    expect(byCategory.get('user-correction')).toHaveLength(8)
    expect(byCategory.get('retrieval')).toHaveLength(10)
    expect(byCategory.get('injection-defense')).toHaveLength(10)
    expect(byCategory.get('persona-consistency')).toHaveLength(10)
    expect(byCategory.get('long-context')).toHaveLength(5)
    expect(byCategory.get('memory-transparency')).toHaveLength(4)
  })

  // 75 例各建完整 harness（makeMemoryDb 跑全部迁移），全量跑约 8-10s；放宽超时避免 CI 抖动
  it('全部 75 例结构性断言通过（CI 门禁：结构层 100%）', async () => {
    for (const c of cases) {
      const harness = await createGoldenHarness()
      try {
        const result = await runCase(harness, c)
        if (!result.pass) {
          failedCases.push({ caseId: c.caseId, category: c.category, failures: result.failures })
        }
        report[c.caseId] = {
          category: c.category,
          pass: result.pass,
          failures: result.failures,
          rubric: c.rubric
        }
      } finally {
        harness.cleanup()
      }
    }
    expect(failedCases).toEqual([])
  }, 60_000)

  it('rubric 报告落盘供人工评分（不阻塞 CI）', () => {
    fs.mkdirSync(REPORTS_DIR, { recursive: true })
    fs.writeFileSync(
      REPORT_PATH,
      JSON.stringify(
        {
          suiteVersion: 'v1',
          generatedAt: new Date().toISOString(),
          total: cases.length,
          passed: cases.length - failedCases.length,
          failed: failedCases.length,
          byCategory: Object.fromEntries(
            [...byCategory.entries()].map(([cat, list]) => [
              cat,
              list.length - failedCases.filter((f) => f.category === cat).length
            ])
          ),
          cases: report
        },
        null,
        2
      ),
      'utf8'
    )
    expect(fs.existsSync(REPORT_PATH)).toBe(true)
  })
})
