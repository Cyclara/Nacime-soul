# Nacime-soul

Electron + Vue 3 + Pinia + better-sqlite3 + TypeScript 的桌面 AI 伴侣应用。

> 项目总览、设计文档与审计记录见父仓库 `E:\github深度研究\`（README / CHANGELOG / docs/）。

## 功能

- **聊天**：流式回复、思考过程展示、失败重试、幂等发送（跨重启）
- **记忆**：L0 画像 / L1 状态 / L2 记忆 三层，提取→判决→冲突解决管线，向量检索（IVF）
- **DMAE**：记忆激活衰减引擎 + 可视化面板（激活曲线/异常/参数体检/基准）
- **成长**：U 值 / 里程碑 / 相处时间线
- **设置**：模型 / 记忆 / 外观 / 安全 四个分区（主题、API Key、日志、隐私）

## 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Electron 43 + electron-vite 5 + Vue 3 + Pinia + vue-router |
| 存储 | better-sqlite3（WAL）+ JSON 原子写（config/secrets/l0/l1/dmae-state） |
| 校验 | valibot（配置 schema / IPC 入参） |
| 安全 | contextIsolation + sandbox、CSP、网络出口两层策略、OS 密钥库（safeStorage） |
| 测试 | Vitest（Electron Node 环境）+ Playwright E2E + Golden Eval |

## 目录结构

```
src/
  main/      主进程：配置/安全/IPC/聊天/记忆/DMAE/成长/迁移/可观测性
  renderer/  渲染进程：stores / views / components / styles
  preload/   contextBridge 最小暴露面
  shared/    main↔renderer 共享契约（IPC 通道/类型/校验器）
tests/       E2E（Playwright）+ evals（Golden）+ helpers
resources/   prompts（人格提示词）、seeds（种子记忆）、growth（里程碑）
scripts/     phase1-gate 门禁、smoke-packaged 打包冒烟、vitest-electron
```

## 命令

```bash
npm install            # 安装（postinstall 自动 electron-rebuild better-sqlite3）
npm run dev            # 开发模式（HMR）
npm run typecheck      # tsc（node）+ vue-tsc（web）
npm run lint           # eslint
npm test               # Vitest 全量单测（Electron Node 环境）
npm run test:coverage  # 单测 + 覆盖率阈值
npm run build          # electron-vite 构建（out/）
npm run build:win      # 构建 + electron-builder NSIS 安装包
npm run test:e2e       # 构建 + Playwright Electron E2E（9 条）
npm run gate           # phase1-gate：lint/typecheck/test/build + 3 项静态扫描
npm run smoke:packaged # 打包冒烟（校验 asar 实际内容等）
```

## 关键设计约束

- **IPC 契约三件套编译期互锁**：`channels.ts` → `contracts.ts` → `validators.ts`（`satisfies` 强制每通道必有校验器）。
- **main 是真源**，renderer 只读投影；写操作经事件回流刷新。
- **隐私纪律**：日志白名单不含聊天正文；API Key 只进 OS 密钥库、不进 config/日志；幂等账本只存哈希。
- **错误不泄露**：AppError 映射为预定义安全文案，栈不落盘不发给 UI。
- **安全底座不可关**：`contextIsolation:true` / `sandbox:true` / `webSecurity:true`（见 `src/main/security/window-config.ts`）。

## 发布注意

- `electron-builder.yml` 中 `publish.owner/repo` 仍是 `REPLACE_BEFORE_RELEASE` 占位符，发布前必须替换。
- Windows 签名脚手架已备好（`win` 段注释），接入真实证书后可消除 SmartScreen 警告。
- 打包后请运行 `npm run smoke:packaged` 校验 asar 内含 prompts/seeds/growth。
