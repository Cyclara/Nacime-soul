// src/main/security/unicode.ts
// Unicode NFKC 归一化 + 危险格式字符删除 + 递归清理
// 依据：S-005、S-001 P1-09

/**
 * 危险 Unicode 格式字符正则。使用 new RegExp 构造，\u{...} 语法与 u flag 配合。
 * 删除以下类别：
 *  - 双向覆盖字符（U+202A–U+202E, U+2066–U+2069）
 *  - 零宽空格（U+200B）、词连接符（U+2060）、不可见运算符（U+2061–U+2064）
 *  - BOM（U+FEFF）、软连字符（U+00AD）、组合字素连接符（U+034F）
 *  - 阿拉伯字母标记（U+061C）、行间注释（U+FFF9–U+FFFB）
 *  - 标签字符（U+E0001, U+E0020–U+E007F）
 *  - 行/段分隔符（U+2028/2029）、蒙古语元音分隔符（U+180E）
 *  - 韩文填充（U+115F/1160）、高棉语元音（U+17B4/17B5）
 *  - 对象替换字符（U+FFFC）
 *
 * 不删除：ZWJ（U+200D）、ZWNJ（U+200C）、组合标记、变体选择器
 */
// prettier-ignore
/* eslint-disable no-misleading-character-class */
const DANGEROUS_FORMAT_RE = new RegExp(
  '[\\u{00AD}\\u{034F}\\u{061C}\\u{115F}\\u{1160}\\u{17B4}\\u{17B5}\\u{180E}\\u{200B}\\u{2028}\\u{2029}\\u{202A}-\\u{202E}\\u{2060}-\\u{2069}\\u{FEFF}\\u{FFF9}-\\u{FFFB}\\u{FFFC}\\u{E0001}\\u{E0020}-\\u{E007F}]',
  'gu'
)
/* eslint-enable no-misleading-character-class */

/**
 * 对字符串执行 Unicode 安全清理：
 * 1. NFKC 归一化（全角→半角、合字→分解、上标→普通）
 * 2. 删除危险格式字符
 *
 * 返回清理后的字符串。普通中英文文本不变。
 */
export function sanitizeUnicode(input: string): string {
  // 先 NFKC 归一化，再删除危险格式字符
  return input.normalize('NFKC').replace(DANGEROUS_FORMAT_RE, '')
}

/**
 * 递归清理任意值中的字符串：
 * - string → sanitizeUnicode
 * - object → 递归处理每个自有属性值
 * - array → 递归处理每个元素
 * - 其他类型 → 原样返回
 *
 * 不修改原始对象，返回新对象。
 */
export function sanitizeUnicodeDeep<T>(value: T): T {
  if (typeof value === 'string') {
    return sanitizeUnicode(value) as unknown as T
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnicodeDeep(item)) as unknown as T
  }

  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>)) {
      result[key] = sanitizeUnicodeDeep((value as Record<string, unknown>)[key])
    }
    return result as T
  }

  return value
}
