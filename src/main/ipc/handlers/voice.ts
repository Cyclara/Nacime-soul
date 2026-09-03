// src/main/ipc/handlers/voice.ts
// P3B-14：语音设置 / 语音输入 handler（chat capability）。
//
// 通道面：
//   invoke  get-asr-overview / asr-download-model / asr-cancel-download /
//           asr-select-engine（P3B-14 新增，台账登记）
//           start-listening / stop-listening（P3-00D 冻结名，测试录音先落地）
//   event   voice-state（冻结名，载荷 VoiceEvent）
//           asr-model-state（下载/引擎状态刷新源）
//   port    `voice:mic-port`（ipcRenderer.postMessage 转交，**不登记通道名**，
//           与 TTS PCM 同红线；由 registerPortReceiver 收，capability=chat）
//
// 纪律：handler 不 await 长下载（downloadModel 即发即回，进度走 event）；
// 引擎选择失败/模型缺失走 AppError → IpcResult error，renderer 呈现 userMessage。

import { basename } from 'node:path'
import type { Logger } from '@shared/observability/types'
import { AppError } from '@shared/errors'
import type { GptRuntimeOverview, GptVoiceFileKind } from '@shared/voice/gpt-runtime-types'
import type { AsrEngineManager } from '../../voice/asr/engine-manager'
import type { AssetRootService } from '../../voice/asset-root-service'
import type { VoiceListeningService, MicPortMainLike } from '../../voice/listening-service'
import type { VoiceOrchestrator } from '../../voice/orchestrator'
import {
  GPT_RUNTIME_CATALOG,
  GPT_RUNTIME_MIN_FREE_BYTES
} from '../../voice/tts/gpt-runtime-catalog'
import type { GptRuntimeManager } from '../../voice/tts/gpt-runtime-manager'
import type { GptRuntimeSourceService } from '../../voice/tts/gpt-runtime-source'
import type { VoiceProfileRegistry } from '../../voice/tts/voice-profile-registry'
import { registerPortReceiver, registerValidatedHandler } from '../register'

export interface VoiceHandlerDeps {
  readonly logger: Logger
  readonly engineManager: AsrEngineManager
  readonly listening: VoiceListeningService
  /** P3B-18：TTS 编排（get-state / test-tts / cancel-speaking 三冻结通道）。 */
  readonly orchestrator: VoiceOrchestrator
  /** 通知 handler 层把最新 overview 推送 chat renderer（manager.onOverviewChange 桥接）。 */
  readonly emitAsrOverview: () => void
  /** P3V-10：大资源根目录服务（get/choose/reset-asset-root 三通道）。 */
  readonly assetRoot: AssetRootService
  /**
   * P3V-10：原生目录选择（生产 = dialog.showOpenDialog；测试注入假件）。
   * 返回 null = 用户取消。路径只在 main 与本回调里出现，不回传 renderer。
   */
  readonly chooseAssetDirectory: () => Promise<string | null>
  /** P3V-16：GPT-SoVITS 运行时下载/安装器（6 通道）。 */
  readonly gptRuntime: GptRuntimeManager
  /**
   * P3V-16：本机是否已有可用的**外部** GPT-SoVITS 安装（只读发现结果）。
   * 只用于告诉用户「不必再下 8GB」；Nacime 绝不接管或修改外部目录。
   */
  readonly gptRuntimeExternalDetected: () => boolean
  /** P3V-17：运行时来源（自动发现 / 用户指定目录；选择重启后生效）。 */
  readonly gptRuntimeSource: GptRuntimeSourceService
  /**
   * P3V-17：选择已有 GPT-SoVITS 目录（生产 = dialog.showOpenDialog）。
   * 返回 null = 用户取消；路径只在 main 与本回调里出现。
   */
  readonly chooseGptRuntimeDirectory: () => Promise<string | null>
  /** P3V-18：多音色 profile 注册表（投影无路径）。 */
  readonly voiceProfiles: VoiceProfileRegistry
  /** P3V-18：当前选中的音色 id（唯一真源 = config `tts.voiceId`；空 = 未选）。 */
  readonly currentVoiceId: () => string
  /**
   * P3V-20：挑一个音色文件（生产 = dialog.showOpenDialog + 类型过滤）。
   * 返回 null = 用户取消。**路径只在 main 暂存**，回 renderer 的只有文件名。
   */
  readonly pickVoiceFile: (kind: GptVoiceFileKind) => Promise<string | null>
  /** P3V-20：读取已暂存的三个文件路径（未选齐时对应项为 null）。 */
  readonly stagedVoiceFiles: () => Readonly<Record<GptVoiceFileKind, string | null>>
  /** P3V-20：导入成功后清空暂存槽。 */
  readonly clearStagedVoiceFiles: () => void
}

