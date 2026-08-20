<script setup lang="ts">
// P2-32: DmaePanelView -- DMAE 可视化面板主视图。
// 依据：F5-002 §3.1（wireframe）、F5-002-补充 §1.2（页面骨架）、§1.7（组件树）。
// 功能版（视觉待前端模型美化）。验收五项：三态计数/有资格集合/趋势≥2天/单条曲线/公式分解。
//
// 信息架构四层（F5-002-补充 §1.1）：状态总览 -> 异常告警 -> 时间趋势 -> 单条明细
// P2-32 anomalies=[]（P2-33 实现规则），告警区暂不渲染

import { onMounted, onUnmounted, computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { useDmaeStore } from '../stores/dmae'
import { useSettingsUiStore } from '../stores/settings-ui'
import DmaeStatusSummary from '../components/dmae/DmaeStatusSummary.vue'
import DmaeTrendChart from '../components/dmae/DmaeTrendChart.vue'
import DmaeMemoryTable from '../components/dmae/DmaeMemoryTable.vue'
import DmaeEntryDrawer from '../components/dmae/DmaeEntryDrawer.vue'

const router = useRouter()
const dmaeStore = useDmaeStore()
const settingsUi = useSettingsUiStore()
const { state, isEnabled } = storeToRefs(dmaeStore)

const hasTrendData = computed(() => state.value.trend.length >= 2)

const benchmark = computed(() => state.value.benchmark)
const benchmarkLoading = computed(() => state.value.benchmarkLoading)

/** P2-34：M1~M6 判定中文标签 */
const VERDICT_LABELS: Record<string, string> = {
  healthy: '健康',
  low: '偏低',
  high: '偏高',
  'at-floor': '贴近下限',
  mid: '区间中部',
  'at-ceiling': '贴近上限',
  'experimental-insufficient': '样本不足'
}

/** 定性评分表单（Q1~Q3 0-3） */
const q1 = ref(0)
const q2 = ref(0)
const q3 = ref(0)
const qnote = ref('')

function goBack(): void {
  void router.push('/memory')
}

function goSettings(): void {
  settingsUi.open('memory')
}

async function onRunBenchmark(): Promise<void> {
  await dmaeStore.runBenchmark(state.value.timeRange)
}

async function onSaveQualitative(): Promise<void> {
  await dmaeStore.recordQualitative({
    q1: q1.value,
    q2: q2.value,
    q3: q3.value,
    note: qnote.value.trim() || undefined
  })
}

onMounted(() => {
  void dmaeStore.hydrate()
})

onUnmounted(() => {
  dmaeStore.reset()
})
</script>

<template>
  <div class="dmae-panel-view">
    <header class="dmae-header">
      <button class="back-btn" aria-label="返回记忆面板" @click="goBack">← 记忆</button>
      <div class="dmae-heading">
        <h1 class="dmae-title">记忆引擎</h1>
        <p class="dmae-subtitle">她如何记住，也如何慢慢淡忘</p>
      </div>
      <div class="header-controls">
        <div class="density-switch" role="radiogroup" aria-label="显示密度">
          <button
            :class="['density-btn', { active: state.densityMode === 'narrative' }]"
            role="radio"
            :aria-checked="state.densityMode === 'narrative'"
            @click="dmaeStore.setDensityMode('narrative')"
          >
            叙事
          </button>
          <button
            :class="['density-btn', { active: state.densityMode === 'engineering' }]"
            role="radio"
            :aria-checked="state.densityMode === 'engineering'"
            @click="dmaeStore.setDensityMode('engineering')"
          >
            工程
          </button>
        </div>
        <div class="time-range-switch" role="radiogroup" aria-label="时间范围">
          <button
            v-for="d in [7, 30, 90] as const"
            :key="d"
            :class="['range-btn', { active: state.timeRange === d }]"
            role="radio"
            :aria-checked="state.timeRange === d"
            @click="dmaeStore.setTimeRange(d)"
          >
            {{ d }}天
          </button>
        </div>
        <button class="settings-btn" aria-label="设置参数" @click="goSettings">设置</button>
        <button class="refresh-btn" aria-label="刷新面板" @click="dmaeStore.refresh">刷新</button>
      </div>
    </header>

    <!-- disabled / 加载中 / 数据不足引导态 -->
    <div v-if="state.loading" class="dmae-empty" role="status" aria-live="polite">
      <p class="empty-text">正在查看她的记忆状态…</p>
    </div>
    <div v-else-if="!isEnabled" class="dmae-empty">
      <p class="empty-text">记忆引擎尚未开启。</p>
      <p class="empty-hint">在设置中开启 DMAE 引擎后，这里会显示她的记忆状态。</p>
      <button class="empty-action" @click="goSettings">去设置</button>
    </div>

    <!-- 正常态：四层信息架构 -->
    <div v-else-if="state.snapshot" class="dmae-content">
      <main class="dmae-main">
        <!-- ① 状态总览（验收①②：三态计数 + 有资格集合 + eligibleActive≠promptSelected） -->
        <DmaeStatusSummary :snapshot="state.snapshot" :density="state.densityMode" />

        <!-- ② 异常告警区（P2-33 实现后填充；P2-32 anomalies=[] 不渲染） -->
        <section v-if="state.snapshot.anomalies.length > 0" class="dmae-section">
          <h2 class="section-title">需要注意</h2>
          <!-- P2-33 的 DmaeAnomalySection 在此挂载 -->
        </section>

        <!-- ③ 时间趋势（验收③：趋势图渲染 ≥2 天数据） -->
        <section class="dmae-section">
          <h2 class="section-title">最近发生了什么</h2>
          <DmaeTrendChart
            :data="state.trend"
            :loading="state.trendLoading"
            :time-range="state.timeRange"
          />
          <p v-if="!hasTrendData && !state.trendLoading" class="section-hint">
            记录刚开始，再聊几天就能看到她记忆状态的变化了。
          </p>
        </section>

        <!-- ⑤ P2-34：参数基准体检（M1~M6 + Q1~Q3 定性） -->
        <section class="dmae-section benchmark-section">
          <div class="section-head">
            <h2 class="section-title">参数体检</h2>
            <button class="benchmark-btn" :disabled="benchmarkLoading" @click="onRunBenchmark">
              {{ benchmarkLoading ? '计算中…' : '运行体检' }}
            </button>
          </div>
          <template v-if="benchmark">
            <p v-if="!benchmark.sufficientSample" class="section-hint">
              样本不足（条目或轮次不够），指标仅供参考、不作判定。
            </p>
            <dl class="benchmark-grid">
              <div class="benchmark-row">
                <dt>M1 占位率</dt>
                <dd>{{ benchmark.metrics.activeUtilization.toFixed(2) }}</dd>
                <span class="verdict" :class="benchmark.verdicts.M1">{{
                  VERDICT_LABELS[benchmark.verdicts.M1]
                }}</span>
              </div>
              <div class="benchmark-row">
                <dt>M2 记忆半衰（轮）</dt>
                <dd>{{ benchmark.metrics.halfLifeTurns }}</dd>
                <span class="verdict experimental">{{
                  VERDICT_LABELS[benchmark.verdicts.M2]
                }}</span>
              </div>
              <div class="benchmark-row">
                <dt>M3 存活轮数中位</dt>
                <dd>{{ benchmark.metrics.medianLifespanTurns }}</dd>
                <span class="verdict experimental">{{
                  VERDICT_LABELS[benchmark.verdicts.M3]
                }}</span>
              </div>
              <div class="benchmark-row">
                <dt>M4 复用率</dt>
                <dd>{{ benchmark.metrics.reuseRate.toFixed(2) }}</dd>
                <span class="verdict" :class="benchmark.verdicts.M4">{{
                  VERDICT_LABELS[benchmark.verdicts.M4]
                }}</span>
              </div>
              <div class="benchmark-row">
                <dt>M5 冷冻率</dt>
                <dd>{{ benchmark.metrics.frozenRate.toFixed(2) }}</dd>
                <span class="verdict" :class="benchmark.verdicts.M5">{{
                  VERDICT_LABELS[benchmark.verdicts.M5]
                }}</span>
              </div>
              <div class="benchmark-row">
                <dt>M6 豁免占比</dt>
                <dd>{{ benchmark.metrics.exemptRatio.toFixed(2) }}</dd>
                <span class="verdict" :class="benchmark.verdicts.M6">{{
                  VERDICT_LABELS[benchmark.verdicts.M6]
                }}</span>
              </div>
            </dl>
            <p v-if="benchmark.comparedTo" class="section-hint">
              与上次体检对比：占位率 Δ{{
                benchmark.comparedTo.deltas.activeUtilization.toFixed(3)
              }}。
            </p>
            <p class="benchmark-tooltip">
              健康区间是产品语义锚点，不是科学真理——M2/M3 是实验性指标，只看趋势。
            </p>
          </template>
          <p v-else class="section-hint">运行体检后，这里会显示她当前记忆状态的六项指标。</p>

          <!-- Q1~Q3 定性评分 -->
          <div class="qualitative-form">
            <label class="q-label"
              >突兀感 <input v-model.number="q1" type="number" min="0" max="3" class="q-input"
            /></label>
            <label class="q-label"
              >失忆感 <input v-model.number="q2" type="number" min="0" max="3" class="q-input"
            /></label>
            <label class="q-label"
              >关心感 <input v-model.number="q3" type="number" min="0" max="3" class="q-input"
            /></label>
            <input v-model="qnote" class="q-note" placeholder="备注（可选）" maxlength="200" />
            <button class="benchmark-btn" @click="onSaveQualitative">记录定性评分</button>
          </div>
        </section>
      </main>

      <aside class="dmae-aside">
        <!-- ④ 有资格进入的记忆列表（验收①：显示"有资格进入"集合） -->
        <DmaeMemoryTable
          :entries="state.snapshot.activeSet"
          :density="state.densityMode"
          :max-active="state.snapshot.maxActive"
          @select="dmaeStore.openEntry"
        />

        <!-- 参数编辑已迁移到设置抽屉；诊断页只保留观测与体检。 -->
        <section class="dmae-section settings-callout">
          <h2 class="section-title">调整记忆节奏</h2>
          <p class="section-hint">
            参数与预设集中在设置的「记忆」分区，避免诊断数据与编辑草稿混在一起。
          </p>
          <button class="settings-link" @click="goSettings">打开记忆设置</button>
        </section>

        <!-- 状态文件健康度（工程档可见） -->
        <section v-if="state.densityMode === 'engineering'" class="dmae-section health-section">
          <h2 class="section-title">状态文件</h2>
          <dl class="health-list">
            <div class="health-row">
              <dt>条目数</dt>
              <dd>{{ state.snapshot.stateFile.entries }}</dd>
            </div>
            <div class="health-row">
              <dt>上次保存</dt>
              <dd>{{ state.snapshot.stateFile.lastSaveOk ? '成功' : '失败' }}</dd>
            </div>
            <div v-if="state.snapshot.stateFile.saveFailures7d > 0" class="health-row">
              <dt>近7天失败</dt>
              <dd class="health-warn">{{ state.snapshot.stateFile.saveFailures7d }} 次</dd>
            </div>
          </dl>
        </section>
      </aside>
    </div>

    <!-- ⑤ 单条记忆详情抽屉（验收④⑤：单条曲线 + 公式分解） -->
    <DmaeEntryDrawer
      :memory-id="state.selectedMemoryId"
      :explanation="state.explanation"
      :loading="state.explainLoading"
      :density="state.densityMode"
      @close="dmaeStore.closeEntry"
    />

    <!-- 错误提示 -->
    <transition name="slide-down">
      <div v-if="state.lastError" class="error-banner" role="alert">
        <span class="error-icon">⚠</span>
        <span class="error-message">{{ state.lastError.message }}</span>
      </div>
    </transition>
  </div>
</template>

<style scoped>
.dmae-panel-view {
  position: relative;
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background:
    radial-gradient(circle at 12% 0%, var(--color-companion-soft), transparent 28%),
    radial-gradient(circle at 92% 10%, var(--color-accent-soft), transparent 27%), var(--color-bg);
}

.dmae-header {
  position: relative;
  z-index: 5;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  min-height: 74px;
  flex-shrink: 0;
  align-items: center;
  gap: 16px;
  padding: 10px clamp(14px, 2.2vw, 26px);
  border-bottom: 1px solid var(--color-border-subtle);
  background: var(--color-surface-translucent);
  backdrop-filter: blur(18px) saturate(112%);
}

.back-btn {
  justify-self: start;
  min-height: 38px;
  padding: 7px 11px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--color-surface) 74%, transparent);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.back-btn:hover {
  border-color: color-mix(in srgb, var(--color-accent) 28%, var(--color-border));
  background: var(--color-accent-soft);
  color: var(--color-text);
  transform: translateY(-1px);
}

