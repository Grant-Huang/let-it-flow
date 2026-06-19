/**
 * 简易发布订阅事件总线（见 docs/13-p8-config-and-observability.md §13.6 配置热加载）。
 *
 * 用于配置变更通知：API 写配置后发 config_changed，
 * LlmService 监听清缓存，下次 model() 调用重新解析。
 *
 * 设计：同步、进程内、非持久。不跨进程（单实例足够）。
 */

type EventHandler = (data: unknown) => void;

export class EventBus {
  private readonly handlers = new Map<string, Set<EventHandler>>();

  /** 订阅事件。 */
  on(event: string, handler: EventHandler): void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
  }

  /** 取消订阅。 */
  off(event: string, handler: EventHandler): void {
    this.handlers.get(event)?.delete(handler);
  }

  /** 发布事件。同步通知所有订阅者。 */
  emit(event: string, data: unknown): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(data);
      } catch {
        // 单个处理器失败不影响其他订阅者
      }
    }
  }
}

/** 全局默认实例（app 构造时注入；测试可独立 new）。 */
export const globalEventBus = new EventBus();