/**
 * 组装 GPT runtime 设置页投影。
 *
 * freeBytes/rootState 取自 assetRoot.status()（= 用户当前选择的根）——与设置页
 * 其它位置显示的空间口径一致。硬门禁在 manager 内：真正开下前按**本会话活跃根**
 * 复查空间，不足直接 disk-full，不靠这里的展示数字把关。
 */
async function buildGptRuntimeOverview(deps: VoiceHandlerDeps): Promise<GptRuntimeOverview> {
  const recommended = await deps.gptRuntime.recommendedVariant()
  const installedRuntime = deps.gptRuntime.installed()
  const rootStatus = deps.assetRoot.status()
  const variants = Object.values(GPT_RUNTIME_CATALOG).map((pkg) => ({
    variant: pkg.variant,
    displayName: pkg.displayName,
    downloadBytes: pkg.bytes,
    recommended: pkg.variant === recommended
  }))
  // 展示「当前这件事」：进行中的优先，其次最近一次非 idle 的（done/error/paused）
  const active = variants.find((v) => deps.gptRuntime.isActive(v.variant))
  const lingering = variants.find((v) => deps.gptRuntime.state(v.variant).kind !== 'idle')
  const focused = active ?? lingering
  return {
    source: {
      mode: deps.gptRuntimeSource.mode(),
      active: deps.gptRuntimeSource.active(),
      voiceConfigured: deps.gptRuntimeSource.voiceConfigured(),
      restartRequired: deps.gptRuntimeSource.restartRequired()
    },
    voices: deps.voiceProfiles.views(deps.currentVoiceId()),
    installed:
      installedRuntime === null
        ? null
        : {
            variant: installedRuntime.variant,
            displayName: GPT_RUNTIME_CATALOG[installedRuntime.variant].displayName,
            installedAt: installedRuntime.installedAt
          },
    externalDetected: deps.gptRuntimeExternalDetected(),
    variants,
    download: focused === undefined ? null : deps.gptRuntime.status(focused.variant),
    minFreeBytes: GPT_RUNTIME_MIN_FREE_BYTES,
    freeBytes: rootStatus.freeBytes,
    rootState: rootStatus.state
  }
}

