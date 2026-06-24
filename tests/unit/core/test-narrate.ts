/**
 * narrate helper 单测（docs/20-narrative-output-rules.md）。
 *
 * 验证：
 *  - narrate / narrateDone / narrateSummary 三个发射器都产出合法 text 事件
 *  - delta 字段正确（Summary 前置换行）
 *  - channel = content（可被 coalescer 合并）
 *  - ctx.emit 被正确调用（证明走 SSE 实时通道，绕过 pendingEvents 队列）
 */
import { describe, it, expect, vi } from "vitest";
import { narrate, narrateDone, narrateSummary } from "../../../src/core/narrate.js";
import type { ToolEvent } from "../../../src/core/stream-events.js";

/** 构造一个记录 emit 调用的 mock ctx。 */
function makeCtx() {
  const calls: ToolEvent[] = [];
  const emit = vi.fn(async (event: ToolEvent) => {
    calls.push(event);
    return { ...event, seq: calls.length, taskId: "t1", ts: Date.now() };
  });
  return { ctx: { emit }, calls };
}

describe("narrate helper（Claude Code 风格流式叙述）", () => {
  it("narrate：发一条进行中叙述（type=text, channel=content, delta=原文）", async () => {
    const { ctx, calls } = makeCtx();
    await narrate(ctx, "正在从知识库取写稿铁律…");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      type: "text",
      channel: "content",
      payload: { delta: "正在从知识库取写稿铁律…" },
    });
  });

  it("narrateDone：发完成叙述（结构同 narrate，仅语义不同）", async () => {
    const { ctx, calls } = makeCtx();
    await narrateDone(ctx, "找到 3 条铁律。");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      type: "text",
      channel: "content",
      payload: { delta: "找到 3 条铁律。" },
    });
  });

  it("narrateSummary：前置换行（便于前端分隔气泡）", async () => {
    const { ctx, calls } = makeCtx();
    await narrateSummary(ctx, "口播稿完成，5 段约 6300 字。");
    expect(calls).toHaveLength(1);
    expect((calls[0]!.payload as { delta: string }).delta).toBe("\n口播稿完成，5 段约 6300 字。");
  });

  it("narrate 多次调用都走 ctx.emit（证明实时，不积攒）", async () => {
    const { ctx, calls } = makeCtx();
    await narrate(ctx, "步骤一…");
    await narrate(ctx, "步骤二…");
    await narrate(ctx, "步骤三…");
    expect(calls).toHaveLength(3);
    expect(calls.map((c) => (c.payload as { delta: string }).delta)).toEqual(["步骤一…", "步骤二…", "步骤三…"]);
  });

  it("narrate 直接调 ctx.emit（不走 pendingEvents 队列，绕过 skill-bridge 批量延迟）", async () => {
    const { ctx } = makeCtx();
    await narrate(ctx, "test");
    // emit 被调用即证明走 SSE 实时通道
    expect(ctx.emit).toHaveBeenCalledTimes(1);
  });
});
