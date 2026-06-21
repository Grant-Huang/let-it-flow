/**
 * P8.2 调用级可观测性测试。
 *
 * 覆盖：
 *   - LlmCallEvent 结构完整性
 *   - tracedGenerateText 包装：成功时产出 ok=true 事件 + 返回结果
 *   - tracedGenerateText 包装：失败时产出 ok=false 事件 + errorKind 分类 + 重抛
 *   - 敏感信息过滤（不记 prompt 文本）
 *   - ndjson 落库（append）
 *   - 成本计算
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  LlmCallEvent,
  CallLogWriter,
  classifyError,
} from "../../src/llm/call-log.js";
import { tracedGenerateText } from "../../src/llm/call-tracer.js";
import { computeCost } from "../../src/llm/cost-compute.js";

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lif-p82-"));
  process.env.LIF_DATA_DIR = tmpRoot;
});

// ─────────────────────────────────────────────────────────────────────────────
// LlmCallEvent 结构
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.2 LlmCallEvent 结构", () => {
  it("完整事件字段正确", () => {
    const ev: LlmCallEvent = {
      type: "llm_call",
      timestamp: new Date().toISOString(),
      callSite: "planner",
      modelAlias: "gpt-4o",
      modelId: "gpt-4o",
      provider: "openai",
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      latencyMs: 1200,
      estimatedCostUsd: 0.001,
      params: { temperature: 0.2 },
      robustGuard: false,
      ok: true,
    };
    expect(ev.type).toBe("llm_call");
    expect(ev.ok).toBe(true);
    expect(ev.totalTokens).toBe(150);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyError 错误分类
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.2 classifyError", () => {
  it("timeout", () => {
    const e = new Error("request timed out after 30000ms");
    expect(classifyError(e)).toBe("timeout");
  });

  it("auth", () => {
    const e = new Error("Incorrect API key provided");
    expect(classifyError(e)).toBe("auth");
  });

  it("rate_limit", () => {
    const e = new Error("Rate limit exceeded");
    expect(classifyError(e)).toBe("rate_limit");
  });

  it("network", () => {
    const e = new Error("fetch failed: ECONNREFUSED");
    expect(classifyError(e)).toBe("network");
  });

  it("parse", () => {
    const e = new Error("Unexpected token in JSON");
    expect(classifyError(e)).toBe("parse");
  });

  it("other（无法分类）", () => {
    const e = new Error("something weird");
    expect(classifyError(e)).toBe("other");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeCost 成本计算
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.2 computeCost", () => {
  it("按 pricing 正确计算", () => {
    const cost = computeCost(
      { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
      { inputPer1K: 0.005, outputPer1K: 0.015 },
    );
    // 1000/1000 * 0.005 + 500/1000 * 0.015 = 0.005 + 0.0075 = 0.0125
    expect(cost).toBeCloseTo(0.0125, 6);
  });

  it("无 pricing 返回 undefined", () => {
    const cost = computeCost(
      { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      undefined,
    );
    expect(cost).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CallLogWriter ndjson 落库
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.2 CallLogWriter", () => {
  it("append 写入 ndjson（每行一条 JSON）", async () => {
    const writer = new CallLogWriter(tmpRoot);
    await writer.append("task-1", {
      type: "llm_call",
      timestamp: new Date().toISOString(),
      callSite: "planner",
      modelAlias: "gpt-4o",
      modelId: "gpt-4o",
      provider: "openai",
      latencyMs: 100,
      params: {},
      robustGuard: false,
      ok: true,
    });
    await writer.append("task-1", {
      type: "llm_call",
      timestamp: new Date().toISOString(),
      callSite: "rewrite",
      modelAlias: "flash",
      modelId: "flash",
      provider: "openai",
      latencyMs: 200,
      params: {},
      robustGuard: false,
      ok: false,
      errorKind: "timeout",
      errorMessage: "timed out",
    });

    const logPath = join(tmpRoot, "tasks", "task-1", "llm_calls.ndjson");
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    const ev1 = JSON.parse(lines[0]!);
    const ev2 = JSON.parse(lines[1]!);
    expect(ev1.callSite).toBe("planner");
    expect(ev2.callSite).toBe("rewrite");
    expect(ev2.ok).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tracedGenerateText 包装
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.2 tracedGenerateText", () => {
  it("成功：产出 ok=true 事件并返回结果", async () => {
    const events: LlmCallEvent[] = [];
    vi.doMock("ai", () => ({
      generateText: vi.fn().mockResolvedValue({
        text: "hello",
        usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      }),
    }));
    const result = await tracedGenerateText(
      { modelId: "gpt-4o" } as never,
      { prompt: "test" },
      {
        callSite: "planner",
        modelAlias: "gpt-4o",
        provider: "openai",
        params: { temperature: 0.2 },
      },
      (e: LlmCallEvent) => { events.push(e); },
    );
    expect(result.text).toBe("hello");
    expect(events.length).toBe(1);
    expect(events[0]!.ok).toBe(true);
    expect(events[0]!.callSite).toBe("planner");
    expect(events[0]!.promptTokens).toBe(10);
    expect(events[0]!.totalTokens).toBe(15);
    expect(events[0]!.latencyMs).toBeGreaterThanOrEqual(0);
    vi.doUnmock("ai");
  });

  it("失败：产出 ok=false 事件 + errorKind + 重抛", async () => {
    const events: LlmCallEvent[] = [];
    vi.doMock("ai", () => ({
      generateText: vi.fn().mockRejectedValue(new Error("Incorrect API key")),
    }));
    await expect(
      tracedGenerateText(
        { modelId: "x" } as never,
        {},
        { callSite: "rewrite", modelAlias: "x", provider: "openai", params: {} },
        (e: LlmCallEvent) => { events.push(e); },
      ),
    ).rejects.toThrow(/API key/);
    expect(events.length).toBe(1);
    expect(events[0]!.ok).toBe(false);
    expect(events[0]!.errorKind).toBe("auth");
    vi.doUnmock("ai");
  });

  it("不记录 prompt 文本（敏感信息过滤）", async () => {
    const events: LlmCallEvent[] = [];
    vi.doMock("ai", () => ({
      generateText: vi.fn().mockResolvedValue({
        text: "output",
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      }),
    }));
    await tracedGenerateText(
      { modelId: "x" } as never,
      { prompt: "SECRET PROMPT TEXT" },
      { callSite: "planner", modelAlias: "x", provider: "openai", params: {} },
      (e: LlmCallEvent) => { events.push(e); },
    );
    const ev = events[0]!;
    // 事件不应含 prompt 字段
    expect(JSON.stringify(ev)).not.toContain("SECRET PROMPT TEXT");
    vi.doUnmock("ai");
  });
});
