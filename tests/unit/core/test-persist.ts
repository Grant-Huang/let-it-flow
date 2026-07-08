/**
 * 日志落盘开关单测。
 *
 * 验证 LIF_LOG_PERSIST 对 events.jsonl 落盘的控制（两档语义）：
 *   - persist=false (off)：所有事件都不落盘，但 seq 仍单调递增（内存广播 + SSE 正常）
 *   - persist=true  (on)：全部事件落盘（缺省）
 *
 * 关键不变量：seq 单调递增与 persist 无关（保证 SSE 断线重连正确）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FileTaskStore } from "../../../src/tasks/task-store.js";
import { taskEventsPath } from "../../../src/storage/file-store.js";
import { getLogPersist } from "../../../src/core/config.js";
import type { StreamEvent } from "../../../src/core/stream-events.js";

let tmpRoot: string;
let savedPersist: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lif-persist-"));
  process.env.LIF_DATA_DIR = tmpRoot;
  savedPersist = process.env.LIF_LOG_PERSIST;
});

afterEach(() => {
  if (savedPersist === undefined) delete process.env.LIF_LOG_PERSIST;
  else process.env.LIF_LOG_PERSIST = savedPersist;
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 读取 events.jsonl 解析成事件数组。 */
function readEvents(taskId: string): Array<Record<string, unknown>> {
  const path = taskEventsPath(taskId);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8").trim();
  if (!raw) return [];
  return raw.split("\n").map((line) => JSON.parse(line));
}

describe("日志落盘开关 LIF_LOG_PERSIST", () => {
  it("getLogPersist：缺省=true，'0'/'false'/'off'/负数为 false，其它为 true", () => {
    delete process.env.LIF_LOG_PERSIST;
    expect(getLogPersist()).toBe(true);

    process.env.LIF_LOG_PERSIST = "true";
    expect(getLogPersist()).toBe(true);

    process.env.LIF_LOG_PERSIST = "false";
    expect(getLogPersist()).toBe(false);

    process.env.LIF_LOG_PERSIST = "0";
    expect(getLogPersist()).toBe(false);

    process.env.LIF_LOG_PERSIST = "off";
    expect(getLogPersist()).toBe(false);

    process.env.LIF_LOG_PERSIST = "1";
    expect(getLogPersist()).toBe(true);

    process.env.LIF_LOG_PERSIST = "-1";
    expect(getLogPersist(), "负数视为 off").toBe(false);

    // 非法值降级到缺省 true（安全缺省：宁可多写不丢数据）
    process.env.LIF_LOG_PERSIST = "abc";
    expect(getLogPersist(), "非法值降级到缺省 true").toBe(true);
  });

  it("persist=false：所有事件不落盘，但 seq 单调递增", () => {
    process.env.LIF_LOG_PERSIST = "false";
    const store = new FileTaskStore();
    const meta = store.create("test intent");
    const taskId = meta.id;

    const e1 = store.append(taskId, { type: "tool_call", channel: "status", taskId, ts: 1, payload: { id: "c1", name: "x" } } as Omit<StreamEvent, "seq">);
    const e2 = store.append(taskId, { type: "text", channel: "content", taskId, ts: 2, payload: { delta: "narrative" } } as Omit<StreamEvent, "seq">);
    const e3 = store.append(taskId, { type: "done", channel: "meta", taskId, ts: 3, payload: {} });

    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e3.seq).toBe(3);

    // events.jsonl 应不存在或为空
    expect(readEvents(taskId)).toHaveLength(0);
    // 但 lastSeq 递增（meta 更新了）
    const finalMeta = store.get(taskId);
    expect(finalMeta?.lastSeq).toBe(3);
  });

  it("persist=true（缺省）：全部事件落盘，含 text/workflow_node", () => {
    delete process.env.LIF_LOG_PERSIST;
    const store = new FileTaskStore();
    const meta = store.create("test intent");
    const taskId = meta.id;

    store.append(taskId, { type: "tool_call", channel: "status", taskId, ts: 1, payload: { id: "c1", name: "core.web_search" } } as Omit<StreamEvent, "seq">);
    store.append(taskId, { type: "text", channel: "content", taskId, ts: 2, payload: { delta: "正在检索…" } } as Omit<StreamEvent, "seq">);
    store.append(taskId, { type: "workflow_node", channel: "status", taskId, ts: 3, payload: { run_id: "r1", node_id: "n1", name: "step1", state: "done" } });
    store.append(taskId, { type: "tool_result", channel: "status", taskId, ts: 4, payload: { tool_call_id: "c1", output: "..." } });
    store.append(taskId, { type: "text", channel: "content", taskId, ts: 5, payload: { delta: "找到 3 条结果。" } });
    store.append(taskId, { type: "done", channel: "meta", taskId, ts: 6, payload: {} });

    const events = readEvents(taskId);
    const types = events.map((e) => e.type);

    // 全部落盘：tool_call, text, workflow_node, tool_result, text, done（共 6 条）
    expect(types).toEqual(["tool_call", "text", "workflow_node", "tool_result", "text", "done"]);
    expect(events).toHaveLength(6);
  });

  it("数字 '1' 归一为 on：全部事件落盘（与 true 等价）", () => {
    process.env.LIF_LOG_PERSIST = "1";
    const store = new FileTaskStore();
    const meta = store.create("test intent");
    const taskId = meta.id;

    store.append(taskId, { type: "tool_call", channel: "status", taskId, ts: 1, payload: { id: "c1", name: "x" } } as Omit<StreamEvent, "seq">);
    store.append(taskId, { type: "text", channel: "content", taskId, ts: 2, payload: { delta: "narrative" } } as Omit<StreamEvent, "seq">);
    store.append(taskId, { type: "workflow_node", channel: "status", taskId, ts: 3, payload: { run_id: "r1", node_id: "n1", name: "s", state: "done" } });
    store.append(taskId, { type: "done", channel: "meta", taskId, ts: 4, payload: {} });

    const events = readEvents(taskId);
    // 与 persist=true 行为一致：全部落盘，无空洞
    expect(events.map((e) => e.type)).toEqual(["tool_call", "text", "workflow_node", "done"]);
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });
});
