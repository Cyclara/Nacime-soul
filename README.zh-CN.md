<h1 align="center">Nacime-soul</h1>

<p align="center">一个会记得你的桌面 AI 伴侣——完全跑在你自己的电脑上。</p>

<p align="center">
  [<a href="./README.md">English</a>] [<b>简体中文</b>] [<a href="https://github.com/Cyclara/Nacime-soul/releases/latest"><b>⬇ 下载最新版本</b></a>]
</p>

<p align="center">
  <a href="https://github.com/Cyclara/Nacime-soul/releases/latest"><img src="https://img.shields.io/github/v/release/Cyclara/Nacime-soul?style=flat&colorA=080f12&colorB=6b7fd7&label=release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/Cyclara/Nacime-soul?style=flat&colorA=080f12&colorB=1fa669"></a>
  <a href="https://github.com/Cyclara/Nacime-soul/actions/workflows/ci.yml"><img src="https://github.com/Cyclara/Nacime-soul/actions/workflows/ci.yml/badge.svg"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20x64-0078d4?style=flat&colorA=080f12">
</p>

---

> [!WARNING]
> **下载之前请先看这段。**
>
> 这个项目还处在**很粗糙的早期阶段**。`1.x` 这个版本号只是发布计数，不代表成熟度——它算不上「1.0 产品」，说实话离大多数人心里的「第一个能用的版本」还有距离。
>
> **现在真的能用的**（安装包里有的）：文字聊天、三层记忆系统、成长时间线、Live2D 角色窗口、自动更新。
>
> **现在还不能用的**：所有跟语音有关的部分。语音合成和语音识别代码写完了、单元测试也过了，但**在真机上根本跑不起来**——见[已知问题](#已知问题)。语音功能**没有**打进已发布的安装包。
>
> 如果你想找一个日常能用的东西，现在还不是时候。如果你是来看代码、或者想跟着一起做的，欢迎。

## 这是什么

Nacime-soul 是一个 Windows 桌面应用，里面住着一个 AI 伴侣角色。和那种关掉就忘光的聊天窗口不同，它是围绕**持久记忆系统**造的：从对话里提取关于你的事实，判断这些事实靠不靠谱，处理互相矛盾的地方，并让记忆随时间衰减、也能被重新唤醒。

设计上的优先级，按顺序：

1. **你的数据是你的。** 聊天内容永远不进日志。API Key 只进操作系统密钥库，不进配置文件也不进日志。语音音频全程在本地处理、绝不离开这台机器——代码里**根本不存在**云端语音识别这条路径，这是设计上就排除掉的。
2. **绝不假装。** 语音引擎出不了声就退回纯文字并如实告诉你，绝不会偷偷拿一个通用系统音色顶替角色的声音。
3. **main 进程是唯一真源。** 渲染进程只持有只读投影，每一次写操作都要过一个带校验的 IPC 通道。

## 进度与路线图

按「器官」分组。`[x]` = 已实现且自动化测试通过。⚠️ = 已实现但**真机上是坏的**。

- [x] 🧠 **脑** —— 思考与记忆
  - [x] 流式回复，思考过程可见
  - [x] 失败重试；发送过程中重启也不会重复发送的幂等机制
  - [x] 三层记忆：L0 画像 / L1 状态 / L2 情景
  - [x] 提取 → 判决 → 冲突解决 管线
  - [x] 向量检索（IVF 索引）
  - [x] DMAE 记忆激活衰减引擎，含可视化面板（激活曲线、异常规则、参数体检、基准）
  - [ ] 伦理架构 —— 已设计，未开工
- [x] 👤 **身** —— 被看见
  - [x] 透明置顶的 Live2D 舞台窗口
  - [x] 模型加载管线、待机动画、表情控制
  - [ ] 口型同步（Viseme）—— 已调研，卡在语音合成没跑通
- [x] 💗 **心** —— 一起长大
  - [x] 成长值、里程碑、相处时间线
  - [x] 人格提示词与种子记忆
- [ ] 👄 **口** —— 说话 ⚠️ *未打进已发布安装包*
  - [x] GPT-SoVITS 本地定制音色合成
  - [x] 官方 8GB 运行时一键安装（三个下载镜像）
  - [x] 多音色注册表，支持导入
  - [ ] ⚠️ **坏的**：刚装好的运行时永远识别不出来——见 [V-01](#v-01--gpt-sovits-装完永远识别不出来)
- [ ] 👂 **耳** —— 听 ⚠️ *未打进已发布安装包*
  - [x] Silero VAD、打断（她说话时你可以插话）
  - [x] SenseVoice 与 FunASR Paraformer 识别模型
  - [ ] ⚠️ 另外四个模型代码写完了，但**国内网络下载不了**——见 [V-02](#v-02--四个语音模型下载不了)
  - [x] 音频永不离开你的电脑——代码里没有云端识别路径
- [x] 🛡️ **底座**
  - [x] `contextIsolation` + `sandbox` + CSP + 两层网络出口策略
  - [x] API Key 存在操作系统密钥库（`safeStorage`）
  - [x] SQLite（WAL）+ JSON 原子写
  - [x] Windows x64 经 GitHub Release 自动更新
  - [ ] 代码签名 —— 脚手架已备好，还没有证书（会有 SmartScreen 警告）
  - [ ] macOS / Linux

## 已知问题

以下是 2026-09-03 真机验收时发现的、可复现的未解决问题。它们全都在**尚未合并的语音分支**上，所以不影响已发布的安装包——但这也正是语音功能迟迟没发的原因。

#### V-01 — GPT-SoVITS 装完永远识别不出来

**严重度：阻断。** 一键安装能正确下载并校验 8GB 运行时，但装完之后应用报「没有发现完整的本地 GPT-SoVITS 整合包」。

根因：判定逻辑把两个不同的问题揉成了一个——*「有没有能跑的运行时？」*和*「音色配好了没有？」*——任一不满足就整体拒绝。而一个干净的官方整合包按定义就不含用户训练的权重、也不含参考音频，所以**每次都会被拒**。

更麻烦的是这形成了一个死锁：没有被识别的安装 → provider 不注册 → 音色下拉被强制清空，于是**导入音色也打不破这个循环**。用户没有任何操作能从这个状态里恢复。

*修复方向：*把判定拆成两个。provider 注册只依赖运行时本身；音色缺失走已有的纯文字降级路径。

#### V-02 — 四个语音模型下载不了

**严重度：阻断（地区性）。** 两个识别模型能正常下载，四个 100% 失败，开不开代理都一样。

分界线是主机而不是模型：能下的两个在 GitHub Releases 上，下不了的四个全在 `huggingface.co` 上——这个域名在中国大陆不可直连。有两个叠加原因：

- 多文件下载路径**没有镜像回退**，而同一个仓库里的 GPT 运行时下载器有三个镜像并且能正确回退——这正是 8GB 的整合包能下、几百 MB 的模型反而下不了的原因。
- **整个代码库里没有任何代理支持**。下载走的是 Node 的 `fetch`，它不读系统代理设置，所以你开代理毫无作用。

还有第三条约束，是给将来修这个问题的人的：网络策略在**每次请求前都会先做一次本机 DNS 解析**并拦截保留地址。在 DNS 污染环境下，这一步会在代理能起作用之前就把请求拒掉，所以加代理支持时必须连这个前置检查一起处理。

*修复方向：*给模型目录加镜像（镜像上钉死的逐文件 SHA-256 依然成立），复用已有的回退循环。

#### V-03 — 语音试听不可用

V-01 的下游后果。修完 V-01 之后需要重新测。

#### V-04 — 换资源目录必须重启

这是有意的设计（引擎和下载断点不做热切换），但提示出现得太晚——用户已经走到下载界面才被告知——而且下载按钮没有被禁用，资源仍然可能落到旧位置。

#### V-05 — 语音验收 8 项 0 通过

计划的 8 项真机验收，没有一项完整通过。其中 5 项因为 V-01 和 V-02 挡着而压根没测到：打包版麦克风采集、离线识别、多音色切换、打断时的回声表现、性能基线。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 框架 | Electron 43 + electron-vite 5 + Vue 3 + Pinia + vue-router |
| 存储 | better-sqlite3（WAL）+ JSON 原子写（配置 / 密钥 / 记忆 / DMAE 状态） |
| 校验 | valibot（配置 schema + IPC 入参） |
| 安全 | `contextIsolation` + `sandbox`、CSP、网络出口两层策略、操作系统密钥库 |
| 语音 *（未合并）* | GPT-SoVITS（合成）+ sherpa-onnx（识别）+ Silero VAD —— 全本地 |
| 角色 | Live2D Cubism，透明舞台窗口 |
| 更新 | electron-updater + GitHub Releases（Windows x64 / NSIS） |
| 测试 | Vitest（Electron Node 环境）+ Playwright E2E + Golden Eval |

**语言模型：**任何 OpenAI 兼容端点。DeepSeek、OpenAI、Moonshot、阿里 DashScope（通义）、OpenRouter 的兼容性差异会被自动识别；其他服务商通过自定义 base URL 接入。

## 开始使用

从[最新 Release](https://github.com/Cyclara/Nacime-soul/releases/latest) 下载安装包（Windows x64）。安装包没有签名，Windows SmartScreen 会弹警告——在接入代码签名之前这是正常的。

首次启动需要一个 OpenAI 兼容服务商的 API Key。Key 会存进 Windows 凭据管理器，不会写进配置文件。

## 开发

```bash
npm install                    # postinstall 会为 Electron 重新编译 better-sqlite3
npm run dev                    # 开发模式（HMR）

npm run typecheck              # tsc（node）+ vue-tsc（web）
npm run lint                   # eslint
npm test                       # 全量单测（Electron Node 环境）
npm run test:coverage          # 单测 + 覆盖率阈值
npm run test:e2e               # 构建 + Playwright Electron E2E

npm run build                  # electron-vite 构建
npm run build:win              # 构建 + electron-builder NSIS 安装包
npm run gate                   # lint / typecheck / test / build + 静态扫描
npm run smoke:packaged         # 打包冒烟测试
npm run check:repo-hygiene     # 拒绝把构建产物、环境文件、证书提交进 Git
```

跑测试之前先跑 `npm run typecheck`——Vitest 的转换只删类型不做检查，先跑 tsc 能更快暴露类型错误。

### 目录结构

```
src/
  main/      主进程：配置 / 安全 / IPC / 聊天 / 记忆 / DMAE / 成长 / 迁移
  renderer/  渲染进程：stores / views / components / styles
  preload/   contextBridge —— 最小暴露面
  shared/    main ↔ renderer 共享契约（IPC 通道 / 类型 / 校验器）
tests/       Playwright E2E + Golden Eval + helpers
resources/   人格提示词、种子记忆、成长里程碑
scripts/     门禁、打包冒烟、Vitest Electron 运行器
```

### 值得知道的设计约束

- **IPC 契约在编译期互锁**：`channels.ts` → `contracts.ts` → `validators.ts`，用 `satisfies` 强制每个通道必须有校验器。加了通道不写校验器，编译不过。
- **隐私靠结构保证**，不靠自觉：日志白名单在类型上就表达不出聊天正文，幂等账本只存哈希。
- **错误不外泄**：内部错误映射到一组固定的安全文案，栈既不落盘也不发给 UI。
- **安全底座关不掉**——见 `src/main/security/window-config.ts`。

## 发布与自动更新

已发布的 Windows 安装版会在后台检查 GitHub Release 并自动下载稳定版更新。开发环境和未打包的构建不会检查更新。

发版要求：SemVer 严格递增、全绿门禁（`gate` + `test:e2e` + `build:win` + `smoke:packaged`）、把**同一次构建**产出的 `.exe`、`.exe.blockmap`、`latest.yml` 上传到同一个已发布的、非 Draft、非 Prerelease 的 Release。绝不要手改 `latest.yml` 或 blockmap——文件对不上会破坏更新校验。

## 项目状态

由一个人开发，设计和实现过程中借助了 AI。开发按阶段推进：Phase 1（聊天基础）和 Phase 2（记忆、DMAE、成长）已完成并发布；Phase 3a（Live2D）已合并；Phase 3b（语音）代码写完了，但卡在上面那些问题上。

欢迎提 Issue 和 PR，但响应时间不太规律。

## 许可证

[MIT](./LICENSE) © Cyclara
