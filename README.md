<h1 align="center">Nacime-soul</h1>

<p align="center">A desktop AI companion that remembers you — running on your own machine.</p>

<p align="center">
  [<b>English</b>] [<a href="./README.zh-CN.md">简体中文</a>] [<a href="https://github.com/Cyclara/Nacime-soul/releases/latest"><b>⬇ Download Latest Release</b></a>]
</p>

<p align="center">
  <a href="https://github.com/Cyclara/Nacime-soul/releases/latest"><img src="https://img.shields.io/github/v/release/Cyclara/Nacime-soul?style=flat&colorA=080f12&colorB=6b7fd7&label=release"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/github/license/Cyclara/Nacime-soul?style=flat&colorA=080f12&colorB=1fa669"></a>
  <a href="https://github.com/Cyclara/Nacime-soul/actions/workflows/ci.yml"><img src="https://github.com/Cyclara/Nacime-soul/actions/workflows/ci.yml/badge.svg"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20x64-0078d4?style=flat&colorA=080f12">
</p>

---

> [!WARNING]
> **Read this before you download anything.**
>
> This project is at an **early, rough stage**. The `1.x` version number is a release counter, not a maturity claim — this is not yet a "1.0 product," and honestly it falls short of what most people would call a first usable version.
>
> **What actually works today** (shipped in the installer): text chat, the three-layer memory system, the growth timeline, the Live2D character window, and auto-update.
>
> **What does not**: everything voice-related. Speech synthesis and speech recognition are written and unit-tested, but **they do not work on a real machine yet** — see [Known Issues](#known-issues). Voice is **not** in the released installer.
>
> If you are looking for something to actually use day-to-day, this is not it yet. If you are here to read the code or follow along, welcome.

## What is this?

Nacime-soul is a Windows desktop application that hosts an AI companion character. Unlike a chat window that forgets you between sessions, it is built around a **persistent memory system**: it extracts facts about you from conversation, judges them for reliability, resolves contradictions, and lets memories decay and reactivate over time.

Design priorities, in order:

1. **Your data stays yours.** Chat content never enters logs. API keys go to the OS keychain, never to config files or logs. Speech audio is processed entirely locally and never leaves the machine — there is no cloud speech-recognition code path at all, by design.
2. **Never fake it.** If the voice engine cannot speak, it degrades to text and says so. It will never silently substitute a generic system voice for the character's voice.
3. **`main` is the source of truth.** The renderer holds a read-only projection; every write goes through a validated IPC channel.

## Progress & Roadmap

Grouped by faculty. `[x]` = built and passing automated tests. ⚠️ = built but **broken on real hardware**.

- [x] 🧠 **Brain** — thinking and remembering
  - [x] Streaming replies with visible reasoning
  - [x] Retry on failure; idempotent sending that survives a restart mid-send
  - [x] Three-layer memory: L0 profile / L1 state / L2 episodic
  - [x] Extraction → adjudication → conflict-resolution pipeline
  - [x] Vector retrieval (IVF index)
  - [x] DMAE — memory activation-decay engine, with a visualization panel (activation curves, anomaly rules, parameter health, benchmarks)
  - [ ] Ethics architecture — designed, not started
- [x] 👤 **Body** — being visible
  - [x] Transparent always-on-top Live2D stage window
  - [x] Model loading pipeline, idle animation, expression control
  - [ ] Viseme lip-sync — researched, blocked on working speech synthesis
- [x] 💗 **Heart** — growing together
  - [x] Growth value, milestones, shared-time timeline
  - [x] Persona prompts and seed memories
- [ ] 👄 **Mouth** — speaking ⚠️ *not in the released installer*
  - [x] GPT-SoVITS local custom-voice synthesis
  - [x] One-click install of the 8 GB official runtime (three download mirrors)
  - [x] Multi-voice profile registry with import
  - [ ] ⚠️ **Broken**: a freshly installed runtime is never recognized — see [V-01](#v-01--gpt-sovits-is-never-detected-after-a-fresh-install)
- [ ] 👂 **Ears** — listening ⚠️ *not in the released installer*
  - [x] Silero VAD, barge-in (interrupt her while she is speaking)
  - [x] SenseVoice and FunASR Paraformer recognition models
  - [ ] ⚠️ Four more models are implemented but **undownloadable from mainland China** — see [V-02](#v-02--four-speech-models-cannot-be-downloaded)
  - [x] Audio never leaves your machine — no cloud recognition path exists
- [x] 🛡️ **Foundation**
  - [x] `contextIsolation` + `sandbox` + CSP + two-layer network egress policy
  - [x] API keys in the OS keychain (`safeStorage`)
  - [x] SQLite (WAL) + atomic JSON writes
  - [x] Windows x64 auto-update via GitHub Releases
  - [ ] Code signing — scaffolded, no certificate yet (expect a SmartScreen warning)
  - [ ] macOS / Linux

## Known Issues

These are open, reproducible problems found during real-machine acceptance testing on 2026-09-03. All of them are in the **unmerged voice branch**, so they do not affect the released installer — but they are why voice has not shipped.

#### V-01 — GPT-SoVITS is never detected after a fresh install

**Severity: blocking.** The one-click installer downloads and verifies the 8 GB runtime correctly, but the app then reports "no complete local GPT-SoVITS package found."

Root cause: the validation predicate conflates two different questions — *"is there a runnable runtime?"* and *"is a voice already configured?"* — and rejects if either fails. A clean official package by definition contains no user-trained voice weights and no reference audio, so it is **always** rejected.

Worse, this creates a deadlock: with no detected installation, the provider is never registered and the voice dropdown is force-emptied, so **importing a voice cannot break the cycle either**. There is no user action that recovers from this.

*Fix direction:* split the predicate. Register the provider on the runtime alone; let a missing voice fall through to the existing text-only degrade path.

#### V-02 — Four speech models cannot be downloaded

**Severity: blocking (region-specific).** Two recognition models download fine; four fail 100% of the time, with or without a proxy.

The dividing line is the host, not the model: the working two are on GitHub Releases, the failing four are all on `huggingface.co`, which is unreachable from mainland China. Two compounding causes:

- The multi-file download path has **no mirror fallback**, while the GPT runtime downloader in the same repository has three mirrors and falls back correctly — which is exactly why the 8 GB package downloads but the smaller models do not.
- There is **no proxy support anywhere in the codebase**. Downloads use Node's `fetch`, which ignores system proxy settings, so turning on a proxy changes nothing.

A third constraint matters for whoever fixes this: the network policy performs a **local DNS lookup before every request** and blocks reserved addresses. Under DNS poisoning this rejects the request before a proxy could ever help, so proxy support cannot be added without also handling that pre-flight check.

*Fix direction:* add mirrors to the model catalog (the pinned per-file SHA-256 hashes remain valid on mirrors) and reuse the existing fallback loop.

#### V-03 — Voice preview does not work

Downstream of V-01. Needs re-testing once V-01 is fixed.

#### V-04 — Changing the asset directory requires a restart

By design (engines and download resume state are not hot-swapped), but the warning appears too late — after the user has already reached the download screen — and the download button is not disabled, so assets can still land in the old location.

#### V-05 — Voice acceptance testing: 0 of 8 checks passed

Of eight planned real-machine checks, none passed completely. Five were never reached because V-01 and V-02 block them: packaged-build microphone capture, offline recognition, multi-voice switching, barge-in echo behaviour, and the performance baseline.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Framework | Electron 43 + electron-vite 5 + Vue 3 + Pinia + vue-router |
| Storage | better-sqlite3 (WAL) + atomic JSON writes (config / secrets / memory / DMAE state) |
| Validation | valibot (config schema + IPC arguments) |
| Security | `contextIsolation` + `sandbox`, CSP, two-layer network policy, OS keychain |
| Speech *(unmerged)* | GPT-SoVITS (TTS) + sherpa-onnx (ASR) + Silero VAD — all local |
| Character | Live2D Cubism, transparent stage window |
| Updates | electron-updater + GitHub Releases (Windows x64 / NSIS) |
| Testing | Vitest (Electron Node env) + Playwright E2E + golden evals |

**Language models:** any OpenAI-compatible endpoint. Compatibility quirks are auto-detected for DeepSeek, OpenAI, Moonshot, Alibaba DashScope (Qwen) and OpenRouter; anything else works through a custom base URL.

## Getting Started

Download the installer from the [latest release](https://github.com/Cyclara/Nacime-soul/releases/latest) (Windows x64). It is unsigned, so Windows SmartScreen will warn you — that is expected until code signing is set up.

On first launch you will need an API key from an OpenAI-compatible provider. The key is stored in the Windows credential store, not in a config file.

## Development

```bash
npm install                    # postinstall rebuilds better-sqlite3 for Electron
npm run dev                    # development mode with HMR

npm run typecheck              # tsc (node) + vue-tsc (web)
npm run lint                   # eslint
npm test                       # full unit suite (Electron Node environment)
npm run test:coverage          # unit tests + coverage thresholds
npm run test:e2e               # build + Playwright Electron E2E

npm run build                  # electron-vite build
npm run build:win              # build + electron-builder NSIS installer
npm run gate                   # lint / typecheck / test / build + static scans
npm run smoke:packaged         # packaged-build smoke test
npm run check:repo-hygiene     # block build output, env files, certs from being committed
```

Run `npm run typecheck` before the test suite — the Vitest transform strips types without checking them, so type errors surface faster this way.

### Layout

```
src/
  main/      main process: config / security / IPC / chat / memory / DMAE / growth / migrations
  renderer/  renderer: stores / views / components / styles
  preload/   contextBridge — minimal exposed surface
  shared/    main ↔ renderer contracts (IPC channels / types / validators)
tests/       Playwright E2E + golden evals + helpers
resources/   persona prompts, seed memories, growth milestones
scripts/     gate, packaged smoke test, Vitest Electron runner
```

### Design constraints worth knowing

- **The IPC contract is interlocked at compile time**: `channels.ts` → `contracts.ts` → `validators.ts`, with `satisfies` forcing every channel to have a validator. Adding a channel without a validator will not compile.
- **Privacy is enforced structurally**, not by convention: the log whitelist cannot express chat content, and the idempotency ledger stores only hashes.
- **Errors never leak**: internal errors map to a fixed set of safe messages. Stack traces are neither written to disk nor sent to the UI.
- **The security baseline cannot be turned off** — see `src/main/security/window-config.ts`.

## Releases & Auto-update

Released Windows installers check GitHub Releases in the background and download stable updates automatically. Development and unpacked builds do not check for updates.

Publishing requires: a strictly higher SemVer, a full green gate (`gate` + `test:e2e` + `build:win` + `smoke:packaged`), and uploading `.exe`, `.exe.blockmap` and `latest.yml` **from the same build** to a single published, non-draft, non-prerelease Release. Never hand-edit `latest.yml` or the blockmap — mismatched files break update verification.

## Project Status

Actively developed by one person, with AI assistance for design and implementation. Development runs in phases: Phase 1 (chat foundation) and Phase 2 (memory, DMAE, growth) are complete and shipped; Phase 3a (Live2D) is merged; Phase 3b (voice) is written but blocked on the issues above.

Issues and pull requests are welcome, but response times will be irregular.

## License

[MIT](./LICENSE) © Cyclara