.dmae-heading {
  display: flex;
  min-width: 0;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  text-align: center;
}

.dmae-title {
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: clamp(21px, 2.2vw, 26px);
  font-weight: 600;
  letter-spacing: 0.015em;
}

.dmae-subtitle {
  color: var(--color-text-muted);
  font-size: 10px;
  letter-spacing: 0.025em;
}

.header-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-self: end;
  justify-content: flex-end;
  gap: 7px;
}

.density-switch,
.time-range-switch {
  display: flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--color-surface) 76%, transparent);
}

.density-btn,
.range-btn {
  min-height: 30px;
  padding: 5px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-full);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: 500;
}

.density-btn:hover,
.range-btn:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
}

.density-btn.active,
.range-btn.active {
  border-color: color-mix(in srgb, var(--color-accent) 24%, transparent);
  background: var(--color-accent);
  box-shadow:
    inset 0 1px rgba(255, 255, 255, 0.2),
    var(--shadow-sm);
  color: var(--color-text-on-accent);
}

.settings-btn {
  min-height: 36px;
  padding: 6px 11px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: var(--color-companion-soft);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.settings-btn:hover {
  border-color: color-mix(in srgb, var(--color-companion) 30%, var(--color-border));
  background: color-mix(in srgb, var(--color-companion-soft) 72%, var(--color-surface));
  color: var(--color-text);
}

.refresh-btn {
  min-height: 36px;
  padding: 6px 11px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: var(--color-accent-soft);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.refresh-btn:hover {
  border-color: color-mix(in srgb, var(--color-accent) 30%, var(--color-border));
  background: var(--color-accent-soft-hover);
  color: var(--color-text);
}

.dmae-content {
  display: grid;
  grid-template-columns: minmax(0, 1.65fr) minmax(320px, 0.85fr);
  width: min(100%, 1460px);
  min-height: 0;
  flex: 1;
  align-self: center;
  align-items: start;
  gap: 16px;
  padding: 18px clamp(14px, 2.2vw, 26px) 28px;
  overflow-y: auto;
}

.dmae-main,
.dmae-aside {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 16px;
}

.dmae-section {
  padding: 18px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-surface-translucent);
  box-shadow:
    var(--shadow-sm),
    inset 0 1px rgba(255, 255, 255, 0.025);
  backdrop-filter: blur(12px);
}

.section-title {
  margin-bottom: 12px;
  color: var(--color-text-secondary);
  font-family: var(--font-family-display);
  font-size: var(--font-size-lg);
  font-weight: 600;
  letter-spacing: 0.01em;
}

.section-hint {
  margin-top: 10px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.55;
}

.settings-callout {
  background:
    linear-gradient(145deg, var(--color-companion-soft), transparent 58%),
    var(--color-surface-translucent);
}

.settings-callout .section-hint {
  margin-top: 0;
}

.settings-link {
  min-height: 36px;
  margin-top: 13px;
  padding: 6px 13px;
  border: 1px solid color-mix(in srgb, var(--color-companion) 30%, var(--color-border));
  border-radius: var(--radius-full);
  background: var(--color-surface-elevated);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.settings-link:hover {
  background: var(--color-companion-soft);
  color: var(--color-text);
  transform: translateY(-1px);
}

.dmae-empty {
  position: relative;
  display: flex;
  width: min(calc(100% - 32px), 560px);
  min-height: 340px;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: auto;
  padding: 44px 32px 36px;
  overflow: hidden;
  border: 1px solid var(--color-border-subtle);
  border-radius: 28px;
  background: var(--color-surface-translucent);
  box-shadow:
    var(--shadow-lg),
    inset 0 1px rgba(255, 255, 255, 0.035);
  text-align: center;
  backdrop-filter: blur(18px);
}

.dmae-empty::before {
  width: 86px;
  height: 86px;
  margin-bottom: 18px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 28px 28px 28px 10px;
  background:
    radial-gradient(circle at 50% 50%, var(--color-accent) 0 6px, transparent 7px),
    radial-gradient(
      circle at 50% 50%,
      transparent 0 22px,
      var(--color-accent-soft-hover) 23px 24px,
      transparent 25px
    ),
    radial-gradient(circle at 70% 30%, var(--color-companion) 0 4px, transparent 5px),
    var(--color-bg-tertiary);
  box-shadow: var(--shadow-md);
  content: '';
}

.dmae-empty::after {
  position: absolute;
  top: -78px;
  right: -60px;
  width: 210px;
  height: 210px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--color-accent-soft), transparent 66%);
  content: '';
  pointer-events: none;
}

