import { describe, it, expect } from "vitest";
import { LetItFlow } from "../../../src/index.js";
import {
  makeEvent,
  toSSE,
  serializeSSEData,
  channelOf,
  phasePayload,
  textPayload,
  toolCallPayload,
  toolStatusPayload,
  toolResultPayload,
  workflowNodePayload,
  errorPayload,
  confirmGatePayload,
} from "../../../src/core/stream-events.js";
import type { StreamEvent } from "../../../src/core/stream-events.js";
import { applyEvent, createInitialStreamState, parseSSELine } from "@meso.ai/types";

describe("smoke", () => {
  it("LetItFlow can be instantiated", () => {
    const flow = new LetItFlow();
    expect(flow).toBeInstanceOf(LetItFlow);
    expect(flow.config.plannerModel).toBe("openai/gpt-4o");
  });

  it("LetItFlow accepts custom config", () => {
    const flow = new LetItFlow({
      plannerModel: "openai/gpt-4o-mini",
      searchProvider: "native",
    });
    expect(flow.config.plannerModel).toBe("openai/gpt-4o-mini");
    expect(flow.config.searchProvider).toBe("native");
  });

  it("execute() returns an async generator streaming real events", async () => {
    const flow = new LetItFlow();
    const chunks: unknown[] = [];
    // 用越界意图（guardrail 立即 reject → 终态），避免网络/HITL 阻塞
    for await (const chunk of flow.execute("帮点杯咖啡")) {
      chunks.push(chunk);
    }
    // P6：execute() 产出真实事件流（reject 链路含 extension(rejected)，最终 failed）
    expect(chunks.length).toBeGreaterThan(0);
    const types = chunks.map((c) => (c as { type: string }).type);
    expect(types).toContain("extension");
  });
});

describe("stream-events protocol alignment", () => {
  it("channelOf maps text→content, done/error→meta, others→status", () => {
    expect(channelOf("text")).toBe("content");
    expect(channelOf("done")).toBe("meta");
    expect(channelOf("error")).toBe("meta");
    expect(channelOf("phase")).toBe("status");
    expect(channelOf("tool_call")).toBe("status");
    expect(channelOf("workflow_node")).toBe("status");
  });

  function withSeq(e: Omit<StreamEvent, "seq">, seq = 0): StreamEvent {
    return { ...e, seq } as StreamEvent;
  }

  it("toSSE strips bookkeeping fields and produces protocol envelope", () => {
    const ev = withSeq(
      makeEvent("t1", "phase", phasePayload("search", "检索文献", "running")),
    );
    const sse = toSSE(ev);
    expect(sse).toEqual({
      type: "phase",
      schema_version: "1.0",
      payload: { id: "search", name: "检索文献", state: "running" },
    });
    // 簿记字段不出现在序列化结果里
    const json = serializeSSEData(ev);
    expect(json).not.toContain('"seq"');
    expect(json).not.toContain('"taskId"');
    expect(json).not.toContain('"channel"');
  });

  it("text event round-trips through @meso.ai/types parseSSELine", () => {
    const ev = withSeq(makeEvent("t1", "text", textPayload("你好")));
    const line = `data: ${serializeSSEData(ev)}`;
    const parsed = parseSSELine(line);
    expect(parsed).not.toBeNull();
    expect(parsed?.type).toBe("text");
  });

  it("tool_call / tool_status / tool_result / workflow_node / error produce valid SSEEvents", () => {
    const callEv = withSeq(
      makeEvent("t1", "tool_call", toolCallPayload({
        id: "c1",
        name: "web_search",
        args: { query: "AI" },
        risk: "safe",
      })),
    );
    const statusEv = withSeq(
      makeEvent("t1", "tool_status", toolStatusPayload({ id: "c1", status: "running" })),
    );
    const resEv = withSeq(
      makeEvent("t1", "tool_result", toolResultPayload({
        tool_call_id: "c1",
        output: "[]",
      })),
    );
    const nodeEv = withSeq(
      makeEvent("t1", "workflow_node", workflowNodePayload({
        run_id: "r1",
        node_id: "n1",
        name: "web_search",
        state: "active",
      })),
    );
    const errEv = withSeq(
      makeEvent("t1", "error", errorPayload("boom", "UPSTREAM_TIMEOUT")),
    );
    for (const ev of [callEv, statusEv, resEv, nodeEv, errEv]) {
      const sse = toSSE(ev);
      expect(sse.schema_version).toBe("1.0");
      expect(sse.type).toBe(ev.type);
    }
    expect(toSSE(errEv).payload).toMatchObject({ message: "boom", code: "UPSTREAM_TIMEOUT" });
    expect(toSSE(statusEv).payload).toMatchObject({ id: "c1", status: "running" });
  });

  it("HITL confirm gate uses extension event consumable by @meso.ai/types applyEvent", () => {
    const gate = withSeq(
      makeEvent(
        "t1",
        "extension",
        confirmGatePayload({
          gate_id: "g1",
          node_id: "n1",
          run_id: "r1",
          prompt: "选择数据源",
          options: ["url", "topic"],
        }),
      ),
    );
    const sse = toSSE(gate);
    // applyEvent 必须能吃下这个事件而不抛错
    const state = applyEvent(createInitialStreamState(), sse);
    expect(state.extensionLog.length).toBe(1);
    expect(state.extensions["confirm_gate"]).toHaveLength(1);
  });
});
