import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, appendFileSync as appendFileSyncRaw } from "node:fs";
import { join } from "node:path";
import { AsyncLatch } from "../../src/tasks/latch.js";
import { StreamCoalescer } from "../../src/tasks/coalescer.js";
import { FileTaskStore } from "../../src/tasks/task-store.js";
import { TaskRegistry } from "../../src/tasks/registry.js";
import {
  writeJsonAtomicSync,
  readJsonSync,
  appendJsonlLine,
  readJsonlSync,
  readJsonlSinceSync,
} from "../../src/storage/file-store.js";
import type { StreamEvent } from "../../src/core/stream-events.js";

// 用临时目录隔离测试，不污染项目 data/（config 为惰性读取，运行时切换生效）
let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lif-p1-"));
  process.env.LIF_DATA_DIR = tmpRoot;
});

describe("file-store", () => {
  it("writeJsonAtomicSync writes & reads back", () => {
    const p = join(tmpRoot, "sub", "a.json");
    writeJsonAtomicSync(p, { x: 1 });
    expect(readJsonSync(p)).toEqual({ x: 1 });
  });

  it("readJsonSync returns null for missing file", () => {
    expect(readJsonSync(join(tmpRoot, "nope.json"))).toBeNull();
  });

  it("jsonl append/read/since round-trip", () => {
    const p = join(tmpRoot, "e.jsonl");
    appendJsonlLine(p, { seq: 1, v: "a" });
    appendJsonlLine(p, { seq: 2, v: "b" });
    appendJsonlLine(p, { seq: 3, v: "c" });
    expect(readJsonlSync(p)).toHaveLength(3);
    expect(readJsonlSinceSync(p, 1)).toEqual([
      { seq: 2, v: "b" },
      { seq: 3, v: "c" },
    ]);
  });

  it("skips corrupted jsonl lines", () => {
    const p = join(tmpRoot, "bad.jsonl");
    appendJsonlLine(p, { seq: 1 });
    // 写入真正无法解析的内容（缺引号的 JSON）
    appendFileSyncRaw(p, "{broken\n");
    appendJsonlLine(p, { seq: 2 });
    expect(readJsonlSync(p)).toEqual([{ seq: 1 }, { seq: 2 }]);
  });
});

describe("AsyncLatch", () => {
  it("wait() resolves with released value", async () => {
    const latch = new AsyncLatch<string>();
    const p = latch.wait();
    expect(latch.isPending).toBe(true);
    latch.release("ok");
    expect(await p).toBe("ok");
    expect(latch.isReleased).toBe(true);
    expect(latch.isPending).toBe(false);
  });

  it("wait() after release returns stored value immediately", async () => {
    const latch = new AsyncLatch<number>();
    latch.release(42);
    expect(await latch.wait()).toBe(42);
  });

  it("multiple waiters all resolve on release", async () => {
    const latch = new AsyncLatch<string>();
    const p1 = latch.wait();
    const p2 = latch.wait();
    latch.release("shared");
    expect(await p1).toBe("shared");
    expect(await p2).toBe("shared");
  });

  it("fail() rejects waiters", async () => {
    const latch = new AsyncLatch();
    const p = latch.wait();
    latch.fail(new Error("aborted"));
    await expect(p).rejects.toThrow("aborted");
  });

  it("release is idempotent", async () => {
    const latch = new AsyncLatch();
    latch.release("first");
    latch.release("second"); // no-op
    expect(latch.value).toBe("first");
  });
});

describe("StreamCoalescer", () => {
  it("buffers content channel and flushes on demand", () => {
    const emitted: unknown[] = [];
    const c = new StreamCoalescer({ emit: (e) => emitted.push(e), maxBuffer: 100, maxDelayMs: 10_000 });
    c.push(makeEv(1, "content"));
    c.push(makeEv(2, "content"));
    expect(emitted).toHaveLength(0); // content 缓冲中
    expect(c.pendingCount).toBe(2);
    c.flush();
    expect(emitted).toHaveLength(2);
    expect(c.pendingCount).toBe(0);
  });

  it("flushes content buffer immediately when a status event arrives", () => {
    const emitted: unknown[] = [];
    const c = new StreamCoalescer({ emit: (e) => emitted.push(e), maxBuffer: 100, maxDelayMs: 10_000 });
    c.push(makeEv(1, "content"));
    c.push(makeEv(2, "status")); // status 触发先 flush content 再立即 emit
    expect(emitted.map((e) => (e as { seq: number }).seq)).toEqual([1, 2]);
  });

  it("auto-flushes when buffer reaches maxBuffer", () => {
    const emitted: unknown[] = [];
    const c = new StreamCoalescer({ emit: (e) => emitted.push(e), maxBuffer: 2, maxDelayMs: 10_000 });
    c.push(makeEv(1, "content"));
    c.push(makeEv(2, "content")); // 达到 maxBuffer=2
    expect(emitted).toHaveLength(2);
  });
});

