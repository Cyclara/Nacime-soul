// src/main/prompts/builder.ts
// P1-21: Phase 1 静态 Prompt Builder
// 依据：S-001 P1-21、技术分析 §2.3（Cyrene-Agent 5 层静态模块化组装）、S-004 §3.3 #18-#20
//
// 设计要点：
//   1. 五层严格按 seed -> system -> identity -> soul -> style 顺序拼接
//   2. 逐层 try/catch：非关键层缺失跳过并 warn，不整轮失败
//   3. seed/system 为关键层，缺失时抛 fatal AppError
//   4. 用户消息保持独立 user role，不拼入 system（冻结合同 §1.0 注入边界）
//   5. 返回 BuiltPrompt，含 systemPrompt + 各层信息（供 Budgeter 使用）
//
// 安全红线：
//   - 任何用户字符串都不出现在 system 层（S-004 §3.3.1 合同门禁 #1）
//   - Seed 内容尚非最终 S-007，当前为 Phase 1 占位内容

import type { Logger } from '@shared/observability/types'
import { AppError } from '@shared/errors'
import type { PromptLoader } from './loader'

// === 层定义 ===

/** Prompt 层名称 */
export type PromptLayerName = 'seed' | 'system' | 'identity' | 'soul' | 'style'

/** 单层 Prompt 信息 */
export interface PromptLayer {
  /** 层名称 */
  name: PromptLayerName
  /** 文件内容（缺失时为空字符串） */
  content: string
  /** 是否为关键层（缺失 = fatal） */
  critical: boolean
  /** 是否成功加载 */
  loaded: boolean
  /** 相对文件路径 */
  file: string
}

/** Builder 产出的结构化 Prompt */
export interface BuiltPrompt {
  /** 拼接后的 system prompt（各层用 \n\n 分隔） */
  systemPrompt: string
  /** 各层信息（含未加载的层） */
  layers: PromptLayer[]
}

// === 层配置 ===

/**
 * Phase 1 五层配置。顺序 = 拼接顺序。
 * 依据技术分析 §2.3：
 *   seed（初始认知）-> system（固定规则）-> identity（半固定身份）
 *   -> soul（核心性格）-> style（语气风格）
 *
 * 关键层：seed、system（缺失 = fatal 配置错误）
 * 非关键层：identity、soul、style（缺失 = 跳过并 warn）
 */
const LAYER_CONFIG: ReadonlyArray<{
  name: PromptLayerName
  critical: boolean
  /** 文件路径（style 层用 style 参数替换） */
  fileTemplate: string
}> = [
  { name: 'seed', critical: true, fileTemplate: 'seed.md' },
  { name: 'system', critical: true, fileTemplate: 'system.md' },
  { name: 'identity', critical: false, fileTemplate: 'identity.md' },
  { name: 'soul', critical: false, fileTemplate: 'soul.md' },
  { name: 'style', critical: false, fileTemplate: 'styles/{style}.md' }
]

// === Builder ===

/** buildPrompt 选项 */
export interface BuildPromptOptions {
  /** Prompt 文件加载器 */
  loader: PromptLoader
  /** 风格名称（默认 'casual'）。对应 styles/{style}.md */
  style?: string
  /** 日志器 */
  logger: Logger
}

/**
 * 剥离 YAML frontmatter（--- ... ---），返回正文。
 * 文件不以 --- 开头时原样返回。
 *
 * 依据主技术分析 §1.1.2：Seed 文件用 YAML frontmatter 存储元数据
 *（type/importance/confidence/source），这些元数据给 DMAE（Phase 2）用，
 * 不应泄漏进 system prompt 发给 LLM。Phase 1 的 builder 只需剥离 frontmatter，
 * Phase 2 可扩展为解析 frontmatter 提取 importance 等字段给 DMAE 引擎。
 */
function stripFrontmatter(content: string): string {
  if (!content.startsWith('---')) return content
  // 匹配 frontmatter 块：---\r?\n ... \r?\n---
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  if (!match) return content // 格式不完整，原样返回（败而不崩）
  return content.slice(match[0].length)
}

/**
 * 构建 Phase 1 静态 Prompt。
 *
 * 流程：
 *   1. 按 LAYER_CONFIG 顺序逐层加载
 *   2. 每层 try/catch：加载失败时，关键层抛 fatal，非关键层跳过并 warn
 *   3. 将已加载层用 \n\n 拼接为 systemPrompt
 *   4. 返回 BuiltPrompt（含各层信息，供 Budgeter 使用）
 *
 * 用户消息不在此处理：ChatService 将 systemPrompt 作为 system message，
 * 用户消息保持独立 user role（冻结合同 §1.0 注入边界）。
 */
export function buildPrompt(opts: BuildPromptOptions): BuiltPrompt {
  const { loader, style = 'casual', logger } = opts
  const layers: PromptLayer[] = []
  const parts: string[] = []

  for (const config of LAYER_CONFIG) {
    const file = config.fileTemplate.replace('{style}', style)
    let content: string | null = null

    try {
      content = loader.load(file)
    } catch (e) {
      // 加载器异常：视为缺失，下方按 critical 决定是否 fatal
      logger.warn('prompt loader error', {
        scope: 'prompts',
        tags: { layer: config.name, file },
        detail: e instanceof Error ? e.message : String(e)
      })
      content = null
    }

    if (content === null) {
      if (config.critical) {
        // 关键层缺失 = fatal 配置错误（S-004 §3.3 #20）
        throw new AppError({
          code: 'CFG_INVALID',
          userMessage: `关键 Prompt 文件缺失: ${file}`,
          severity: 'fatal',
          retryable: false
        })
      }
      // 非关键层缺失：跳过并 warn（S-004 §3.3 #19）
      logger.warn('prompt layer missing, skipping', {
        scope: 'prompts',
        tags: { layer: config.name, file }
      })
      layers.push({
        name: config.name,
        content: '',
        critical: config.critical,
        loaded: false,
        file
      })
      continue
    }

    const body = stripFrontmatter(content)
    layers.push({
      name: config.name,
      content: body,
      critical: config.critical,
      loaded: true,
      file
    })
    parts.push(body)
  }

  return {
    systemPrompt: parts.join('\n\n'),
    layers
  }
}
