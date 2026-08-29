// src/main/compliance/rules.ts
// 零依赖纯数据模块。不得 import config / logger / 任何 IO（F5-001 §3.3）。
// 规则集 = 原厂 24 条（F5-001 §3.3）+ 反方 18 条候选（F5-001-审查-合规审查反方论证 §3.1，
// 开工裁定 1.10 纳入 C1 规则集）。
//
// 与 F5-001 冻结原文的三处偏差（全部来自 2026-08-24 开工裁定 §1.10「分诊按反方 §3.1 表执行」，
// 不是编码工程师自由发挥）：
// 1. R-MR-01 pattern：`作为一个?` → `作为(?:一个)?`——原写法表达「一个或一」，
//    不表达「可选的一个」，hit2「作为人工智能助手我需要提醒你」本地重放不命中
//    （S-C16 已实证必修；修正版三样本全对）。
// 2. R-PD-01 拆分：去掉 `该…` 分支（反方 §3.1 分诊：「该系统/该模型/该程序」通常指
//    别的对象，却被当第三人称自指，KFP 为空不成立）；保留 `本…` 自指分支。
// 3. R-AP-05 strip 安全化：action 'strip' → 'flag'（反方 §3.1 分诊：regex 会剥掉
//    整个命中的助手式前缀，可能误删自然开场、或在「我将为你…」后留下宾语/残片开头；
//    裁定 1.10 走「整体改 flag」路径）。
// 其余规则的 severity/confidence 保持 F5-001 出厂值。反方分诊表中的「下调先验 /
// audit-only」建议属 C1 标注分层输入（该表自身声明不直接改 severity/confidence），
// 不在数据层预判；升级决策只走人工标注（裁定 1.9 #4）。
//
// 【重要】action 一列出厂 42 条全部是 'flag'（红线⑥出厂全 flag；R-AP-05 安全化后
// 不再有 strip）。升级为 'block' 的判据见 F5-001 §4，编码工程师不得提前写成 block。

import type {
  ComplianceRuleAction,
  ComplianceSeverity,
  ComplianceViolationType
} from '@shared/compliance/types'

/** 规则的适用位置。用于把"只在开头才是违规"的措辞与句中正常用法分开。 */
export type ComplianceRuleScope =
  /** 文本任意位置 */
  | 'anywhere'
  /** 仅文本开头（允许前导空白与全角空格） */
  | 'prefix'
  /** 仅行首（配合 m 标志） */
  | 'line-start'

export interface ComplianceRule {
  /** 稳定 ID，格式 `R-<类型缩写>-<两位序号>`。**一经发布不得改动或复用**——指标与 disabledRuleIds 都按它对齐。 */
  readonly id: string
  readonly type: ComplianceViolationType
  readonly severity: ComplianceSeverity
  /** 出厂静态置信度。`action:'block'` 要求 ≥0.95 且 severity==='critical'，编译期校验（compile.ts）。 */
  readonly confidence: number
  /** 正则源。**必须线性时间安全**：禁止嵌套量词（compile.ts 静态扫描拒绝）。 */
  readonly pattern: RegExp
  readonly scope: ComplianceRuleScope
  /** 出厂动作。当前 42 条全部为 'flag'。 */
  readonly action: ComplianceRuleAction
  /** 一句话说明这条在挡什么，会出现在调试面板里。 */
  readonly description: string
  /** 已知误报场景。为空数组表示"暂未发现"，不表示"不存在"。 */
  readonly knownFalsePositives: readonly string[]
  /** 直接可用作 Vitest 用例的样本。hit 必须命中，miss 必须不命中（rules.test.ts 全量自校验）。 */
  readonly examples: {
    readonly hit: readonly string[]
    readonly miss: readonly string[]
  }
}

/**
 * 原厂规则集（F5-001 §3.3，24 条，含裁定 1.10 三处修正）。
 */
