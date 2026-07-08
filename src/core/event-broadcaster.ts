import type { StreamEvent } from "./stream-events.js";

type Subscriber = (event: StreamEvent) => void | Promise<void>;
type TerminalListener = () => void;

/**
 * 进程内事件广播器：按 taskId 分组的 pub/sub。
 *
 * 与 EventBus 的区别：专为 SSE 流式设计，按 taskId 隔离，支持终态通知。
 *
 * 设计约束（与 EventBus 对齐）：
 *   - 单实例，进程内（不跨进程）
 *   - 不持久化（持久化由 TaskStore 旁路落盘）
 *   - 订阅者顺序触发，保证 SSE 事件顺序
 *
 * 用途（方案 A：SSE push 模式）：
 *   - 生产者（registry.emit）push(event) 后，所有订阅者被顺序触发
 *   - SSE 端点 subscribe(taskId) 后，回调里把事件 writeSSE 给前端
 *   - 终态时 notifyTerminal(taskId)，SSE 端点据此发 [DONE] 并退出
 *   - 落盘仍由 TaskStore 做（旁路，异步），broadcaster 只负责实时分发
 */
export class EventBroadcaster {
  private readonly eventSubs = new Map<string, Set<Subscriber>>();
  private readonly terminalSubs = new Map<string, Set<TerminalListener>>();

  /** 订阅 taskId 的事件流。返回取消订阅函数。 */
  subscribe(taskId: string, sub: Subscriber): () => void {
    let set = this.eventSubs.get(taskId);
    if (!set) {
      set = new Set();
      this.eventSubs.set(taskId, set);
    }
    set.add(sub);
    return () => {
      set!.delete(sub);
      if (set!.size === 0) this.eventSubs.delete(taskId);
    };
  }

  /** 订阅 taskId 的终态通知。返回取消订阅函数。 */
  onTerminal(taskId: string, listener: TerminalListener): () => void {
    let set = this.terminalSubs.get(taskId);
    if (!set) {
      set = new Set();
      this.terminalSubs.set(taskId, set);
    }
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (set!.size === 0) this.terminalSubs.delete(taskId);
    };
  }

  /** 广播一个事件给 taskId 的所有订阅者（顺序触发，保证 SSE 顺序）。 */
  async push(taskId: string, event: StreamEvent): Promise<void> {
    const set = this.eventSubs.get(taskId);
    if (!set) return;
    for (const sub of set) {
      try {
        await sub(event);
      } catch {
        // 单个订阅者失败不影响其他（如 SSE 连接断开）
      }
    }
  }

  /** 通知 taskId 终态（触发 [DONE] 发送）。终态后清理订阅，防泄漏。 */
  notifyTerminal(taskId: string): void {
    const set = this.terminalSubs.get(taskId);
    if (set) {
      for (const listener of set) {
        try {
          listener();
        } catch {
          // 终态监听器失败忽略
        }
      }
      this.terminalSubs.delete(taskId);
    }
  }

  /** 当前 taskId 的事件订阅者数量（测试/调试用）。 */
  subscriberCount(taskId: string): number {
    return this.eventSubs.get(taskId)?.size ?? 0;
  }

  /** 当前 taskId 的终态订阅者数量（测试/调试用）。 */
  terminalListenerCount(taskId: string): number {
    return this.terminalSubs.get(taskId)?.size ?? 0;
  }
}

/** 全局默认实例（与 globalEventBus 设计对齐）。 */
export const globalBroadcaster = new EventBroadcaster();
