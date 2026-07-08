import { describe, it, expect, beforeEach } from "vitest";
import { EventBroadcaster } from "../../../src/core/event-broadcaster.js";
import type { StreamEvent } from "../../../src/core/stream-events.js";

/** 构造一个最小 StreamEvent（带簿记字段）。 */
function makeEv(seq: number, type: StreamEvent["type"] = "text"): StreamEvent {
  return {
    type,
    seq,
    taskId: "t1",
    ts: Date.now(),
    channel: "content",
    payload: { delta: `e${seq}` } as never,
  } as StreamEvent;
}

let bc: EventBroadcaster;
beforeEach(() => {
  bc = new EventBroadcaster();
});

describe("EventBroadcaster", () => {
  it("subscribe + push: 订阅者收到事件", async () => {
    const received: StreamEvent[] = [];
    bc.subscribe("t1", (ev) => {
      received.push(ev);
    });
    await bc.push("t1", makeEv(1));
    await bc.push("t1", makeEv(2));
    expect(received).toHaveLength(2);
    expect(received[0]!.seq).toBe(1);
    expect(received[1]!.seq).toBe(2);
  });

  it("多个订阅者都收到同一事件", async () => {
    const a: StreamEvent[] = [];
    const b: StreamEvent[] = [];
    bc.subscribe("t1", (ev) => { a.push(ev); });
    bc.subscribe("t1", (ev) => { b.push(ev); });
    await bc.push("t1", makeEv(1));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(bc.subscriberCount("t1")).toBe(2);
  });

  it("unsubscribe 后不再收到事件", async () => {
    const received: StreamEvent[] = [];
    const unsub = bc.subscribe("t1", (ev) => { received.push(ev); });
    await bc.push("t1", makeEv(1));
    unsub();
    await bc.push("t1", makeEv(2));
    expect(received).toHaveLength(1);
    expect(bc.subscriberCount("t1")).toBe(0);
  });

  it("push 到无订阅者的 taskId 无副作用", async () => {
    await expect(bc.push("nope", makeEv(1))).resolves.toBeUndefined();
  });

  it("异步订阅者被顺序 await（保证 SSE 事件顺序）", async () => {
    const order: number[] = [];
    bc.subscribe("t1", async (ev) => {
      // 模拟慢 SSE 写入
      await new Promise((r) => setTimeout(r, 5));
      order.push(ev.seq);
    });
    await bc.push("t1", makeEv(1));
    await bc.push("t1", makeEv(2));
    await bc.push("t1", makeEv(3));
    expect(order).toEqual([1, 2, 3]);
  });

  it("单个订阅者抛错不影响其他订阅者", async () => {
    const ok: StreamEvent[] = [];
    bc.subscribe("t1", () => {
      throw new Error("boom");
    });
    bc.subscribe("t1", (ev) => { ok.push(ev); });
    await bc.push("t1", makeEv(1));
    expect(ok).toHaveLength(1);
  });

  it("onTerminal: 终态监听器被触发", () => {
    let called = false;
    bc.onTerminal("t1", () => {
      called = true;
    });
    bc.notifyTerminal("t1");
    expect(called).toBe(true);
    // 终态后清理订阅
    expect(bc.terminalListenerCount("t1")).toBe(0);
  });

  it("onTerminal: 取消订阅后不再被触发", () => {
    let called = false;
    const unsub = bc.onTerminal("t1", () => {
      called = true;
    });
    unsub();
    bc.notifyTerminal("t1");
    expect(called).toBe(false);
  });

  it("notifyTerminal 无监听者时无副作用", () => {
    expect(() => bc.notifyTerminal("nope")).not.toThrow();
  });

  it("事件订阅与终态订阅相互独立（unsubscribe 互不影响）", async () => {
    const events: StreamEvent[] = [];
    let terminal = false;
    const unsubEv = bc.subscribe("t1", (ev) => { events.push(ev); });
    const unsubTerm = bc.onTerminal("t1", () => {
      terminal = true;
    });
    await bc.push("t1", makeEv(1));
    expect(events).toHaveLength(1);
    expect(terminal).toBe(false);

    // 取消事件订阅，终态仍可触发
    unsubEv();
    await bc.push("t1", makeEv(2));
    expect(events).toHaveLength(1);
    bc.notifyTerminal("t1");
    expect(terminal).toBe(true);
    expect(bc.subscriberCount("t1")).toBe(0);
  });
});
