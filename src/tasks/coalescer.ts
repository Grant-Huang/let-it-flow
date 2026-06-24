import type { StreamEvent, EventChannel } from "../core/stream-events.js";

/**
 * 流式事件合并器（见 08 §8.6 channel-aware coalescing）。
 *
 * 目的：content 通道（如 text token 增量、tool 输出流）是高频小包，
 * 直接逐条 SSE 推送会制造大量帧。coalescer 按 channel 分流：
 *   - content：缓存，按时间窗/数量合并后批量 flush（也可单条透传，由配置决定）
 *   - status / meta：立即 flush（不合并、不延迟）
 *
 * 实现是进程内批处理器：
 *   - 调用方 push(event)，coalescer 决定立即 emit 或进 content 缓冲
 *   - flush() 强制清空缓冲
 *   - 也支持自动 flush：缓冲达到 maxBuffer 或距上次 flush 超过 maxDelayMs
 *   - emit/push/flush 均为 async，确保 async 的 SSE 写入在终态前完成（避免 [DONE] 抢跑）
 *
 * 注意：coalescer 不负责落库 —— 落库由 TaskStore.append 在 push 之前完成
 * （所有事件都必须可回放，content 也不例外）。
 */
export interface CoalescerEmitFn {
  (event: StreamEvent): void | Promise<void>;
}

export interface StreamCoalescerOptions {
  /** flush 回调（通常是把事件推入 SSE 队列）。 */
  emit: CoalescerEmitFn;
  /** content 缓冲达到该数量则自动 flush。默认 8。 */
  maxBuffer?: number;
  /** 距上次 flush 超过该毫秒则自动 flush（仅在 push 时检查，不启动定时器）。默认 50ms。 */
  maxDelayMs?: number;
}

export class StreamCoalescer {
  private readonly emit: CoalescerEmitFn;
  private readonly maxBuffer: number;
  private readonly maxDelayMs: number;
  private buffer: StreamEvent[] = [];
  private lastFlushTs = Date.now();

  constructor(opts: StreamCoalescerOptions) {
    this.emit = opts.emit;
    this.maxBuffer = opts.maxBuffer ?? 8;
    this.maxDelayMs = opts.maxDelayMs ?? 50;
  }

  /** 推入一个事件；按 channel 决定立即 emit 或缓冲。返回值仅在触发立即 emit 时有意义。 */
  async push(event: StreamEvent): Promise<void> {
    if (channelImmediate(event.channel)) {
      // status / meta：先 flush 已缓冲的 content，保证顺序，再立即 emit
      await this.flush();
      await this.emit(event);
      return;
    }
    // content：缓冲
    this.buffer.push(event);
    if (this.buffer.length >= this.maxBuffer || Date.now() - this.lastFlushTs >= this.maxDelayMs) {
      await this.flush();
    }
  }

  /** 强制清空缓冲，逐条 emit（保持事件顺序与 seq）。 */
  async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      this.lastFlushTs = Date.now();
      return;
    }
    for (const e of this.buffer) {
      await this.emit(e);
    }
    this.buffer = [];
    this.lastFlushTs = Date.now();
  }

  /** 缓冲中事件数（调试/测试用）。 */
  get pendingCount(): number {
    return this.buffer.length;
  }
}

/** status / meta 立即 emit；content 走缓冲。 */
function channelImmediate(channel: EventChannel): boolean {
  return channel !== "content";
}
