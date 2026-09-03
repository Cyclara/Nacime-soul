// src/main/voice/vad/vad.test.ts
// P3B-12：三态状态机合同测试（fake frames：prob/db 直接注入 + 1 样本标记 chunk，
// 内容可精确断言）。验收：全状态、短停顿、句首不截断、有界性、flush/reset。
//
// 帧数学（窗口 5、双门 0.4/60，均有注释推演）：
//   冷启动全有声：窗口未满即均值 1/80 → 第 1 帧就 pass → 第 3 帧触发（hits=3）。
//   静音历史后有声：db 窗需 5 帧翻正（-140→80 的滑入）→ 第 5 帧 pass、第 7 帧触发。
//   有声历史后静音：db 窗需 4 帧翻负（80→-140）→ miss 从第 1 帧起累计。

import { describe, expect, it } from 'vitest'
import {
  computeChunkDb,
  createVadStateMachine,
  VAD_DB_THRESHOLD,
  VAD_PRE_BUFFER_MAX_CHUNKS,
  VAD_PROB_THRESHOLD,
  VAD_REQUIRED_HITS,
  VAD_REQUIRED_MISSES,
  VAD_SMOOTHING_WINDOW,
  VAD_WINDOW_SAMPLES,
  type VadEvent,
  type VadFrame
} from './vad'
import { makeSilentPcm16, makeSinePcm16 } from '../../../../tests/helpers/silent-pcm'

/** 通过帧（prob=1、db=80：两门全过）。 */
const SPEECH: VadFrame = { prob: 1, db: 80 }
/** 不通过帧（prob=0、db=-140：两门全挂）。 */
const SILENCE: VadFrame = { prob: 0, db: -140 }

/** 第 i 帧的标记 chunk（1 样本，值=i+1），用于精确断言事件音频内容。 */
function marker(i: number): Int16Array {
  return new Int16Array([i + 1])
}

function feed(
  machine: ReturnType<typeof createVadStateMachine>,
  frame: VadFrame,
  chunk: Int16Array
): VadEvent | null {
  return machine.process(frame, chunk)
}

describe('P3B-12 常量冻结（与 Open-LLM-VTuber 参考实现核对）', () => {
  it('窗口 5 / 前缓冲 20 / hits 3 / misses 24 / 阈值 0.4 与 60 / 窗 512', () => {
    expect(VAD_SMOOTHING_WINDOW).toBe(5)
    expect(VAD_PRE_BUFFER_MAX_CHUNKS).toBe(20)
    expect(VAD_REQUIRED_HITS).toBe(3)
    expect(VAD_REQUIRED_MISSES).toBe(24)
    expect(VAD_PROB_THRESHOLD).toBe(0.4)
    expect(VAD_DB_THRESHOLD).toBe(60)
    expect(VAD_WINDOW_SAMPLES).toBe(512)
  })
})