describe("FileTaskStore", () => {
  it("create + get + update + setStatus", () => {
    const store = new FileTaskStore();
    const meta = store.create("hello", { k: "v" });
    expect(store.get(meta.id)?.intent).toBe("hello");
    const updated = store.update(meta.id, { status: "running" });
    expect(updated?.status).toBe("running");
    expect(updated?.config).toEqual({ k: "v" });
  });

  it("append assigns monotonic seq and persists", () => {
    const store = new FileTaskStore();
    const meta = store.create("intent");
    const e1 = store.append(meta.id, {
      type: "phase",
      taskId: meta.id,
      ts: Date.now(),
      channel: "status",
      payload: { id: "s", name: "s", state: "running" },
    });
    const e2 = store.append(meta.id, {
      type: "done",
      taskId: meta.id,
      ts: Date.now(),
      channel: "meta",
      payload: {},
    });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(store.get(meta.id)?.lastSeq).toBe(2);
    const all = store.readAll(meta.id);
    expect(all).toHaveLength(2);
    expect(store.readSince(meta.id, 0)).toHaveLength(2);
    expect(store.readSince(meta.id, 1)).toHaveLength(1);
  });
});

describe("TaskRegistry stub runner", () => {
  it("runs stub to done after approval, emitting phase/text/done events", async () => {
    const reg = new TaskRegistry();
    const meta = reg.start("做一期关于 AI 的播客");
    // stub 必然在确认点暂停，需 approve 才能跑到 done
    await waitFor(() => reg.getStore().get(meta.id)?.status === "pending_confirmation", 1000);
    await reg.confirm(meta.id, { decision: "approve" });
    await reg.join(meta.id);
    const events = reg.getStore().readAll(meta.id);
    const types = events.map((e) => e.type);
    expect(types).toContain("phase");
    expect(types).toContain("text");
    expect(types).toContain("done");
    expect(reg.getStore().get(meta.id)?.status).toBe("done");
  });

  it("emits a confirm_gate extension event and pauses at pending_confirmation", async () => {
    const reg = new TaskRegistry();
    const meta = reg.start("test");
    // 等到进入 pending_confirmation（stub 在确认点暂停）
    await waitFor(() => reg.getStore().get(meta.id)?.status === "pending_confirmation", 1000);
    const events = reg.getStore().readAll(meta.id);
    const gate = events.find((e) => e.type === "extension");
    expect(gate).toBeDefined();
    expect((gate!.payload as { name: string }).name).toBe("confirm_gate");
    expect(reg.getStore().get(meta.id)?.status).toBe("pending_confirmation");
    // 释放确认，让 runner 继续
    await reg.confirm(meta.id, { decision: "approve" });
    await reg.join(meta.id);
    expect(reg.getStore().get(meta.id)?.status).toBe("done");
  });

  it("reject marks task aborted and runner stops without done", async () => {
    const reg = new TaskRegistry();
    const meta = reg.start("test reject");
    await waitFor(() => reg.getStore().get(meta.id)?.status === "pending_confirmation", 1000);
    await reg.confirm(meta.id, { decision: "reject" });
    await reg.join(meta.id);
    const types = reg.getStore().readAll(meta.id).map((e) => e.type);
    expect(types).not.toContain("done");
    expect(reg.getStore().get(meta.id)?.status).toBe("aborted");
  });

  it("confirm without pending confirmation throws", async () => {
    const reg = new TaskRegistry();
    const meta = reg.start("x");
    // 跑到确认点并 approve，让任务终结
    await waitFor(() => reg.getStore().get(meta.id)?.status === "pending_confirmation", 1000);
    await reg.confirm(meta.id, { decision: "approve" });
    await reg.join(meta.id);
    // 任务已 done，此时再 confirm 应抛错
    await expect(reg.confirm(meta.id, { decision: "approve" })).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────
type TestChannel = "content" | "status" | "meta";
function makeEv(seq: number, channel: TestChannel): StreamEvent {
  return {
    type: channel === "content" ? "text" : "phase",
    seq,
    taskId: "t",
    ts: 0,
    channel,
    payload: channel === "content" ? { delta: "x" } : { id: "s", name: "s", state: "running" },
  } as StreamEvent;
}

function waitFor(cond: () => boolean | undefined, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });
}
