// src/shared/config/themes.ts
// 主题注册表：单一真源。主进程 schema/validator、renderer applyTheme、未来的设置页
// 都引用这里——新增一个主题 = 加一行 id + CSS 加一块 [data-theme='<id>'] + 设置页选项。
// 依据：S-005 §3.5（UI 配置 schema）+ P2-46 主题扩展准备（用户要求为 3+ 主题留好基础）。

/** 实际可选主题（不含 'system' 跟随系统模式） */
export const THEME_IDS = ['light', 'dark', 'light2', 'dark2'] as const
export type ThemeId = (typeof THEME_IDS)[number]

/** 配置里可写的全部值：'system'（跟随系统）是模式，不是主题本身 */
export const THEME_SETTING_IDS = ['system', ...THEME_IDS] as const
export type ThemeSetting = (typeof THEME_SETTING_IDS)[number]

/** 主题显示名（设置页选项 / 无障碍）。新增主题在这里加一行。 */
export const THEME_LABELS: Record<ThemeId, string> = {
  light: '浅色',
  dark: '深色',
  light2: '浅色2号',
  dark2: '深色2号'
}

/** 判断一个字符串是否已知主题（非 'system'） */
export function isThemeId(value: string): value is ThemeId {
  return (THEME_IDS as readonly string[]).includes(value)
}
