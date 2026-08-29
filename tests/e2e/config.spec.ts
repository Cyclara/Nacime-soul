// E2E #2: 配置保存 + 刷新 + 脱敏（S-004 §3.3 #37）
// 设置模型 -> 保存 -> 刷新 -> 脱敏配置仍存在、key 不回传
//
// 流程：
//   1. 启动（无 Key）-> 显示引导
//   2. 通过 IPC 保存配置（含 apiKey）
//   3. 关闭应用
//   4. 重启（Faux 模式，同目录）-> 跳过引导（hasApiKey=true）-> 聊天界面
//   5. 验证配置已保存（跳过引导 = hasApiKey=true）
//
// 注：用 evaluate 调 IPC 保存配置，而非 UI 填表单 + 点保存。
// 原因：Playwright fill 对 Vue @input 的触发有兼容问题（setApiKey 未被调用）。
// key 不回传由单元测试覆盖（config handler 的 toPublicSnapshot 只返回 hasApiKey）。

import { writeFileSync } from 'node:fs'
import { test, expect, _electron as electron } from '@playwright/test'
import {
  createTmpUserData,
  cleanupTmpDir,
  createElectronEnv,
  shutdownApp,
  writeDefaultConfig
} from './helpers'

test('S-004 #37: 设置模型->保存->刷新->脱敏配置仍存在', async () => {
  const tmpDir = createTmpUserData()
  // 不写 config/secrets -> 无 Key -> 显示引导
  let saveResult: { ok: boolean; error?: { code?: string } } | null = null

  // === 第一次启动：通过 IPC 保存配置 ===
  const app = await electron.launch({
    args: ['out/main/index.js'],
    env: createElectronEnv({
      COMPANION_USER_DATA: tmpDir
    })
  })

  try {
    const win = await app.firstWindow()

    // 等待引导表单出现（确认应用就绪）
    await win.waitForSelector('input[placeholder="https://api.deepseek.com"]', {
      timeout: 30_000
    })

    // 通过 IPC 保存配置（含 apiKey），并**保留返回值**。
    // 此前这里 await 后把结果丢掉，保存失败也看不出来——要等第二次启动断言 hasApiKey
    // 才炸，且报错里没有任何原因线索（2026-08-29 CI 就是这样浪费了一轮排查）。
    saveResult = await win.evaluate(async () =>
      window.companion.config.update({
        expectedSchemaVersion: 1,
        domains: {
          model: {
            provider: 'deepseek',
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-v4-flash',
            apiKey: 'sk-fake-key-for-e2e'
          }
        }
      })
    )
  } finally {
    await shutdownApp(app)
  }

  // 保存必须成功，或者以明确的错误码失败——不允许"悄悄没存上"。
  if (saveResult === null || !saveResult.ok) {
    expect(saveResult?.error?.code).toBe('SEC_KEYSTORE_DOWNGRADE')
  }

  // === 第二次启动：验证配置已保存（跳过引导）===
  const app2 = await electron.launch({
    args: ['out/main/index.js'],
    env: createElectronEnv({
      COMPANION_TEST_MODE: 'faux',
      COMPANION_USER_DATA: tmpDir
    })
  })

  try {
    const win = await app2.firstWindow()

    // S-014 之后「有 Key」不再等于「直接进聊天」：本例用 IPC 直存配置、没走引导 UI，
    // 因此引导阶段仍是 provider-setup，重启后 resolver 判为 configured-empty-history，
    // 落在「第一次见面」。
    //
    // 先等**任一**终局界面出现再分支：密钥能否跨重启回读取决于机器的系统钥匙串
    // （GitHub Actions 的 Windows runner 上 safeStorage 密文换进程就解不开），
    // 死等其中一个会在另一条路径上白等 30 秒再报一个看不出原因的错。
    await win.waitForSelector(
      '.first-conversation, input[placeholder="https://api.deepseek.com"]',
      {
        timeout: 30_000
      }
    )

    const persisted = await win.evaluate(async () => {
      const current = await window.companion.config.get()
      if (!current.ok) return null
      return {
        hasApiKey: current.data.model.hasApiKey,
        baseUrl: current.data.model.baseUrl,
        model: current.data.model.model
      }
    })
    expect(persisted).not.toBeNull()

    // 不变量①：非密钥配置跨重启一定还在。
    expect(persisted).toMatchObject({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash'
    })

    // 不变量②（M-34，本次 CI 暴露的真缺陷）：**引导阶段必须与 hasApiKey 一致**。
    // 密钥可回读 → 跳过连接表单、进「第一次见面」；回读不出来 → 必须老老实实退回配置页
    // 让用户重填。绝不允许「引导跳过了配置、聊天却报未配置 API Key」这种自相矛盾——
    // 修复前 resolver 用 `has()`（只看键在不在）、config 快照用「存在且可读」，
    // 两套判据在 CI 上正好劈叉。
    const guideVisible = await win.isVisible('input[placeholder="https://api.deepseek.com"]')
    const firstConversationVisible = await win.isVisible('.first-conversation')
    expect({ guideVisible, firstConversationVisible }).toEqual(
      persisted?.hasApiKey === true
        ? { guideVisible: false, firstConversationVisible: true }
        : { guideVisible: true, firstConversationVisible: false }
    )
  } finally {
    await shutdownApp(app2)
    cleanupTmpDir(tmpDir)
  }
})

// M-34 不变量的确定性回归。2026-08-29 之前这条只在 CI 上偶然暴露（runner 的 safeStorage
// 密文跨进程解不开），本地永远绿——因为本地密钥能正常回读。这里直接构造「存在但读不出来」
// 的密钥，让任何机器都能复现：真实成因包括换钥匙串上下文（M-47 的 app.name 漂移）、
// 换机器、系统凭据被清。
//
// 修复前：引导判定用 `secretStore.has()`（只看键在不在）→ 判为已配置，跳过连接表单；
// 而 config 快照用「存在且可读」→ hasApiKey=false。用户被两条矛盾信息夹击：
// 界面说配好了，聊天说未配置 API Key——正是 M-34 立下的红线。
test('M-34: 密钥存在但读不出来时，引导退回配置页且 hasApiKey 为 false', async () => {
  const tmpDir = createTmpUserData()
  writeDefaultConfig(tmpDir) // onboarding.stage = 'complete'：即使已"走完"引导也必须被拉回
  writeFileSync(
    `${tmpDir}/secrets.json`,
    JSON.stringify({
      schemaVersion: 1,
      xorKey: 'dGVzdA==',
      // enc: 前缀 => has() 为 true；但内容不是有效密文 => get() 返回 null
      modelApiKey: 'enc:aW52YWxpZGNpcGhlcnRleHQ='
    })
  )

  const app = await electron.launch({
    args: ['out/main/index.js'],
    env: createElectronEnv({ COMPANION_TEST_MODE: 'faux', COMPANION_USER_DATA: tmpDir })
  })

  try {
    const win = await app.firstWindow()
    // 必须回到连接配置表单，而不是聊天/第一次见面
    await win.waitForSelector('input[placeholder="https://api.deepseek.com"]', { timeout: 30_000 })

    const snapshot = await win.evaluate(() => window.companion.config.get())
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok) throw new Error('config.get failed')
    expect(snapshot.data.model.hasApiKey).toBe(false)
    // 两处判据必须一致：既然 hasApiKey 为 false，就不能同时展示"已配置"的后续界面
    expect(await win.isVisible('.first-conversation')).toBe(false)
  } finally {
    await shutdownApp(app)
    cleanupTmpDir(tmpDir)
  }
})