.empty-text,
.empty-hint,
.empty-action {
  position: relative;
  z-index: 1;
}

.empty-text {
  color: var(--color-text);
  font-family: var(--font-family-display);
  font-size: clamp(20px, 2.4vw, 25px);
}

.empty-hint {
  max-width: 38ch;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.65;
}

.empty-action {
  min-height: 43px;
  margin-top: 10px;
  padding: 9px 20px;
  border-radius: var(--radius-full);
  background: var(--color-accent);
  box-shadow:
    inset 0 1px rgba(255, 255, 255, 0.22),
    var(--shadow-sm);
  color: var(--color-text-on-accent);
  font-size: var(--font-size-base);
  font-weight: 600;
}

.empty-action:hover {
  background: var(--color-accent-hover);
  box-shadow: var(--shadow-md);
  transform: translateY(-1px);
}

.health-section {
  background: color-mix(in srgb, var(--color-surface-translucent) 80%, transparent);
}

.health-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.health-row {
  display: flex;
  justify-content: space-between;
  padding: 6px 0;
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--font-size-xs);
}

.health-row:last-child {
  border-bottom: 0;
}

.health-row dt {
  color: var(--color-text-muted);
}

.health-row dd {
  color: var(--color-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.health-warn {
  color: var(--color-warning);
}

.section-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.section-head .section-title {
  margin-bottom: 0;
}

.benchmark-btn {
  min-height: 34px;
  padding: 6px 14px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-full);
  background: var(--color-accent-soft);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.benchmark-btn:hover:not(:disabled) {
  border-color: color-mix(in srgb, var(--color-accent) 30%, var(--color-border));
  color: var(--color-text);
}

.benchmark-btn:disabled {
  opacity: 0.55;
}

.benchmark-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 12px;
}

.benchmark-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: 10px;
  padding: 7px 10px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--color-bg-tertiary) 55%, transparent);
  font-size: var(--font-size-sm);
}

