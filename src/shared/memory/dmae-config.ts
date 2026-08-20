// src/shared/memory/dmae-config.ts
// P2-31.5A：DMAE 可视化前置门的跨进程配置 DTO 真源。
// 依据：S-005-补充 §1.2（类型真源与依赖方向）、F5-002 §3.5（S-F05 裁定）。
//
// 设计要点：
//   1. shared 不能反向 import main。F5-002 预想把 AnomalyRuleId 放 main-only，
//      但它同时被 shared/config/types、main schema、renderer store、IPC validator 使用，
//      所以必须在 shared 冻结。main 的 anomaly-types.ts / preset-types.ts 只能 re-export。
//   2. ANOMALY_RULE_IDS 元组是唯一真源：默认值、schema、validator、测试均从此派生。
//   3. config 中只存用户预设（builtin:false）；内置预设常驻代码（BUILTIN_PRESETS）。
//   4. muted/windows 默认必须完整列 13 个键（deepMergeWithDefaults 只遍历默认对象已有键）。

// === AnomalyRuleId（13 条规则，顺序固定）===

/**
 * 顺序固定，默认值、schema、validator、测试均从此元组派生/核对。
 * 依据 F5-002 §3.3 的 13 条规则：R01～R13。
 */
export const ANOMALY_RULE_IDS = [
  'R01',
  'R02',
  'R03',
  'R04',
  'R05',
  'R06',
  'R07',
  'R08',
  'R09',
  'R10',
  'R11',
  'R12',
  'R13'
] as const

export type AnomalyRuleId = (typeof ANOMALY_RULE_IDS)[number]

// === 可调参数（maxScore 是 literal 100，不可调）===

export type TunableParam =
  | 'promptThreshold'
  | 'userRewardBase'
  | 'wakeGamma'
  | 'modelRewardBase'
  | 'wakeLambda'
  | 'decayAlpha'
  | 'decayBeta'

// === 预设类型 ===

/** 预设基线字段。内置与用户预设共享，builtin 字面量区分。 */
interface DmaePresetBase {
  id: string
  name: string
  description: string
  baseline: 'default'
  overrides: Partial<Record<TunableParam, number>>
  createdAt: number
  updatedAt: number
}

/** config.json 中唯一允许的预设形状。builtin 字面量 false 阻止内置预设写入用户文件。 */
export interface UserDmaePreset extends DmaePresetBase {
  builtin: false
}

/** 只允许存在于 BUILTIN_PRESETS 代码常量。 */
export interface BuiltinDmaePreset extends DmaePresetBase {
  builtin: true
}

/** UI 合并列表与预设算法使用的联合类型。 */
export type DmaePreset = UserDmaePreset | BuiltinDmaePreset

// === 异常检测窗口与静音 ===

export interface DmaeAnomalyWindow {
  days?: number
  turns?: number
}

/** 标准化运行时配置：13 个键均存在；每个值只含该规则支持的窗口维度。 */
export type DmaeAnomalyWindows = Record<AnomalyRuleId, DmaeAnomalyWindow>
export type DmaeAnomalyMuted = Record<AnomalyRuleId, number>

export interface DmaeAnomalyConfig {
  muted: DmaeAnomalyMuted
  windows: DmaeAnomalyWindows
}

// === 默认值常量（defaults.ts 引用，schema.test 核对）===

/**
 * 静音默认：13 个键全列，值全为 0（未静音）。
 * 依据 S-005-补充 §1.4.1：deepMergeWithDefaults 只遍历默认对象已有键，
 * 若默认为 {}，用户写的 R07 会在重启时被安静丢弃。
 */
export const DEFAULT_ANOMALY_MUTED: DmaeAnomalyMuted = {
  R01: 0,
  R02: 0,
  R03: 0,
  R04: 0,
  R05: 0,
  R06: 0,
  R07: 0,
  R08: 0,
  R09: 0,
  R10: 0,
  R11: 0,
  R12: 0,
  R13: 0
}

/**
 * 窗口默认：逐项来自 F5-002 §3.3 的触发条件。
 * R06/R12/R13 没有统计窗口，保留空对象（schema 拒绝新增 days/turns）。
 */
