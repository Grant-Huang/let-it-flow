/**
 * verbose 日志级别单测（docs/20-narrative-output-rules.md §七）。
 *
 * 验证 LIF_LOG_VERBOSE 对 events.jsonl 落盘的过滤：
 *   - verbose=0 (off)：所有事件都不落盘，但 seq 仍单调递增（SSE 正常）
 *   - verbose=1 (basic)：只落盘 tool_call/tool_result/done/error 等，text/workflow_node 不落盘
 *   - verbose=2 (full)：全部落盘
 *
 * 关键不变量：seq 单调递增与 verbose 无关（保证 SSE 断线重连正确）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FileTaskStore } from "../../../src/tasks/task-store.js";
import { taskEventsPath } from "../../../src/storage/file-store.js";
import { getLogVerbose } from "../../../src/core/config.js";
import type { StreamEvent } from "../../../src/core/stream-events.js";

let tmpRoot: string;
let savedVerbose: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lif-verbose-"));
  process.env.LIF_DATA_DIR = tmpRoot;
  savedVerbose = process.env.LIF_LOG_VERBOSE;
});

afterEach(() => {
  if (savedVerbose === undefined) delete process.env.LIF_LOG_VERBOSE;
  else process.env.LIF_LOG_VERBOSE = savedVerbose;
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

describe("verbose 日志级别", () => {
  it("getLogVerbose：缺省=2，0/1/2 透传，非法值降级到 2", () => {
    delete process.env.LIF_LOG_VERBOSE;
    expect(getLogVerbose()).toBe(2);

    process.env.LIF_LOG_VERBOSE = "0";
    expect(getLogVerbose()).toBe(0);

    process.env.LIF_LOG_VERBOSE = "1";
    expect(getLogVerbose()).toBe(1);

    process.env.LIF_LOG_VERBOSE = "2";
    expect(getLogVerbose()).toBe(2);

    process.env.LIF_LOG_VERBOSE = "abc";
    expect(getLogVerbose(), "非法值降级到缺省 2").toBe(2);

    process.env.LIF_LOG_VERBOSE = "5";
    expect(getLogVerbose(), "超界降级到 2").toBe(2);
  });

  it("verbose=0：所有事件不落盘，但 seq 单调递增", () => {
    process.env.LIF_LOG_VERBOSE = "0";
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

  it("verbose=1：只落盘工具调用元信息 + 终态，text/workflow_node 过滤", () => {
    process.env.LIF_LOG_VERBOSE = "1";
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

    // 保留：tool_call, tool_result, done（共 3 条）
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_result");
    expect(types).toContain("done");
    // 过滤：text, workflow_node
    expect(types).not.toContain("text");
    expect(types).not.toContain("workflow_node");
    expect(events).toHaveLength(3);
  });

  it("verbose=2：全部事件落盘（缺省行为）", () => {
    delete process.env.LIF_LOG_VERBOSE;
    const store = new FileTaskStore();
    const meta = store.create("test intent");
    const taskId = meta.id;

    store.append(taskId, { type: "tool_call", channel: "status", taskId, ts: 1, payload: { id: "c1", name: "x" } } as Omit<StreamEvent, "seq">);
    store.append(taskId, { type: "text", channel: "content", taskId, ts: 2, payload: { delta: "narrative" } } as Omit<StreamEvent, "seq">);
    store.append(taskId, { type: "workflow_node", channel: "status", taskId, ts: 3, payload: { run_id: "r1", node_id: "n1", name: "s", state: "done" } });
    store.append(taskId, { type: "done", channel: "meta", taskId, ts: 4, payload: {} });

    const events = readEvents(taskId);
    expect(events.map((e) => e.type)).toEqual(["tool_call", "text", "workflow_node", "done"]);
    expect(events).toHaveLength(4);
  });

  it("verbose=1 下 seq 仍有空洞但仍单调（readSince 按 > since 过滤能正常工作）", () => {
    process.env.LIF_LOG_VERBOSE = "1";
    const store = new FileTaskStore();
    const meta = store.create("test intent");
    const taskId = meta.id;

    store.append(taskId, { type: "tool_call", channel: "status", taskId, ts: 1, payload: { id: "c1", name: "x" } } as Omit<StreamEvent, "seq">); // seq 1，落盘
    store.append(taskId, { type: "text", channel: "content", taskId, ts: 2, payload: { delta: "skip" } } as Omit<StreamEvent, "seq">);           // seq 2，过滤
    store.append(taskId, { type: "done", channel: "meta", taskId, ts: 3, payload: {} });                              // seq 3，落盘

    // 落盘事件的 seq 是 1 和 3（seq 2 被过滤但有空洞）
    const events = readEvents(taskId);
    expect(events.map((e) => e.seq)).toEqual([1, 3]);

    // readSince 按 > since 过滤，空洞不影响
    const since1 = store.readSince(taskId, 1);
    expect(since1.map((e) => e.seq)).toEqual([3]);
  });
});