.benchmark-row dt {
  color: var(--color-text-secondary);
}

.benchmark-row dd {
  color: var(--color-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
}

.verdict {
  min-width: 46px;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: var(--color-state-active-bg);
  color: var(--color-state-active);
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-align: center;
}

.verdict.low {
  background: var(--color-warning-bg);
  color: var(--color-warning);
}

.verdict.high {
  background: var(--color-error-bg);
  color: var(--color-error);
}

.verdict.experimental {
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
}

.benchmark-tooltip {
  margin-top: 8px;
  color: var(--color-text-muted);
  font-size: 10px;
  line-height: 1.5;
}

.qualitative-form {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px solid var(--color-border-subtle);
}

.q-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.q-input {
  width: 44px;
  min-height: 28px;
  padding: 3px 6px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.q-note {
  flex: 1;
  min-width: 140px;
  min-height: 30px;
  padding: 5px 9px;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text);
  font-size: var(--font-size-xs);
}

.error-banner {
  position: absolute;
  z-index: 80;
  right: 18px;
  bottom: 18px;
  display: flex;
  max-width: min(460px, calc(100% - 36px));
  align-items: center;
  gap: 10px;
  padding: 10px 13px;
  border: 1px solid var(--color-error-border);
  border-radius: var(--radius);
  background: var(--color-surface-translucent);
  box-shadow: var(--shadow-md);
  color: var(--color-error);
  font-size: var(--font-size-sm);
  backdrop-filter: blur(14px);
}

.error-icon {
  flex-shrink: 0;
}

.slide-down-enter-active,
.slide-down-leave-active {
  transition:
    transform 0.25s ease,
    opacity 0.25s ease;
}

.slide-down-enter-from,
.slide-down-leave-to {
  opacity: 0;
  transform: translateY(12px);
}

@media (max-width: 1180px) {
  .dmae-content {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 900px) {
  .dmae-header {
    grid-template-columns: 1fr auto 1fr;
    gap: 10px;
    padding-bottom: 9px;
  }

  .back-btn {
    grid-column: 1;
  }

  .dmae-heading {
    grid-column: 2;
    align-items: center;
    text-align: center;
  }

  .header-controls {
    grid-row: 2;
    grid-column: 1 / -1;
    width: 100%;
    justify-content: center;
    padding-top: 8px;
    border-top: 1px solid var(--color-border-subtle);
  }
}

@media (max-width: 600px) {
  .dmae-content {
    padding: 12px 10px 20px;
  }

  .dmae-header {
    min-height: 64px;
  }

  .dmae-subtitle {
    display: none;
  }

  .density-btn,
  .range-btn,
  .settings-btn {
    min-height: 36px;
  }

  .dmae-empty {
    min-height: 300px;
    padding-inline: 22px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .slide-down-enter-active,
  .slide-down-leave-active {
    transition: none;
  }
}
</style>