export const DEFAULT_ANOMALY_WINDOWS: DmaeAnomalyWindows = {
  R01: { days: 3 },
  R02: { days: 7 },
  R03: { days: 3 },
  R04: { turns: 50 },
  R05: { turns: 100 },
  R06: {},
  R07: { turns: 50 },
  R08: { turns: 200 },
  R09: { days: 3 },
  R10: { days: 3, turns: 100 },
  R11: { days: 7 },
  R12: {},
  R13: {}
}

/**
 * 每条规则支持的窗口维度键。schema 与 IPC validator 据此拒绝不支持的维度。
 * 依据 F5-002 §3.3：R06/R12/R13 无窗口；R10 同时支持 days+turns。
 */
export const WINDOW_KEYS: Record<AnomalyRuleId, readonly ('days' | 'turns')[]> = {
  R01: ['days'],
  R02: ['days'],
  R03: ['days'],
  R04: ['turns'],
  R05: ['turns'],
  R06: [],
  R07: ['turns'],
  R08: ['turns'],
  R09: ['days'],
  R10: ['days', 'turns'],
  R11: ['days'],
  R12: [],
  R13: []
}

/**
 * 用户预设 id 正则：preset.user.* 命名空间，避免与内置预设冲突。
 * 内置预设 id 使用 preset.default/tender/present/curious 等。
 */
export const PRESET_ID_REGEX = /^preset\.user\.[A-Za-z0-9_-]{1,64}$/

/**
 * 默认 DMAE 参数（preset 基线）。F5-002 §3.5 baseline='default' 的展开真源。
 * 与 main/config/defaults.ts 的 memory.dmae 默认值对齐；renderer 预设匹配/应用用它解析 baseline。
 * 只读常量，不得被运行时修改。
 */
export const DEFAULT_DMAE_PARAMS = {
  maxScore: 100,
  promptThreshold: 30,
  userRewardBase: 20,
  wakeGamma: 0.5,
  modelRewardBase: 8,
  wakeLambda: 0.3,
  decayAlpha: 1.5,
  decayBeta: 0.3
} as const

/** 可调参数列表（preset 匹配/应用遍历用；不含 maxScore=literal 100） */
export const TUNABLE_PARAMS = [
  'promptThreshold',
  'userRewardBase',
  'wakeGamma',
  'modelRewardBase',
  'wakeLambda',
  'decayAlpha',
  'decayBeta'
] as const

/**
 * 内置预设（唯一真源，shared）。main 的 preset-types.ts 与 renderer 均从此导入，禁止双份复制。
 * Bm/λ 不出现（§2.1 事实 A：被 clamp 完全吃掉）。
 */
export const BUILTIN_PRESETS: BuiltinDmaePreset[] = [
  {
    id: 'preset.default',
    name: '默认',
    description: '先按自然的节奏相处。她会记住最近反复聊到的事，也会让久未提起的细节慢慢淡下去。',
    baseline: 'default',
    overrides: {},
    builtin: true,
    createdAt: 0,
    updatedAt: 0
  },
  {
    id: 'preset.tender',
    name: '温柔体贴',
    description: '她会把你的随口一提放得更久一些。隔了一阵子再聊到，也更容易重新想起来。',
    baseline: 'default',
    overrides: { decayAlpha: 0.3, decayBeta: 0.1, userRewardBase: 25, wakeGamma: 0.8 },
    builtin: true,
    createdAt: 0,
    updatedAt: 0
  },
  {
    id: 'preset.present',
    name: '活在当下',
    description: '她更专注眼前，不急着翻出很久以前的事。只有反复出现的话题，才会留下更清晰的痕迹。',
    baseline: 'default',
    overrides: { decayAlpha: 2.0, wakeGamma: 0.3, promptThreshold: 40 },
    builtin: true,
    createdAt: 0,
    updatedAt: 0
  },
  {
    id: 'preset.curious',
    name: '好奇心强',
    description: '她对新鲜信息更上心。你刚说过的事，再次聊到时更容易被她接住。',
    baseline: 'default',
    overrides: { userRewardBase: 30, wakeGamma: 0.4, promptThreshold: 25 },
    builtin: true,
    createdAt: 0,
    updatedAt: 0
  }
]
