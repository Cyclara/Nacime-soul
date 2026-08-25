// src/main/observability/stream-error-tolerance.ts
// M-35（2026-08-21）：stdout/stderr 写入失败容忍。
//
// 背景（2026-08-20 验收实测事故）：`electron out/main/index.js | head -30` 启动——
// head 收满 30 行退出关闭管道，应用第 31 行日志写入触发 EPIPE。桌面应用的
// stdout/stderr 可因终端关闭、管道消费者退出、父进程死亡合法消失；此时
// process.stdout 的 'error' 事件若无人监听，Node 会把它升级为 uncaughtException
// → crash-guard 弹"严重错误需要退出"——日志写不进终端最多哑火，不应整应用陪葬。
//
// 修法：给 stdout/stderr 挂 'error' 监听（有监听 = Node 不再升级为 uncaughtException）。
// 吞掉所有写入错误（stdout 已不可用，没有更好的上报通道；文件日志走 electron-log
// 文件 transport，不经过 stdout，继续正常落盘）。首次吞掉时回调一次，便于文件日志留痕。

/** 可被挂载错误容忍的最小流接口（process.stdout/stderr 或测试假流） */
export interface ErrorTolerantStream {
  on(event: 'error', listener: (error: Error & { code?: string }) => void): unknown
}

/**
 * 给指定流挂 'error' 容忍 handler。
 *
 * @param streams 通常是 [process.stdout, process.stderr]
 * @param onFirstSwallow 首次吞掉错误时的回调（只触发一次；用于在文件日志留痕。
 *   回调内部绝不能再写 stdout/stderr，否则打转转）
 */
export function installStreamErrorTolerance(
  streams: readonly ErrorTolerantStream[],
  onFirstSwallow?: (errorCode: string) => void
): void {
  let swallowed = false
  for (const stream of streams) {
    stream.on('error', (error) => {
      if (swallowed) return
      swallowed = true
      onFirstSwallow?.(typeof error?.code === 'string' ? error.code : 'UNKNOWN')
    })
  }
}
