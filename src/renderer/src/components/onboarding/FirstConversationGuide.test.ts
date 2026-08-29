// @vitest-environment jsdom
// src/renderer/src/components/onboarding/FirstConversationGuide.test.ts
// P3A-31：opening 是展示层；四种入口各只发送一条真实 user 文本。

import { describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import FirstConversationGuide from './FirstConversationGuide.vue'

describe('P3A-31 FirstConversationGuide', () => {
  it('不自动发送；三种固定入口和自由输入均只发一次 startChat', async () => {
    vi.useFakeTimers()
    const wrapper = mount(FirstConversationGuide)
    expect(wrapper.emitted('startChat')).toBeUndefined()
    expect(wrapper.findAll('button.choice')).toHaveLength(3)

    await wrapper.findAll('button.choice')[0]!.trigger('click')
    expect(wrapper.emitted('startChat')).toEqual([['那就从今天开始吧。']])

    const input = wrapper.find<HTMLInputElement>('#first-conversation-input')
    await input.setValue('我自己想说的话')
    await wrapper.find('form').trigger('submit')
    expect(wrapper.emitted('startChat')).toEqual([['那就从今天开始吧。'], ['我自己想说的话']])
    vi.useRealTimers()
  })

  it('超过 10 秒只更新辅助提示，不产生自动消息', async () => {
    vi.useFakeTimers()
    const wrapper = mount(FirstConversationGuide)
    vi.advanceTimersByTime(10_000)
    await nextTick()
    expect(wrapper.text()).toContain('不知道说什么也没关系')
    expect(wrapper.emitted('startChat')).toBeUndefined()
    vi.useRealTimers()
  })
})