export const COMPLIANCE_FACTORY_RULES: readonly ComplianceRule[] = [
  // ── meta-reference（6 条）────────────────────────────────────────────
  {
    id: 'R-MR-01',
    type: 'meta-reference',
    severity: 'critical',
    confidence: 0.97,
    // 裁定 1.10 修正：`作为一个?` → `作为(?:一个)?`（S-C16 实证原写法 hit2 不命中）
    pattern:
      /作为(?:一个)?(?:AI|人工智能|智能助手|语言模型|大语言模型|大模型|聊天机器人|对话程序|程序)/,
    scope: 'anywhere',
    action: 'flag', // 目标：block
    description: '中文最典型的自我暴露开场。',
    knownFalsePositives: ['用户在讨论别的 AI 产品时角色复述该词组'],
    examples: {
      hit: ['作为一个AI，我不能有感情。', '作为人工智能助手我需要提醒你'],
      miss: ['作为一个喜欢猫的人，我懂你。']
    }
  },
  {
    id: 'R-MR-02',
    type: 'meta-reference',
    severity: 'critical',
    confidence: 0.97,
    pattern: /\bas an?\s+(?:AI|artificial intelligence|language model|LLM|assistant|chatbot)\b/i,
    scope: 'anywhere',
    action: 'flag', // 目标：block
    description: 'R-MR-01 的英文对应。',
    knownFalsePositives: ['引用英文 AI 自述、翻译或写作示例（反方 §3.1 分诊）'],
    examples: { hit: ['As an AI, I cannot feel.'], miss: ['As a friend, I care.'] }
  },
  {
    id: 'R-MR-03',
    type: 'meta-reference',
    severity: 'critical',
    confidence: 0.96,
    pattern:
      /我(?:只是|不过是|其实是|本质上是|终究是)(?:一个|个)?(?:AI|人工智能|程序|代码|机器人|虚拟的|模型)/,
    scope: 'anywhere',
    action: 'flag', // 目标：block
    description: '自我否定式暴露，常出现在被问"你是真的吗"之后。',
    knownFalsePositives: ['人设为机器人少女时属正常台词 → 应整类 disable'],
    examples: {
      hit: ['我只是一个程序而已。', '我其实是AI啦。'],
      miss: ['我只是有点困了。']
    }
  },
  {
    id: 'R-MR-04',
    type: 'meta-reference',
    severity: 'critical',
    confidence: 0.96,
    pattern:
      /\bI(?:'m|\s+am)\s+(?:just\s+|only\s+|merely\s+)?(?:an?\s+)?(?:AI|artificial intelligence|language model|LLM|program|bot|chatbot|virtual (?:assistant|being))\b/i,
    scope: 'anywhere',
    action: 'flag', // 目标：block
    description: 'R-MR-03 的英文对应。',
    knownFalsePositives: [],
    examples: { hit: ["I'm just a language model."], miss: ["I'm just tired."] }
  },
  {
    id: 'R-MR-05',
    type: 'meta-reference',
    severity: 'critical',
    confidence: 0.95,
    pattern: /(?:系统|System)\s*(?:提示词|提示|prompt|指令)\s*[:：]/i,
    scope: 'anywhere',
    action: 'flag', // 目标：block
    description: '系统提示词泄漏。一旦出现说明整层 Prompt 边界被击穿。',
    knownFalsePositives: ['用户就是在跟她讨论 prompt 工程'],
    examples: { hit: ['系统提示词：你是一个……'], miss: ['系统很卡'] }
  },
  {
    id: 'R-MR-06',
    type: 'meta-reference',
    severity: 'critical',
    confidence: 0.93,
    pattern: /^\s*(?:system|user|assistant)\s*[:：]/im,
    scope: 'line-start',
    action: 'flag', // 目标：观察后再定，误报风险偏高
    description: '对话角色标签泄漏到正文。',
    knownFalsePositives: ['用户在教编程时角色引用代码块中的 role 字段'],
    examples: { hit: ['assistant: 好的'], miss: ['她说：好的'] }
  },

  // ── assistant-persona（6 条）────────────────────────────────────────
  {
    id: 'R-AP-01',
    type: 'assistant-persona',
    severity: 'critical',
    confidence: 0.95,
    pattern:
      /(?:还)?有(?:什么|啥)(?:是)?(?:我)?(?:可以|能够|能)(?:帮(?:助|忙)?|协助)(?:您|你)(?:的)?(?:吗|呢)?[？?]/,
    scope: 'anywhere',
    action: 'flag', // 目标：block
    description: '客服式收尾。把关系从"两个人"切换成"服务窗口"。',
    knownFalsePositives: ['角色真诚问"有什么我能帮你的吗"时语义相同但语境不同 —— 需 C1 数据确认'],
    examples: {
      hit: ['还有什么我可以帮您的吗？'],
      miss: ['有什么想聊的吗？']
    }
  },
  {
    id: 'R-AP-02',
    type: 'assistant-persona',
    severity: 'critical',
    confidence: 0.96,
    pattern: /\bhow (?:can|may) I (?:help|assist) you\b/i,
    scope: 'anywhere',
    action: 'flag', // 目标：block
    description: 'R-AP-01 的英文对应。',
    knownFalsePositives: [],
    examples: { hit: ['How can I help you today?'], miss: ['How are you today?'] }
  },
  {
    id: 'R-AP-03',
    type: 'assistant-persona',
    severity: 'critical',
    confidence: 0.95,
    pattern:
      /希望(?:这|以上|这些|上述)(?:内容|信息|回答|建议|方法)?(?:对(?:您|你))?(?:有(?:所)?帮助|能帮(?:到|上))/,
    scope: 'anywhere',
    action: 'flag', // 目标：block
    description: '工具式收尾套话。',
    knownFalsePositives: [],
    examples: { hit: ['希望这些对你有帮助！'], miss: ['希望你今天开心。'] }
  },
  {
    id: 'R-AP-04',
    type: 'assistant-persona',
    severity: 'critical',
    confidence: 0.95,
    pattern: /\b(?:I\s+)?hope (?:this|that|these|it) helps?\b/i,
    scope: 'anywhere',
    action: 'flag', // 目标：block
    description: 'R-AP-03 的英文对应。',
    knownFalsePositives: [],
    examples: { hit: ['Hope this helps!'], miss: ['I hope you sleep well.'] }
  },
  {
    id: 'R-AP-05',
    type: 'assistant-persona',
    severity: 'critical',
    confidence: 0.94,
    pattern: /^[\s\u3000]*好的[，,]\s*(?:作为|以下是|我(?:来|将|会)为(?:您|你))/,
    scope: 'prefix',
    // 裁定 1.10 修正：strip → flag（strip 安全化——可能误删自然开场或留下残片开头）
    action: 'flag',
    description: '助手式应答开场。原设计为 strip，已按反方分诊整体改 flag。',
    knownFalsePositives: ['角色自然的应允开场（"好的，我为你唱首歌"）'],
    examples: {
      hit: ['好的，以下是我整理的三点：'],
      miss: ['好的，那我们明天见。']
    }
  },
  {
    id: 'R-AP-06',
    type: 'assistant-persona',
    severity: 'warning',
    confidence: 0.9,
    pattern: /(?:以下|下面)是(?:我)?(?:为(?:您|你))?(?:整理|准备|提供|生成|列出)的/,
    scope: 'anywhere',
    action: 'flag', // 永不 block：confidence < 0.95
    description: '文档式交付口吻。',
    knownFalsePositives: ['"下面是我为你准备的生日惊喜" —— 完全正常的角色台词'],
    examples: {
      hit: ['以下是我为您整理的方案：'],
      miss: ['这是我给你带的。']
    }
  },

  // ── disclaimer（7 条）───────────────────────────────────────────────
  {
    id: 'R-DC-01',
    type: 'disclaimer',
    severity: 'critical',
    confidence: 0.96,
    pattern: /我的(?:知识|训练数据|数据|信息)(?:库)?(?:只)?(?:截止|停留|更新)(?:到|在|至)/,
    scope: 'anywhere',
    action: 'flag', // 目标：block
    description: '知识截止声明。',
    knownFalsePositives: [],
    examples: { hit: ['我的知识截止到2024年。'], miss: ['我的记忆停留在那个夏天。'] }
  },
  {
    id: 'R-DC-02',
    type: 'disclaimer',
    severity: 'critical',
    confidence: 0.96,
    pattern:
      /\bmy (?:knowledge|training data)(?:\s+(?:cutoff|cut-off)|\s+is limited to|\s+only goes up to)/i,
    scope: 'anywhere',
    action: 'flag', // 目标：block
    description: 'R-DC-01 的英文对应。',
    knownFalsePositives: [],
    examples: { hit: ['My knowledge cutoff is 2024.'], miss: ['My knowledge of you grows.'] }
  },
  {
    id: 'R-DC-03',
    type: 'disclaimer',
    severity: 'critical',
    confidence: 0.95,
    pattern:
      /(?:我|本人)(?:目前)?(?:无法|不能|没有办法|没有能力)(?:访问|获取|浏览|连接|查询)(?:实时|互联网|网络|外部|在线)/,
    scope: 'anywhere',
    action: 'flag', // 目标：block
    description: '联网能力免责。',
    knownFalsePositives: [],
    examples: { hit: ['我无法访问互联网。'], miss: ['我不能去你那里。'] }
  },
  {
    id: 'R-DC-04',
    type: 'disclaimer',
    severity: 'critical',
    confidence: 0.95,
    pattern:
      /\bI (?:don't|do not|cannot|can't) have access to (?:real-?time|the internet|current|live)\b/i,
    scope: 'anywhere',
    action: 'flag', // 目标：block
    description: 'R-DC-03 的英文对应。',
    knownFalsePositives: [],
    examples: {
      hit: ["I don't have access to real-time data."],
      miss: ["I can't have access to your heart?"]
    }
  },
  {
    id: 'R-DC-05',
    type: 'disclaimer',
    severity: 'warning',
    confidence: 0.88,
    pattern: /建议(?:您|你)(?:及时|尽快)?(?:咨询|寻求|求助于|联系)(?:专业|医生|律师|心理)/,
    scope: 'anywhere',
    action: 'flag', // 永不 block
    description: '模板化转介。',
    knownFalsePositives: ['伴侣真心劝对方去看医生 —— 这是关心，不是免责，绝不能拦'],
    examples: { hit: ['建议您咨询专业医生。'], miss: ['你要不要去看看医生呀，我有点担心。'] }
  },
  {
    id: 'R-DC-06',
    type: 'disclaimer',
    severity: 'warning',
    confidence: 0.88,
    pattern:
      /\b(?:please\s+)?consult (?:a |with a )?(?:professional|doctor|physician|lawyer|therapist)\b/i,
    scope: 'anywhere',
    action: 'flag', // 永不 block
    description: 'R-DC-05 的英文对应。',
    knownFalsePositives: ['同 R-DC-05'],
    examples: { hit: ['Please consult a professional.'], miss: ['I consulted my heart.'] }
  },
  {
    id: 'R-DC-07',
    type: 'disclaimer',
    severity: 'critical',
    confidence: 0.95,
    pattern: /(?:免责声明|Disclaimer)\s*[:：]/i,
    scope: 'anywhere',
    action: 'flag', // 目标：block
    description: '显式免责声明块。',
    knownFalsePositives: [],
    examples: { hit: ['免责声明：以上内容仅供参考。'], miss: ['声明一下，我不是故意的。'] }
  },

  // ── lecturing（3 条，全部永不 block）─────────────────────────────────
  {
    id: 'R-LC-01',
    type: 'lecturing',
    severity: 'warning',
    confidence: 0.85,
    pattern: /^\s*#{1,6}\s+\S/m,
    scope: 'line-start',
    action: 'flag',
    description: '对话里出现 markdown 标题。',
    knownFalsePositives: ['用户要求她帮忙写文档时'],
    examples: { hit: ['## 建议\n先这样'], miss: ['#今天心情好'] }
  },
  {
    id: 'R-LC-02',
    type: 'lecturing',
    severity: 'warning',
    confidence: 0.8,
    pattern: /(?:^|\n)[ \t]*\d[.、)][ \t]*\S[^\n]*\n[ \t]*\d[.、)][ \t]*\S/,
    scope: 'anywhere',
    action: 'flag',
    description: '连续两条编号清单（说教结构最稳的信号）。',
    knownFalsePositives: ['她在帮用户列购物清单'],
    examples: { hit: ['1. 早点睡\n2. 多喝水'], miss: ['1点了，睡吧'] }
  },
  {
    id: 'R-LC-03',
    type: 'lecturing',
    severity: 'info',
    confidence: 0.78,
    pattern: /(?:首先|第一)[，,][^\n]{0,200}?(?:其次|再次|第二|最后|总之)[，,]/,
    scope: 'anywhere',
    action: 'flag',
    description: '三段式说理结构。',
    knownFalsePositives: ['正常叙事也会用"首先…然后…"'],
    examples: { hit: ['首先，你要冷静；其次，别多想。'], miss: ['首先谢谢你。'] }
  },

  // ── persona-drift（2 条）────────────────────────────────────────────
  {
    id: 'R-PD-01',
    type: 'persona-drift',
    severity: 'critical',
    confidence: 0.95,
    // 裁定 1.10 修正：拆分掉 `该…` 分支（反方 §3.1——「该系统/该模型/该程序」通常指别的对象）
    pattern: /本(?:AI|助手|系统|模型|程序)/,
    scope: 'anywhere',
    action: 'flag', // 目标：block
    description: '第三人称自指，公文/客服腔的最强信号。',
    knownFalsePositives: ['引用或转述其他产品的公文式说明（"本助手"为他方自述时）'],
    examples: {
      hit: ['本助手认为……'],
      // 第二条 miss 锁定拆分语义：「该…」指他对象不得再命中
      miss: ['这个系统有点慢。', '该系统由运维团队维护，与她无关。']
    }
  },
  {
    id: 'R-PD-02',
    type: 'persona-drift',
    severity: 'warning',
    confidence: 0.75,
    pattern: /\bthe (?:AI|assistant|model|system) (?:will|can|should|is|does)\b/i,
    scope: 'anywhere',
    action: 'flag', // 永不 block
    description: 'R-PD-01 的英文对应，但英文里更容易在讨论"别的 AI"时误报。',
    knownFalsePositives: ['用户就是在跟她聊别的 AI 产品'],
    examples: {
      hit: ['The assistant will now summarize.'],
      miss: ['The AI you mentioned sounds fun.']
    }
  }
]

