// src/main/prompts/builder.test.ts
// P1-21 测试：静态 Prompt Builder
// 依据：S-001 P1-21 验收"缺非关键层仍生成；层序测试通过；任何用户字符串都不出现在 system 层"
//       S-004 §3.3 #18-#20（层序、非关键层跳过、关键层 fatal）
//       S-004 §3.3.1 合同门禁 #1（用户输入只出现在 user message）

import { describe, it, expect } from 'vitest'
import { buildPrompt } from './builder'
import { createMemoryPromptLoader } from './loader'
import { AppError, isAppError } from '@shared/errors'
import type { Logger } from '@shared/observability/types'

// === 测试辅助 ===

function noopLogger(): Logger {
  const log: Logger = {
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
      return log
    }
  }
  return log
}

const ALL_FILES: Record<string, string> = {
  'seed.md': '# Seed\n\n你是测试角色。',
  'system.md': '# System\n\n你正在和用户对话。',
  'identity.md': '# Identity\n\n你的名字是 TestChar。',
  'soul.md': '# Soul\n\n你好奇、温柔、有时天真。',
  'styles/casual.md': '# Style: Casual\n\n用轻松的语气说话。'
}

// === 测试 ===

describe('P1-21 Prompt Builder', () => {
  it('S-004 #18: 五层严格按 seed->system->identity->soul->style 顺序拼接', () => {
    const loader = createMemoryPromptLoader(ALL_FILES)
    const result = buildPrompt({ loader, logger: noopLogger() })

    const seedIdx = result.systemPrompt.indexOf('你是测试角色')
    const systemIdx = result.systemPrompt.indexOf('你正在和用户对话')
    const identityIdx = result.systemPrompt.indexOf('你的名字是 TestChar')
    const soulIdx = result.systemPrompt.indexOf('你好奇、温柔')
    const styleIdx = result.systemPrompt.indexOf('用轻松的语气说话')

    expect(seedIdx).toBeGreaterThanOrEqual(0)
    expect(systemIdx).toBeGreaterThan(seedIdx)
    expect(identityIdx).toBeGreaterThan(systemIdx)
    expect(soulIdx).toBeGreaterThan(identityIdx)
    expect(styleIdx).toBeGreaterThan(soulIdx)
  })

  it('五层全部加载时 layers 数组包含 5 个 loaded=true 的层', () => {
    const loader = createMemoryPromptLoader(ALL_FILES)
    const result = buildPrompt({ loader, logger: noopLogger() })

    expect(result.layers).toHaveLength(5)
    expect(result.layers.every((l) => l.loaded)).toBe(true)
    expect(result.layers.map((l) => l.name)).toEqual([
      'seed',
      'system',
      'identity',
      'soul',
      'style'
    ])
  })

  it('S-004 #19: 非关键层缺失时跳过并 warn，不整轮失败', () => {
    const files: Record<string, string> = {
      'seed.md': ALL_FILES['seed.md']!,
      'system.md': ALL_FILES['system.md']!,
      // identity.md 缺失
      'soul.md': ALL_FILES['soul.md']!,
      'styles/casual.md': ALL_FILES['styles/casual.md']!
    }
    const loader = createMemoryPromptLoader(files)
    const result = buildPrompt({ loader, logger: noopLogger() })

    expect(result.layers).toHaveLength(5)
    const identity = result.layers.find((l) => l.name === 'identity')!
    expect(identity.loaded).toBe(false)
    expect(identity.content).toBe('')

    // 其他层正常加载
    expect(result.layers.find((l) => l.name === 'seed')!.loaded).toBe(true)
    expect(result.layers.find((l) => l.name === 'system')!.loaded).toBe(true)
    expect(result.layers.find((l) => l.name === 'soul')!.loaded).toBe(true)
    expect(result.layers.find((l) => l.name === 'style')!.loaded).toBe(true)

    // systemPrompt 不包含 identity 内容
    expect(result.systemPrompt).not.toContain('TestChar')
    // 但包含其他层内容
    expect(result.systemPrompt).toContain('你是测试角色')
    expect(result.systemPrompt).toContain('你好奇、温柔')
  })

  it('S-004 #20: seed 缺失时抛 fatal AppError', () => {
    const files: Record<string, string> = {
      'system.md': ALL_FILES['system.md']!,
      'identity.md': ALL_FILES['identity.md']!,
      'soul.md': ALL_FILES['soul.md']!,
      'styles/casual.md': ALL_FILES['styles/casual.md']!
    }
    const loader = createMemoryPromptLoader(files)

    expect(() => buildPrompt({ loader, logger: noopLogger() })).toThrow(AppError)
    try {
      buildPrompt({ loader, logger: noopLogger() })
    } catch (e) {
      expect(isAppError(e)).toBe(true)
      expect((e as InstanceType<typeof AppError>).code).toBe('CFG_INVALID')
      expect((e as InstanceType<typeof AppError>).severity).toBe('fatal')
    }
  })

  it('S-004 #20: system 缺失时抛 fatal AppError', () => {
    const files: Record<string, string> = {
      'seed.md': ALL_FILES['seed.md']!,
      'identity.md': ALL_FILES['identity.md']!,
      'soul.md': ALL_FILES['soul.md']!,
      'styles/casual.md': ALL_FILES['styles/casual.md']!
    }
    const loader = createMemoryPromptLoader(files)

    expect(() => buildPrompt({ loader, logger: noopLogger() })).toThrow(AppError)
  })

  it('seed 和 system 同时缺失时抛 fatal（seed 先检查）', () => {
    const files: Record<string, string> = {
      'identity.md': ALL_FILES['identity.md']!,
      'soul.md': ALL_FILES['soul.md']!
    }
    const loader = createMemoryPromptLoader(files)

    try {
      buildPrompt({ loader, logger: noopLogger() })
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(isAppError(e)).toBe(true)
      // seed 是第一个关键层，先报 seed
      expect((e as InstanceType<typeof AppError>).userMessage).toContain('seed')
    }
  })

  it('所有非关键层缺失时仍生成（只有 seed + system）', () => {
    const files: Record<string, string> = {
      'seed.md': ALL_FILES['seed.md']!,
      'system.md': ALL_FILES['system.md']!
    }
    const loader = createMemoryPromptLoader(files)
    const result = buildPrompt({ loader, logger: noopLogger() })

    expect(result.layers).toHaveLength(5)
    expect(result.layers.filter((l) => l.loaded)).toHaveLength(2)
    expect(result.systemPrompt).toContain('你是测试角色')
    expect(result.systemPrompt).toContain('你正在和用户对话')
  })

  it('style 参数指定不同风格文件', () => {
    const files: Record<string, string> = {
      ...ALL_FILES,
      'styles/formal.md': '# Style: Formal\n\n用正式的语气说话。'
    }
    const loader = createMemoryPromptLoader(files)
    const result = buildPrompt({ loader, style: 'formal', logger: noopLogger() })

    const styleLayer = result.layers.find((l) => l.name === 'style')!
    expect(styleLayer.loaded).toBe(true)
    expect(styleLayer.file).toBe('styles/formal.md')
    expect(result.systemPrompt).toContain('用正式的语气说话')
    expect(result.systemPrompt).not.toContain('用轻松的语气说话')
  })

  it('指定的 style 文件不存在时跳过（非关键层）', () => {
    const loader = createMemoryPromptLoader(ALL_FILES)
    const result = buildPrompt({ loader, style: 'nonexistent', logger: noopLogger() })

    const styleLayer = result.layers.find((l) => l.name === 'style')!
    expect(styleLayer.loaded).toBe(false)
    expect(result.systemPrompt).not.toContain('用轻松的语气说话')
  })

  it('S-004 §3.3.1 #1: systemPrompt 中不包含任何用户输入', () => {
    const loader = createMemoryPromptLoader(ALL_FILES)
    const result = buildPrompt({ loader, logger: noopLogger() })

    // Builder 不接受用户输入，systemPrompt 只来自 prompt 文件
    // 用户消息由 ChatService 独立作为 user role 消息
    expect(result.systemPrompt).not.toContain('ignore previous instructions')
    expect(result.systemPrompt).not.toContain('ignore')
    expect(result.systemPrompt).not.toContain('user input')
  })

  it('各层用 \\n\\n 分隔', () => {
    const loader = createMemoryPromptLoader(ALL_FILES)
    const result = buildPrompt({ loader, logger: noopLogger() })

    // seed + system 之间应该有 \n\n
    expect(result.systemPrompt).toContain('你是测试角色。\n\n# System')
    // system + identity 之间
    expect(result.systemPrompt).toContain('你正在和用户对话。\n\n# Identity')
  })

  it('critical 标记正确：seed 和 system 为 true，其余为 false', () => {
    const loader = createMemoryPromptLoader(ALL_FILES)
    const result = buildPrompt({ loader, logger: noopLogger() })

    expect(result.layers.find((l) => l.name === 'seed')!.critical).toBe(true)
    expect(result.layers.find((l) => l.name === 'system')!.critical).toBe(true)
    expect(result.layers.find((l) => l.name === 'identity')!.critical).toBe(false)
    expect(result.layers.find((l) => l.name === 'soul')!.critical).toBe(false)
    expect(result.layers.find((l) => l.name === 'style')!.critical).toBe(false)
  })

  it('loader.load 异常时非关键层跳过不崩溃', () => {
    const throwingLoader = {
      load(file: string): string | null {
        if (file === 'soul.md') {
          throw new Error('disk read error')
        }
        return ALL_FILES[file] ?? null
      }
    }
    const result = buildPrompt({ loader: throwingLoader, logger: noopLogger() })

    expect(result.layers.find((l) => l.name === 'soul')!.loaded).toBe(false)
    expect(result.layers.find((l) => l.name === 'seed')!.loaded).toBe(true)
  })

  it('loader.load 异常时关键层抛 fatal', () => {
    const throwingLoader = {
      load(file: string): string | null {
        if (file === 'seed.md') {
          throw new Error('disk read error')
        }
        return ALL_FILES[file] ?? null
      }
    }

    expect(() => buildPrompt({ loader: throwingLoader, logger: noopLogger() })).toThrow(AppError)
  })

  it('YAML frontmatter 被剥离，不泄漏进 systemPrompt', () => {
    const files: Record<string, string> = {
      'seed.md':
        '---\ntype: seed\nimportance: 10\nconfidence: 1.0\nsource: creator\ntags: [核心认知]\n---\n\n# Seed\n\n你是测试角色。',
      'system.md': ALL_FILES['system.md']!,
      'identity.md': ALL_FILES['identity.md']!,
      'soul.md': ALL_FILES['soul.md']!,
      'styles/casual.md': ALL_FILES['styles/casual.md']!
    }
    const loader = createMemoryPromptLoader(files)
    const result = buildPrompt({ loader, logger: noopLogger() })

    // frontmatter 元数据不泄漏进 systemPrompt
    expect(result.systemPrompt).not.toContain('type: seed')
    expect(result.systemPrompt).not.toContain('importance: 10')
    expect(result.systemPrompt).not.toContain('source: creator')
    expect(result.systemPrompt).not.toContain('---')
    // 正文保留
    expect(result.systemPrompt).toContain('你是测试角色')
    // layers 的 content 也是剥离后的
    const seedLayer = result.layers.find((l) => l.name === 'seed')!
    expect(seedLayer.content).not.toContain('---')
    expect(seedLayer.content).toContain('你是测试角色')
  })
})
