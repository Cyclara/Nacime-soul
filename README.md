# Nacime-soul

Electron + Vue 3 + Pinia + better-sqlite3 + TypeScript 的桌面 AI 伴侣应用。

> 项目总览、设计文档与审计记录见父仓库。

## 功能

- **聊天**：流式回复、思考过程展示、失败重试、幂等发送（跨重启）
- **记忆**：L0 画像 / L1 状态 / L2 记忆 三层，提取→判决→冲突解决管线，向量检索（IVF）
- **DMAE**：记忆激活衰减引擎 + 可视化面板（激活曲线/异常/参数体检/基准）
- **成长**：U 值 / 里程碑 / 相处时间线
- **设置**：模型 / 记忆 / 外观 / 安全 / 关于 五个分区（主题、API Key、日志、隐私、版本与更新）
- **自动更新**：正式 Windows 安装版后台检查 GitHub Release、静默下载、下载完成后提示用户安装

## 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Electron 43 + electron-vite 5 + Vue 3 + Pinia + vue-router |
| 更新 | electron-updater + GitHub Releases（Windows x64 / NSIS 稳定通道） |
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
npm install                    # 安装（postinstall 自动 electron-rebuild better-sqlite3）
npm run check:repo-hygiene     # 拒绝把构建产物、环境文件、证书或个人配置提交进 Git
npm run dev                    # 开发模式（HMR）
npm run typecheck              # tsc（node）+ vue-tsc（web）
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

## 发布与自动更新

当前 Windows x64 / NSIS 自动更新已配置到 GitHub `Cyclara/Nacime-soul`：正式安装版会读取 Release 内的 `latest.yml`，发现更高稳定版本后后台下载更新。`electron-builder.yml` 的 `publish.owner/repo` **已是正式配置，不是占位符**；普通发版不应手改。

每次发布必须：

1. 将 `package.json` / `package-lock.json` 的版本升到严格更高的 SemVer；
2. 运行 `npm run gate`、`npm run test:e2e`、`npm run build:win`、`npm run smoke:packaged`；
3. 从同一次构建的 `dist-electron/` 上传以下三项到同一个正式 GitHub Release：
   - `Nacime-soul-<version>-x64.exe`
   - `Nacime-soul-<version>-x64.exe.blockmap`
   - `latest.yml`
4. Release 需要最终处于**已发布、非 Draft、非 Prerelease**状态；不要手改 `latest.yml`、`.blockmap` 或安装包名称。

`npm run build:win` 只生成本地资产，不会自动上传 GitHub。GitHub Tag、Release 创建/发布和上传资产均由仓库所有者本人执行。完整操作、常见故障、发布后旧版验证与未来 GitHub Actions 自动发布方案见父工作区的 `docs/guides/发布新版本与自动更新指南.md`。

Windows 签名脚手架已备好（`win` 段注释），但尚未配置真实证书；自动更新不因此失效，面向广泛用户发布前仍建议接入代码签名以减少 SmartScreen / 未知发布者提示。