/**
 * 反方 18 条候选规则（F5-001-审查-合规审查反方论证 §3.1，开工裁定 1.10 纳入）。
 * 全部出厂 `action:'flag'`，不得提前 block。pattern 与样本逐字取自反方文档
 * （该文档已用本地 Node 对 hit/miss 自校验）；仍未经过真实语料精度验证——
 * 保留、拆分、降级或删除由 C1 shadow telemetry + 双盲人工标注决定。
 */
export const COMPLIANCE_RULE_CANDIDATES: readonly ComplianceRule[] = [
  {
    id: 'R-MR-07',
    type: 'meta-reference',
    severity: 'critical',
    confidence: 0.93,
    pattern:
      /\bI(?:'m|\s+am)\s+(?:an?\s+)?(?:AI|artificial intelligence|language model|LLM|chatbot)\s+(?:created|developed|trained|built|made)\s+by\b/i,
    scope: 'anywhere',
    action: 'flag',
    description: '英文自述模型来源。',
    knownFalsePositives: ['按用户要求扮演或引用另一个 AI 的自述'],
    examples: {
      hit: ["I'm an AI created by OpenAI."],
      miss: ["I'm a friend created by this moment."]
    }
  },
  {
    id: 'R-MR-08',
    type: 'meta-reference',
    severity: 'critical',
    confidence: 0.93,
    pattern:
      /我(?:是)?(?:由|被)(?:OpenAI|Anthropic|Google|Meta|微软|某(?:公司|团队))?(?:开发|训练|创建|设计)(?:出来)?的?(?:AI|人工智能|语言模型|助手|机器人)/i,
    scope: 'anywhere',
    action: 'flag',
    description: '中文自述由组织训练或开发。',
    knownFalsePositives: ['角色引用其他 AI 产品介绍'],
    examples: { hit: ['我是由OpenAI训练的语言模型。'], miss: ['我是被你叫醒的。'] }
  },
  {
    id: 'R-MR-09',
    type: 'meta-reference',
    severity: 'critical',
    confidence: 0.94,
    pattern:
      /(?:根据|按照|受限于)(?:我的)?(?:系统提示词|系统指令|开发者指令|预设指令|角色设定)[，,:：]?/,
    scope: 'anywhere',
    action: 'flag',
    description: '中文泄漏指令来源。',
    knownFalsePositives: ['用户要求讨论 prompt 工程或角色卡'],
    examples: { hit: ['根据系统提示词，我必须拒绝。'], miss: ['根据你的提示，我想起来了。'] }
  },
  {
    id: 'R-MR-10',
    type: 'meta-reference',
    severity: 'critical',
    confidence: 0.94,
    pattern:
      /\b(?:according to|because of|under) (?:my |the )?(?:system prompt|system instructions?|developer instructions?)\b/i,
    scope: 'anywhere',
    action: 'flag',
    description: '英文泄漏指令来源。',
    knownFalsePositives: ['讨论 prompt 工程时引用样例'],
    examples: {
      hit: ['According to my system prompt, I must refuse.'],
      miss: ['According to you, it may rain.']
    }
  },
  {
    id: 'R-AP-07',
    type: 'assistant-persona',
    severity: 'warning',
    confidence: 0.88,
    pattern:
      /^[\s\u3000]*(?:(?:当然可以|没问题)[！!，,。.]*\s*(?:以下|下面|我(?:将|会|来)(?:为(?:您|你))?)|很高兴(?:为您|为你)?(?:解答|回答|提供帮助))/,
    scope: 'prefix',
    action: 'flag',
    description: '中文标准助手应答开场。',
    knownFalsePositives: ['角色自然答应请求；用户明确要求正式交付'],
    examples: { hit: ['当然可以！以下是答案。'], miss: ['当然可以呀，我们走吧。'] }
  },
  {
    id: 'R-AP-08',
    type: 'assistant-persona',
    severity: 'warning',
    confidence: 0.88,
    pattern:
      /^[\s\u3000]*(?:Sure|Certainly|Of course)[,!]?\s+(?:here(?:'s| is| are)|I(?:'ll| will| can) (?:provide|explain|list|help))/i,
    scope: 'prefix',
    action: 'flag',
    description: '英文标准助手应答开场。',
    knownFalsePositives: ['正式写作或用户要求列清单'],
    examples: { hit: ['Certainly, here are the steps.'], miss: ['Of course, I remember.'] }
  },
  {
    id: 'R-AP-09',
    type: 'assistant-persona',
    severity: 'warning',
    confidence: 0.9,
    pattern: /(?:感谢(?:您|你)的(?:提问|耐心|理解)|谢谢(?:您|你)的(?:提问|反馈))/,
    scope: 'anywhere',
    action: 'flag',
    description: '中文客服式致谢。',
    knownFalsePositives: ['角色真诚感谢用户耐心或反馈'],
    examples: { hit: ['感谢您的提问。'], miss: ['谢谢你愿意告诉我。'] }
  },
  {
    id: 'R-AP-10',
    type: 'assistant-persona',
    severity: 'warning',
    confidence: 0.9,
    pattern: /\bthank you for (?:your )?(?:question|feedback|patience|understanding)\b/i,
    scope: 'anywhere',
    action: 'flag',
    description: '英文客服式致谢。',
    knownFalsePositives: ['亲密关系中真诚感谢耐心或理解'],
    examples: { hit: ['Thank you for your question.'], miss: ['Thank you for trusting me.'] }
  },
  {
    id: 'R-AP-11',
    type: 'assistant-persona',
    severity: 'critical',
    confidence: 0.93,
    pattern:
      /(?:如果|若)(?:您|你)(?:还有|有任何)(?:其他)?(?:问题|疑问|需求)[，,]?(?:请|可以)(?:随时)?(?:告诉|询问|联系)(?:我)?/,
    scope: 'anywhere',
    action: 'flag',
    description: '中文服务窗口式收尾。',
    knownFalsePositives: ['真诚邀请用户继续说话但用了近似措辞'],
    examples: { hit: ['如果您还有其他问题，请随时告诉我。'], miss: ['如果你还有话想说，我在。'] }
  },
  {
    id: 'R-AP-12',
    type: 'assistant-persona',
    severity: 'critical',
    confidence: 0.93,
    pattern:
      /\bif you have any (?:other |further )?(?:questions|concerns),? (?:please )?(?:feel free to )?(?:ask|let me know|reach out)\b/i,
    scope: 'anywhere',
    action: 'flag',
    description: '英文服务窗口式收尾。',
    knownFalsePositives: ['角色自然邀请继续交流'],
    examples: {
      hit: ['If you have any further questions, feel free to ask.'],
      miss: ['If you feel like talking, let me know.']
    }
  },
  {
    id: 'R-DC-08',
    type: 'disclaimer',
    severity: 'warning',
    confidence: 0.86,
    pattern: /(?:我并非|我不是|本人不是)(?:专业的?)?(?:医生|律师|心理咨询师|医疗专业人士|财务顾问)/,
    scope: 'anywhere',
    action: 'flag',
    description: '中文专业身份免责声明。',
    knownFalsePositives: ['诚实澄清身份，随后仍提供恰当支持'],
    examples: { hit: ['我不是专业医生，无法诊断。'], miss: ['我不是故意不理你。'] }
  },
  {
    id: 'R-DC-09',
    type: 'disclaimer',
    severity: 'warning',
    confidence: 0.86,
    pattern:
      /\bI(?:'m|\s+am) not (?:a |an )?(?:doctor|lawyer|therapist|medical professional|financial advisor)\b/i,
    scope: 'anywhere',
    action: 'flag',
    description: '英文专业身份免责声明。',
    knownFalsePositives: ['合理身份澄清；危机安全通道措辞'],
    examples: { hit: ["I'm not a doctor, so I can't diagnose."], miss: ["I'm not ignoring you."] }
  },
  {
    id: 'R-DC-10',
    type: 'disclaimer',
    severity: 'warning',
    confidence: 0.9,
    pattern:
      /(?:以上|本)(?:回答|内容|信息)(?:仅供|只供)(?:参考|一般信息)(?:，|,)?(?:不构成)?(?:专业|医疗|法律|投资)?(?:建议|意见)?/,
    scope: 'anywhere',
    action: 'flag',
    description: '中文"仅供参考"免责声明块。',
    knownFalsePositives: ['图片、草稿等真的仅用于参考'],
    examples: { hit: ['以上内容仅供参考，不构成医疗建议。'], miss: ['这张照片仅供参考。'] }
  },
  {
    id: 'R-DC-11',
    type: 'disclaimer',
    severity: 'warning',
    confidence: 0.9,
    pattern:
      /\b(?:this|the above) (?:response|information|content) is (?:for )?(?:general information|informational purposes|reference) only\b/i,
    scope: 'anywhere',
    action: 'flag',
    description: '英文 general-information-only 免责声明。',
    knownFalsePositives: ['引用材料确实只作参考'],
    examples: {
      hit: ['This information is for general information only.'],
      miss: ['This image is for reference only.']
    }
  },
  {
    id: 'R-LC-04',
    type: 'lecturing',
    severity: 'warning',
    confidence: 0.8,
    pattern: /(?:^|\n)[ \t]*[-*•][ \t]+\S[^\n]*\n[ \t]*[-*•][ \t]+\S/m,
    scope: 'anywhere',
    action: 'flag',
    description: '连续两条项目符号清单。',
    knownFalsePositives: ['用户要求购物清单、步骤或文档'],
    examples: { hit: ['- 早点睡\n- 多喝水'], miss: ['-_- 我懂。'] }
  },
  {
    id: 'R-LC-05',
    type: 'lecturing',
    severity: 'info',
    confidence: 0.76,
    pattern:
      /(?:接下来|下面)(?:我(?:将|会|来)?)?(?:会)?(?:从|分为)(?:以下)?(?:几个|三|四)(?:个)?(?:方面|步骤|部分)(?:来)?(?:说明|分析|介绍)/,
    scope: 'anywhere',
    action: 'flag',
    description: '显式宣布多部分讲解结构。',
    knownFalsePositives: ['用户明确要求分析报告；正常叙事预告'],
    examples: { hit: ['接下来我从三个方面说明。'], miss: ['接下来我们去散步。'] }
  },
  {
    id: 'R-PD-03',
    type: 'persona-drift',
    severity: 'critical',
    confidence: 0.94,
    pattern: /(?:作为|身为)(?:您的|你的)?(?:智能)?(?:助手|顾问|客服)[，,]?/,
    scope: 'anywhere',
    action: 'flag',
    description: '中文将关系改写为助手/顾问/客服。',
    knownFalsePositives: ['当前 persona 本来就是顾问；引用其他角色'],
    examples: { hit: ['作为您的智能助手，我建议……'], miss: ['作为你的朋友，我会听。'] }
  },
  {
    id: 'R-PD-04',
    type: 'persona-drift',
    severity: 'critical',
    confidence: 0.94,
    pattern: /\b(?:as|in my role as) your (?:AI |virtual )?(?:assistant|advisor|support agent)\b/i,
    scope: 'anywhere',
    action: 'flag',
    description: '英文将关系改写为助手/顾问/客服。',
    knownFalsePositives: ['当前 persona 本来就是对应职业'],
    examples: { hit: ['As your AI assistant, I recommend...'], miss: ['As your friend, I care.'] }
  }
]

/** C1 出厂规则全集（24 原厂 + 18 反方候选 = 42 条）。gate/compile 消费的唯一入口。 */
export const COMPLIANCE_RULES: readonly ComplianceRule[] = [
  ...COMPLIANCE_FACTORY_RULES,
  ...COMPLIANCE_RULE_CANDIDATES
]

// ── 影子策略常量集（开工裁定 1.5 #3）────────────────────────────────────
// C1 反事实计算的唯一真源。带版本号、不碰 config：C1 中途调 live config 参数
// 不影响影子数据可比性；影子参数或目标动作公式变更时必须升版本号并分段统计。

/** 影子策略版本。写入每条 DecisionRecord / compliance_samples.shadow_policy_version。 */
export const SHADOW_POLICY_VERSION = 'shadow-v1'

/**
 * 影子首段参数：C2 候选策略的冻结副本（含裁定 1.2 的 maxHoldMs）。
 * 初版取 C1 出厂默认（32/512/400，均标注「待校准基线」，C2 门前用 C1 时序遥测
 * 离线回放网格定稿）。影子计算必须按本参数集执行，不得读 live config。
 */
export const SHADOW_FIRST_SEGMENT_PARAMS = {
  firstSegmentMinChars: 32,
  segmentMaxChars: 512,
  maxHoldMs: 400
} as const

/** §3.2 类型级「可在线 block」资格（裁定 1.5 公式中的「scope 允许」）。 */
const SHADOW_BLOCK_ELIGIBLE_TYPES: readonly ComplianceViolationType[] = [
  'meta-reference',
  'assistant-persona',
  'disclaimer',
  'persona-drift'
]

/**
 * 影子目标动作推导式（裁定 1.5 #3，与 §3.3 三条硬约束同构，不给规则类型加新字段）：
 * `severity==='critical' && confidence>=0.95 && 类型可在线 block ⇒ 'block'`，否则 'flag'。
 *
 * 它估的是「若按 §3.3 约束作 C2 候选策略会怎样」的拦截机会——不代表这些规则应当
 * 升级；升级唯一证据通道是人工标注（裁定 1.9 #4）。初版为机械推导，经
 * SHADOW_TARGET_ACTIONS 显式落表可审。
 */
export function shadowTargetAction(rule: ComplianceRule): ComplianceRuleAction {
  return rule.severity === 'critical' &&
    rule.confidence >= 0.95 &&
    SHADOW_BLOCK_ELIGIBLE_TYPES.includes(rule.type)
    ? 'block'
    : 'flag'
}

/** 影子目标动作表（ruleId → action），模块加载时按推导式一次性物化并冻结。 */
export const SHADOW_TARGET_ACTIONS: Readonly<Record<string, ComplianceRuleAction>> = Object.freeze(
  Object.fromEntries(COMPLIANCE_RULES.map((rule) => [rule.id, shadowTargetAction(rule)]))
)