export function registerVoiceHandlers(deps: VoiceHandlerDeps): void {
  registerValidatedHandler('companion:voice:get-asr-overview', () => {
    return deps.engineManager.getOverview()
  })

  registerValidatedHandler('companion:voice:asr-download-model', (_ctx, input) => {
    if (!deps.engineManager.getOverview().engines.some((e) => e.engineId === input.engineId)) {
      throw new AppError({
        code: 'IPC_VALIDATION',
        userMessage: '未知的语音识别引擎',
        severity: 'error',
        retryable: false
      })
    }
    deps.engineManager.downloadModel(input.engineId)
    return { ok: true }
  })

  registerValidatedHandler('companion:voice:asr-cancel-download', (_ctx, input) => {
    return { ok: true, cancelled: deps.engineManager.cancelDownload(input.engineId) }
  })

  registerValidatedHandler('companion:voice:asr-pause-download', (_ctx, input) => {
    return { ok: true, paused: deps.engineManager.pauseDownload(input.engineId) }
  })

  registerValidatedHandler('companion:voice:asr-resume-download', (_ctx, input) => {
    return { ok: true, resumed: deps.engineManager.resumeDownload(input.engineId) }
  })

  registerValidatedHandler('companion:voice:asr-delete-model', async (_ctx, input) => {
    if (deps.listening.active) {
      throw new AppError({
        code: 'ASR_BUSY',
        userMessage: '正在听你说话，请先停止语音输入再删除模型',
        severity: 'error',
        retryable: true
      })
    }
    const ok = await deps.engineManager.deleteModel(input.engineId)
    if (!ok) {
      throw new AppError({
        code: 'ASR_BUSY',
        userMessage: '模型正在使用或下载中，请停止语音和下载后再删除',
        severity: 'error',
        retryable: true
      })
    }
    return { ok: true }
  })

  registerValidatedHandler('companion:voice:asr-select-engine', async (_ctx, input) => {
    const ok = await deps.engineManager.selectEngine(input.engineId)
    if (!ok) {
      throw new AppError({
        code: 'CFG_INVALID',
        userMessage: '切换语音识别引擎失败，请重试',
        severity: 'error',
        retryable: true
      })
    }
    return { ok: true }
  })

  // ── P3V-09：备用引擎（null = 清除；主备同体由 manager 拒绝）──
  registerValidatedHandler('companion:voice:asr-set-fallback-engine', async (_ctx, input) => {
    const ok = await deps.engineManager.setFallbackEngine(input.engineId)
    if (!ok) {
      throw new AppError({
        code: 'CFG_INVALID',
        userMessage: '设置备用语音识别引擎失败，请重试',
        severity: 'error',
        retryable: true
      })
    }
    return { ok: true }
  })

  // ── P3V-10：大资源根目录（响应无路径——只有 isDefault/freeBytes/state）──
  registerValidatedHandler('companion:voice:get-asset-root', () => {
    return deps.assetRoot.status()
  })

  registerValidatedHandler('companion:voice:choose-asset-root', async () => {
    const picked = await deps.chooseAssetDirectory()
    if (picked === null) {
      // 用户取消：不是错误，changed=false；若此前已有待生效换根，重启提示不能被取消操作清掉
      return {
        status: deps.assetRoot.status(),
        changed: false,
        restartRequired: deps.assetRoot.restartRequired()
      }
    }
    return deps.assetRoot.setRoot(picked)
  })

  registerValidatedHandler('companion:voice:reset-asset-root', () => {
    return deps.assetRoot.resetRoot()
  })

  // ── P3V-16：GPT-SoVITS 运行时一键安装（8GB 级；进度走 asset-download 事件）──
  registerValidatedHandler('companion:voice:get-gpt-runtime', () => buildGptRuntimeOverview(deps))

  registerValidatedHandler('companion:voice:gpt-runtime-install', (_ctx, input) => {
    const rootState = deps.assetRoot.status().state
    if (rootState !== 'ok') {
      // 根目录不可用时直接拒绝：不让用户白等一个注定失败的 8GB 下载
      throw new AppError({
        code: 'CFG_INVALID',
        userMessage:
          rootState === 'missing'
            ? '语音资源存放位置当前不可用（磁盘可能没有连接），请先在设置里改回可用位置'
            : '语音资源存放位置不可写，请换一个位置再安装',
        severity: 'error',
        retryable: true
      })
    }
    // 即发即回：长任务状态经 companion:event:asset-download 推送
    void deps.gptRuntime.download(input.variant)
    return { ok: true }
  })

  registerValidatedHandler('companion:voice:gpt-runtime-pause-download', (_ctx, input) => {
    return { ok: true, paused: deps.gptRuntime.pause(input.variant) }
  })

  registerValidatedHandler('companion:voice:gpt-runtime-resume-download', (_ctx, input) => {
    return { ok: true, resumed: deps.gptRuntime.resume(input.variant) }
  })

  registerValidatedHandler('companion:voice:gpt-runtime-cancel-download', (_ctx, input) => {
    return { ok: true, cancelled: deps.gptRuntime.cancel(input.variant) }
  })

  // ── P3V-17：选择/清除已有安装目录（外部目录只读；重启后生效）──
  registerValidatedHandler('companion:voice:choose-gpt-runtime-dir', async () => {
    const picked = await deps.chooseGptRuntimeDirectory()
    if (picked === null) {
      // 用户取消不是错误：原样回当前状态，别把已有的「待重启」提示冲掉
      return {
        overview: await buildGptRuntimeOverview(deps),
        changed: false,
        accepted: false,
        reason: 'cancelled' as const
      }
    }
    const result = deps.gptRuntimeSource.setCustomDirectory(picked)
    return {
      overview: await buildGptRuntimeOverview(deps),
      changed: result.changed,
      accepted: result.accepted,
      ...(result.reason === undefined ? {} : { reason: result.reason })
    }
  })

  registerValidatedHandler('companion:voice:clear-gpt-runtime-dir', async () => {
    const { changed } = deps.gptRuntimeSource.clearCustomDirectory()
    return { overview: await buildGptRuntimeOverview(deps), changed, accepted: true }
  })

  // ── P3V-20：本地导入音色（三个文件在 main 挑选并暂存；renderer 只见文件名）──
  registerValidatedHandler('companion:voice:pick-gpt-voice-file', async (_ctx, input) => {
    const picked = await deps.pickVoiceFile(input.kind)
    if (picked === null) return { picked: false, kind: input.kind }
    return { picked: true, kind: input.kind, fileName: basename(picked) }
  })

  registerValidatedHandler('companion:voice:import-gpt-voice', async (_ctx, input) => {
    const staged = deps.stagedVoiceFiles()
    const gptWeightsPath = staged['gpt-weights']
    const sovitsWeightsPath = staged['sovits-weights']
    const refAudioPath = staged['ref-audio']
    if (gptWeightsPath === null || sovitsWeightsPath === null || refAudioPath === null) {
      // 三件缺一都不能导入：宁可拒绝，也不存一个注定发不出声的 profile
      return {
        ok: false,
        reason: 'files-missing' as const,
        overview: await buildGptRuntimeOverview(deps)
      }
    }
    const { added, id } = deps.voiceProfiles.add({
      displayName: input.displayName.trim(),
      version: input.version,
      gptWeightsPath,
      sovitsWeightsPath,
      refAudioPath,
      promptText: input.promptText.trim(),
      promptLang: input.promptLang,
      defaultTextLang: input.defaultTextLang
    })
    if (added) deps.clearStagedVoiceFiles()
    return {
      ok: added,
      voiceId: id,
      ...(added ? {} : { reason: 'duplicate' as const }),
      overview: await buildGptRuntimeOverview(deps)
    }
  })

  registerValidatedHandler('companion:voice:delete-gpt-voice', async (_ctx, input) => {
    // discovered 音色删不掉（它来自安装自身的配置）——registry 返回 false，如实回 ok:false
    const ok = deps.voiceProfiles.remove(input.voiceId)
    return { ok, overview: await buildGptRuntimeOverview(deps) }
  })

  registerValidatedHandler('companion:voice:gpt-runtime-delete', async () => {
    const ok = await deps.gptRuntime.deleteRuntime()
    if (!ok) {
      throw new AppError({
        code: 'TTS_RUNTIME_BUSY',
        userMessage: '语音引擎正在下载或安装中，请先取消再删除',
        severity: 'error',
        retryable: true
      })
    }
    return { ok: true }
  })

  registerValidatedHandler('companion:voice:start-listening', async () => {
    await deps.listening.start()
    return { ok: true }
  })

  registerValidatedHandler('companion:voice:stop-listening', async () => {
    await deps.listening.stop()
    return { ok: true }
  })

  // ── P3B-18：TTS 编排（VoiceOrchestrator）──
  registerValidatedHandler('companion:voice:get-state', () => {
    return deps.orchestrator.getState()
  })

  registerValidatedHandler('companion:voice:test-tts', async (_ctx, input) => {
    // 即发即回：试听结果经 voice-state 事件（speaking-started/ended）投影
    await deps.orchestrator.testTts(input.text)
  })

  registerValidatedHandler('companion:voice:cancel-speaking', () => {
    deps.orchestrator.cancelSpeaking()
  })

  // 麦克风 PCM 数据面：port 转交（不登记通道名）。capability=chat 由
  // registerPortReceiver 校验；无活跃监听会话时 port 立即关闭。
  registerPortReceiver('voice:mic-port', (port) => {
    const portLike: MicPortMainLike = {
      on: (event, listener) => {
        if (event === 'message') {
          port.on('message', listener as (event: { data: unknown }) => void)
        } else {
          port.on('close', listener as () => void)
        }
      },
      start: () => port.start(),
      close: () => port.close()
    }
    deps.listening.acceptMicPort(portLike)
  })
}
