// src/main/voice/tts/gpu-info.test.ts
// P3V-16：显卡名探测合同。单测**不 spawn PowerShell**——run 全部注入。

import { describe, expect, it, vi } from 'vitest'
import { createGpuNameProbe, pickPrimaryGpuName } from './gpu-info'

describe('P3V-16 pickPrimaryGpuName', () => {
  it('多显卡优先 NVIDIA（笔记本核显 + 独显同时在列）', () => {
    expect(
      pickPrimaryGpuName('Intel(R) UHD Graphics\r\nNVIDIA GeForce RTX 5070 Laptop GPU\r\n')
    ).toBe('NVIDIA GeForce RTX 5070 Laptop GPU')
  })

  it('无 NVIDIA 时取第一块非空', () => {
    expect(pickPrimaryGpuName('\r\n  AMD Radeon RX 7900 XT \r\n')).toBe('AMD Radeon RX 7900 XT')
  })

  it('空输出返回 null', () => {
    expect(pickPrimaryGpuName('')).toBeNull()
    expect(pickPrimaryGpuName('\r\n   \r\n')).toBeNull()
  })
})

describe('P3V-16 createGpuNameProbe', () => {
  it('单进程只探一次（结果缓存，设置页反复刷新不反复 spawn）', async () => {
    const run = vi.fn(async () => 'NVIDIA GeForce RTX 5090')
    const probe = createGpuNameProbe({ run, platform: 'win32' })
    expect(await probe()).toBe('NVIDIA GeForce RTX 5090')
    expect(await probe()).toBe('NVIDIA GeForce RTX 5090')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('失败/超时 → null，且不反复重试拖慢设置页', async () => {
    const run = vi.fn(async () => {
      throw new Error('powershell exit 1')
    })
    const probe = createGpuNameProbe({ run, platform: 'win32' })
    expect(await probe()).toBeNull()
    expect(await probe()).toBeNull()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('非 Windows 直接 null，不执行任何命令', async () => {
    const run = vi.fn(async () => 'NVIDIA GeForce RTX 5090')
    const probe = createGpuNameProbe({ run, platform: 'darwin' })
    expect(await probe()).toBeNull()
    expect(run).not.toHaveBeenCalled()
  })
})