describe('P3B-12 IDLE→ACTIVE：延迟确认与句首前缓冲', () => {
  it('冷启动机器连续命中第 3 帧发 speech_start（窗口未满，均值=全 1/80）', () => {
    const machine = createVadStateMachine()
    expect(feed(machine, SPEECH, marker(0))).toBeNull()
    expect(feed(machine, SPEECH, marker(1))).toBeNull()
    const event = feed(machine, SPEECH, marker(2))
    expect(event?.type).toBe('speech_start')
    expect(machine.state).toBe('active')
  })

  it('静音历史后的暖机代价：db 窗需 5 帧翻正，第 7 帧才触发（平滑抗瞬时噪声）', () => {
    const machine = createVadStateMachine()
    for (let i = 0; i < 25; i++) feed(machine, SILENCE, marker(i))
    // db 窗从 [-140×5] 滑入 80：第 5 帧均值才到 80（pass），再加 3 个命中帧
    for (let i = 25; i < 31; i++) {
      expect(feed(machine, SPEECH, marker(i))).toBeNull()
    }
    const event = feed(machine, SPEECH, marker(31))
    expect(event?.type).toBe('speech_start')
  })

  it('句首不截断：speech_start 携带前缓冲快照（滚动 ≤20 块，含暖机帧）', () => {
    const machine = createVadStateMachine()
    for (let i = 0; i < 30; i++) feed(machine, SILENCE, marker(i))
    let event: VadEvent | null = null
    for (let i = 30; i < 45; i++) {
      const ev = feed(machine, SPEECH, marker(i))
      if (ev !== null) {
        event = ev
        break
      }
    }
    expect(event?.type).toBe('speech_start')
    if (event?.type !== 'speech_start') return
    // 30 帧静音 + 7 帧暖机（仍在 IDLE，前缓冲继续滚动）：触发时恰留最后 20 块
    expect(event.preBuffer.length).toBe(VAD_PRE_BUFFER_MAX_CHUNKS)
    expect(Array.from(event.preBuffer)).toEqual(Array.from({ length: 20 }, (_, k) => k + 18))
  })

  it('能量门单独拦截：prob 高但 db 低（设备稳态噪声）永不激活', () => {
    const machine = createVadStateMachine()
    for (let i = 0; i < 100; i++) {
      expect(feed(machine, { prob: 1, db: -140 }, marker(i))).toBeNull()
    }
    expect(machine.state).toBe('idle')
  })

  it('概率门单独拦截：db 高但 prob 低（非语音能量）永不激活', () => {
    const machine = createVadStateMachine()
    for (let i = 0; i < 100; i++) {
      expect(feed(machine, { prob: 0, db: 80 }, marker(i))).toBeNull()
    }
    expect(machine.state).toBe('idle')
  })
})

describe('P3B-12 ACTIVE→INACTIVE→IDLE：短停顿与话语结束', () => {
  function activatedMachine(): ReturnType<typeof createVadStateMachine> {
    const machine = createVadStateMachine()
    for (let i = 0; i < 10; i++) feed(machine, SPEECH, marker(i))
    expect(machine.state).toBe('active')
    return machine
  }

  it('15 帧短停顿后恢复：全程无事件、始终在话语内（短停顿不截断）', () => {
    const machine = activatedMachine()
    for (let i = 10; i < 25; i++) {
      expect(feed(machine, SILENCE, marker(i))).toBeNull()
    }
    expect(machine.state).toBe('active')
    for (let i = 25; i < 35; i++) {
      expect(feed(machine, SPEECH, marker(i))).toBeNull()
    }
    expect(machine.state).toBe('active')
  })

  it('24 帧静音 → INACTIVE（无事件）；再 24 帧静音 → speech_end(silence)', () => {
    const machine = activatedMachine()
    for (let i = 10; i < 34; i++) {
      expect(feed(machine, SILENCE, marker(i))).toBeNull()
    }
    expect(machine.state).toBe('inactive')
    for (let i = 34; i < 57; i++) {
      expect(feed(machine, SILENCE, marker(i))).toBeNull()
    }
    const event = feed(machine, SILENCE, marker(57))
    expect(event?.type).toBe('speech_end')
    if (event?.type !== 'speech_end') return
    expect(event.reason).toBe('silence')
    expect(machine.state).toBe('idle')
    // 冷启动机器：前缓冲=[1,2,3]（命中暖机帧），话语=[4..58]；拼接恰为 1..58 连续
    expect(event.audio.length).toBe(58)
    expect(Array.from(event.audio)).toEqual(Array.from({ length: 58 }, (_, k) => k + 1))
  })

  it('停顿跨 INACTIVE 后恢复：结束音频包含停顿段，连续无缺口', () => {
    const machine = activatedMachine()
    // 30 帧静音（>24 → INACTIVE，但 <48 话语未结束）+ 10 帧恢复 + 48 帧静音结束
    for (let i = 10; i < 40; i++) feed(machine, SILENCE, marker(i))
    expect(machine.state).toBe('inactive')
    for (let i = 40; i < 50; i++) feed(machine, SPEECH, marker(i))
    expect(machine.state).toBe('active')
    let event: VadEvent | null = null
    for (let i = 50; i < 98; i++) {
      const ev = feed(machine, SILENCE, marker(i))
      if (ev !== null) {
        event = ev
        break
      }
    }
    expect(event?.type).toBe('speech_end')
    if (event?.type !== 'speech_end') return
    // marker 1..98 全部在场（前缓冲 1..3 + 话语 4..98），无丢帧无重复
    expect(event.audio.length).toBe(98)
    expect(Array.from(event.audio)).toEqual(Array.from({ length: 98 }, (_, k) => k + 1))
  })

  it('话语结束后机器回到干净 IDLE：可立即开始下一句', () => {
    const machine = activatedMachine()
    for (let i = 10; i < 58; i++) feed(machine, SILENCE, marker(i))
    expect(machine.state).toBe('idle')
    // 第二句：平滑窗残留静音需 5 帧翻正 + 3 命中 → 第 7 帧触发
    let started = false
    for (let i = 100; i < 115; i++) {
      if (feed(machine, SPEECH, marker(i))?.type === 'speech_start') {
        started = true
        break
      }
    }
    expect(started).toBe(true)
  })
})

