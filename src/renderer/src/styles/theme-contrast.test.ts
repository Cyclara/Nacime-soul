// src/renderer/src/styles/theme-contrast.test.ts
// 2026-09-02 真机回归：四主题的语义文字 token 必须在 elevated surface 上可读。
// 截图中角色/语音组件使用了缺失的 `--color-text-primary`，fallback 为 white，导致
// light/light2 几乎隐形；部分小字 tertiary 本身也低于 4.5:1。这里直接读取 CSS 真源，
// 防主题调色以后再次把小字调到不可读。

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('./base.css', import.meta.url)), 'utf8')
const THEME_IDS = ['light', 'dark', 'light2', 'dark2'] as const

function themeBlock(id: (typeof THEME_IDS)[number]): string {
  const match = new RegExp(`\\[data-theme=['"]${id}['"]\\]\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css)
  if (match === null) throw new Error(`missing CSS theme block: ${id}`)
  return match[1]!
}

function hexToken(block: string, name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block)
  if (match === null) throw new Error(`missing hex token --${name}`)
  return match[1]!
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
  const linear = channels.map((value) =>
    value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  )
  return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
}

function contrast(foreground: string, background: string): number {
  const a = luminance(foreground)
  const b = luminance(background)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

describe('四主题文字对比度（真 CSS token）', () => {
  for (const id of THEME_IDS) {
    it(`${id}: text 四层在 surface-elevated 上均达可读阈值`, () => {
      const block = themeBlock(id)
      const surface = hexToken(block, 'color-surface-elevated')
      expect(contrast(hexToken(block, 'color-text'), surface)).toBeGreaterThanOrEqual(7)
      expect(contrast(hexToken(block, 'color-text-secondary'), surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(hexToken(block, 'color-text-muted'), surface)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(hexToken(block, 'color-text-tertiary'), surface)).toBeGreaterThanOrEqual(4.5)
    })
  }

  it('Phase 3 组件使用的兼容语义 token 必须映射到主题真源，不得 fallback white', () => {
    expect(css).toContain('--color-text-primary: var(--color-text);')
    expect(css).toContain('--color-surface-raised: var(--color-surface-elevated);')
    expect(css).toContain('--color-danger: var(--color-error);')
  })
})
