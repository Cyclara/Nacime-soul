// v-tooltip：主题化气泡提示，替代原生 title（原生 tooltip 是纯黑系统样式，无法定制）。
// 依据：2026-08-21 验收反馈——原生黑色 tooltip 与主题格格不入。
//
// 用法：v-tooltip="'文案'"（或 v-tooltip="动态值"）。
// 行为：hover/聚焦 350ms 后浮现，离开即消；默认在元素上方，空间不足翻转到下方；
//       浮层是 body 下唯一共享元素，样式在 base.css 的 .app-tooltip（走主题令牌）。

import type { Directive } from 'vue'

const SHOW_DELAY = 350
const VIEWPORT_GAP = 8

interface TooltipHost extends HTMLElement {
  __tooltipShow__?: () => void
  __tooltipHide__?: () => void
  __tooltipText__?: string
}

let tipEl: HTMLDivElement | null = null
let showTimer: ReturnType<typeof setTimeout> | undefined

function ensureEl(): HTMLDivElement {
  if (!tipEl) {
    tipEl = document.createElement('div')
    tipEl.className = 'app-tooltip'
    tipEl.setAttribute('role', 'tooltip')
    document.body.appendChild(tipEl)
  }
  return tipEl
}

function placeTip(target: HTMLElement): void {
  const el = ensureEl()
  const rect = target.getBoundingClientRect()
  // 先按"上方居中"摆，再按视口边界修正
  el.style.left = '0px'
  el.style.top = '0px'
  el.style.visibility = 'hidden'
  el.classList.add('is-open')
  const tipRect = el.getBoundingClientRect()

  let left = rect.left + rect.width / 2 - tipRect.width / 2
  left = Math.max(VIEWPORT_GAP, Math.min(left, window.innerWidth - tipRect.width - VIEWPORT_GAP))

  let top = rect.top - tipRect.height - VIEWPORT_GAP
  if (top < VIEWPORT_GAP) {
    // 上方放不下 -> 翻到下方
    top = rect.bottom + VIEWPORT_GAP
  }

  el.style.left = `${Math.round(left)}px`
  el.style.top = `${Math.round(top)}px`
  el.style.visibility = 'visible'
}

function hideTip(): void {
  if (showTimer !== undefined) {
    clearTimeout(showTimer)
    showTimer = undefined
  }
  tipEl?.classList.remove('is-open')
}

export const vTooltip: Directive<TooltipHost, string> = {
  mounted(el, binding) {
    el.__tooltipText__ = binding.value
    el.__tooltipShow__ = () => {
      const text = el.__tooltipText__
      if (!text) return
      showTimer = setTimeout(() => {
        ensureEl().textContent = text
        placeTip(el)
      }, SHOW_DELAY)
    }
    el.__tooltipHide__ = hideTip
    el.addEventListener('mouseenter', el.__tooltipShow__)
    el.addEventListener('focus', el.__tooltipShow__)
    el.addEventListener('mouseleave', el.__tooltipHide__)
    el.addEventListener('blur', el.__tooltipHide__)
    el.addEventListener('click', el.__tooltipHide__)
  },
  updated(el, binding) {
    el.__tooltipText__ = binding.value
  },
  unmounted(el) {
    hideTip()
    if (el.__tooltipShow__) el.removeEventListener('mouseenter', el.__tooltipShow__)
    if (el.__tooltipShow__) el.removeEventListener('focus', el.__tooltipShow__)
    el.removeEventListener('mouseleave', hideTip)
    el.removeEventListener('blur', hideTip)
    el.removeEventListener('click', hideTip)
  }
}
