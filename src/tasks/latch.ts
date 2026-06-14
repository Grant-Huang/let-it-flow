/**
 * 进程内异步闩锁：HITL 暂停点的同步原语（见 12 §12.4）。
 *
 * 工作流执行到一个需要人工确认的节点时：
 *   1. executor 调 latch.wait()，Promise 挂起，节点暂停
 *   2. 前端收到 confirm_gate 事件，用户做决策
 *   3. POST /confirm 调 latch.release(decision)，挂起的 Promise resolve
 *   4. executor 拿到 decision 继续（跳过/采纳/改参）
 *
 * MVP 约束：
 *   - 进程内单实例（TaskRegistry 持有），不跨进程、不持久化快照
 *   - 进程重启后未决的 wait 会丢失 —— 后续 state-snapshot 里程碑再补
 *   - 一次性：release 后再 wait 直接返回已 release 的值
 *
 * 不做：超时清扫（sweeper）、冷启动快照恢复（见计划"砍掉的"）。
 */
export class AsyncLatch<T = unknown> {
  private resolveFn?: (value: T) => void;
  private rejectFn?: (reason: Error) => void;
  private promise?: Promise<T>;
  private releasedValue?: T;
  private released = false;
  private _isPending = true;
  private waiters = 0;

  /** 当前是否有未 release 的 waiter（false 表示已 release 或无人等待）。 */
  get isPending(): boolean {
    return this._isPending;
  }

  /** 已 release 的值（release 前访问抛错）。 */
  get value(): T {
    if (!this.released) {
      throw new Error("AsyncLatch.value accessed before release");
    }
    return this.releasedValue as T;
  }

  /** 是否已 release。 */
  get isReleased(): boolean {
    return this.released;
  }

  /** 当前挂起的 waiter 数量（调试用）。 */
  get pendingWaiters(): number {
    return this.waiters;
  }

  /**
   * 等待 release。返回的 Promise 在 release(value) 后 resolve 为 value。
   * 重复 wait：已 release 时立即返回存储值；否则各自等待。
   */
  wait(): Promise<T> {
    // 已 release：立即返回（幂等）
    if (this.released) {
      return Promise.resolve(this.releasedValue as T);
    }
    if (!this.promise) {
      this.promise = new Promise<T>((resolve, reject) => {
        this.resolveFn = resolve;
        this.rejectFn = reject;
      });
    }
    this.waiters += 1;
    // 让等待者在 resolve 后递减计数（不影响语义，仅调试用）
    return this.promise.finally(() => {
      this.waiters = Math.max(0, this.waiters - 1);
    });
  }

  /** release 一个值，唤醒所有 waiter。幂等：重复调用 no-op。 */
  release(value: T): void {
    if (this.released) return;
    this.released = true;
    this.releasedValue = value;
    this._isPending = false;
    this.resolveFn?.(value);
  }

  /** 以错误 reject 所有 waiter。用于任务 abort/超时。幂等。 */
  fail(error: Error): void {
    if (this.released) return;
    this.released = true;
    this._isPending = false;
    this.rejectFn?.(error);
  }

  /** 重置闩锁回未 release 状态（用于复用实例）。注意：会丢弃已 release 的值。 */
  reset(): void {
    this.released = false;
    this._isPending = true;
    this.releasedValue = undefined;
    this.resolveFn = undefined;
    this.rejectFn = undefined;
    this.promise = undefined;
    this.waiters = 0;
  }
}