describe('P3B-12 有界性与生命周期', () => {
  it('maxUtteranceSamples 达上限强制切段（reason=max-duration），可循环触发', () => {
    const machine = createVadStateMachine({ maxUtteranceSamples: 5 })
    const events: VadEvent[] = []
    for (let i = 0; i < 10; i++) {
      const ev = feed(machine, SPEECH, marker(i))
      if (ev !== null) events.push(ev)
    }
    // 每帧 1 样本：f3 触发 start（前缓冲 3）→ f5 累计 5 强制 end →
    // f8 二次 start → f10 二次 end
    expect(events.map((e) => e.type)).toEqual([
      'speech_start',
      'speech_end',
      'speech_start',
      'speech_end'
    ])
    expect(events[1]?.type === 'speech_end' && events[1].reason).toBe('max-duration')
    expect(events[3]?.type === 'speech_end' && events[3].reason).toBe('max-duration')
    expect(machine.state).toBe('idle')
  })

  it('flush：说话中冲刷产出 speech_end(flush)；IDLE 时返回 null', () => {
    const machine = createVadStateMachine()
    for (let i = 0; i < 5; i++) feed(machine, SPEECH, marker(i))
    const event = machine.flush()
    expect(event?.type).toBe('speech_end')
    if (event?.type !== 'speech_end') return
    expect(event.reason).toBe('flush')
    expect(event.audio.length).toBe(5)
    expect(machine.state).toBe('idle')
    expect(machine.flush()).toBeNull()
  })

  it('reset：丢弃一切，之后 flush 为 null', () => {
    const machine = createVadStateMachine()
    for (let i = 0; i < 5; i++) feed(machine, SPEECH, marker(i))
    machine.reset()
    expect(machine.state).toBe('idle')
    expect(machine.flush()).toBeNull()
  })
})

describe('P3B-12 computeChunkDb（int16 尺度）', () => {
  it('静音帧 ≈ -140；正弦帧（幅值 0.6）远超 60 门', () => {
    expect(computeChunkDb(makeSilentPcm16(32))).toBeLessThan(-100)
    expect(computeChunkDb(makeSinePcm16(220, 32, 0.6))).toBeGreaterThan(70)
  })

  it('低幅值噪声（0.01）过不了 60 门；正常语音幅值（0.1+）能过', () => {
    expect(computeChunkDb(makeSinePcm16(220, 32, 0.01))).toBeLessThan(60)
    expect(computeChunkDb(makeSinePcm16(220, 32, 0.1))).toBeGreaterThan(60)
  })
})
