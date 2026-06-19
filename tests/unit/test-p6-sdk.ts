import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { LetItFlow } from "../../src/sdk/let-it-flow.js";
import type { StreamEvent } from "../../src/core/stream-events.js";
import { podcastTemplate } from "../../examples/podcast-generator/template.js";

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lif-p6-"));
  process.env.LIF_DATA_DIR = tmpRoot;
});

/** 收集 execute() 产出的事件（可选：遇到 confirm_gate 时回调释放）。 */
async function collect(
  flow: LetItFlow,
  intent: string,
  onGate?: (ev: StreamEvent, runId: string) => Promise<void>,
): Promise<{ events: StreamEvent[]; types: string[] }> {
  const events: StreamEvent[] = [];
  let runId = "";
  for await (const ev of flow.execute(intent)) {
    runId = ev.taskId;
    events.push(ev);
    if (
      onGate &&
      ev.type === "extension" &&
      (ev.payload as { name?: string }).name === "confirm_gate"
    ) {
      await onGate(ev, runId);
    }
  }
  return { events, types: events.map((e) => e.type) };
}

describe("P6 SDK: execute() streaming", () => {
  it("越界意图 → reject 链路，产出 extension(rejected) 并终止", async () => {
    const flow = new LetItFlow();
    const { events, types } = await collect(flow, "帮点杯咖啡");
    // guardrail reject → extension(rejected)，终态 failed（execute 在终态后退出）
    expect(types).toContain("extension");
    const extNames = events
      .filter((e) => e.type === "extension")
      .map((e) => (e.payload as { name?: string }).name);
    expect(extNames).toContain("rejected");
  }, 15000);

  it("execute() 产出的事件 seq 单调递增", async () => {
    const flow = new LetItFlow();
    const { events } = await collect(flow, "帮点杯咖啡");
    const seqs = events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]!);
    }
  }, 15000);
});

describe("P6 SDK: HITL approve/reject", () => {
  it("confirm_gate → approve 释放后继续到终态", async () => {
    const flow = new LetItFlow({ consumerTemplates: [podcastTemplate] });
    // podcast url 意图 → fetch 节点 requireConfirmation → confirm_gate
    // approve 后继续（可能因网络失败，但关键是闩锁被释放、不挂死）
    const { events, types } = await collect(
      flow,
      "把 https://example.com 做成播客",
      async (_ev, runId) => {
        await flow.approve(runId);
      },
    );
    expect(events.length).toBeGreaterThan(0);
    // 至少触发过 confirm_gate
    expect(types.filter((t) => t === "extension").length).toBeGreaterThan(0);
  }, 20000);

  it("confirm_gate → reject 后该节点跳过（HITL 拒绝不中止 DAG，下游按 onNodeError 处理）", async () => {
    const flow = new LetItFlow({ consumerTemplates: [podcastTemplate] });
    const { events } = await collect(
      flow,
      "把 https://example.com 做成播客",
      async (_ev, runId) => {
        await flow.reject(runId);
      },
    );
    const types = events.map((e) => e.type);
    // HITL 拒绝触发了 confirm_gate
    expect(types.filter((t) => t === "extension").length).toBeGreaterThan(0);
    // fetch 被跳过 → rewrite 无有效输入 → 链路终止（error 或 done，取决于 onNodeError）
    // 关键：闩锁被释放，execute() 正常返回（不挂死）
    expect(events.length).toBeGreaterThan(0);
  }, 20000);

  it("无活跃闩锁时 approve() 抛错", async () => {
    const flow = new LetItFlow();
    // 先跑完一个越界任务（无 confirm_gate）
    await collect(flow, "帮点杯咖啡");
    // 此时无活跃闩锁；approve 一个不存在的 gate 应抛错
    await expect(flow.approve("t_nonexistent")).rejects.toThrow();
  }, 15000);
});

describe("P6 SDK: clarify", () => {
  it("模糊意图 → clarification_required → clarify() 释放闩锁后重跑 planner", async () => {
    const flow = new LetItFlow({ consumerTemplates: [podcastTemplate] });
    const events: StreamEvent[] = [];
    let clarified = false;
    let gateCount = 0;
    for await (const ev of flow.execute("做播客")) {
      events.push(ev);
      const name = ev.type === "extension" ? (ev.payload as { name?: string }).name : undefined;
      if (!clarified && name === "clarification_required") {
        // 补充含 URL 的信息释放 clarify 闩锁 → 重跑走 url 路径
        await flow.clarify(ev.taskId, "主题是 AI 趋势，素材 https://example.com");
        clarified = true;
      }
      // 重跑后每个 confirm_gate 都 reject，直到链路终止（fetch+rewrite 都有 HITL 门）
      if (clarified && name === "confirm_gate") {
        gateCount++;
        await flow.reject(ev.taskId);
      }
    }
    expect(clarified).toBe(true);
    expect(gateCount).toBeGreaterThanOrEqual(1);
    const extCount = events.filter((e) => e.type === "extension").length;
    expect(extCount).toBeGreaterThanOrEqual(2);
  }, 30000);
});

describe("P6 SDK: config backward-compat", () => {
  it("默认 config.plannerModel === openai/gpt-4o", () => {
    const flow = new LetItFlow();
    expect(flow.config.plannerModel).toBe("openai/gpt-4o");
  });

  it("自定义 config.plannerModel 透传", () => {
    const flow = new LetItFlow({ plannerModel: "openai/gpt-4o-mini", searchProvider: "native" });
    expect(flow.config.plannerModel).toBe("openai/gpt-4o-mini");
    expect(flow.config.searchProvider).toBe("native");
  });

  it("tools 注册表可访问（注册了 core 工具）", () => {
    const flow = new LetItFlow();
    expect(flow.tools.has("core.web_fetch")).toBe(true);
    expect(flow.tools.has("core.deliver")).toBe(true);
  });
});
