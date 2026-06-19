/**
 * S4 NexusOps 工具集单测：验证全部业务域工具构造 + EvidenceEnvelope 输出。
 *
 * 不依赖真实 LLM/Harness，直接调 FlowConnector.execute 取输出。
 */
import { describe, it, expect } from "vitest";
import { buildNexusTools } from "../../apps/nexusops/tools/index.js";
import { isEvidenceEnvelope } from "../../src/core/evidence-envelope.js";
import type { FlowConnector, ToolResult } from "../../src/tools/base.js";
import type { ToolEvent } from "../../src/core/stream-events.js";

const TOOLS = buildNexusTools();
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ─────────────────────────────────────────────────────────────────────────────
// 工具集完整性
// ─────────────────────────────────────────────────────────────────────────────

describe("S4 NexusOps 工具集完整性", () => {
  it("总工具数 ≥ 60（6 域 × ≥8 + finalize + advise）", () => {
    expect(TOOLS.length).toBeGreaterThanOrEqual(60);
  });

  it("OEE 域 ≥ 11 个工具", () => {
    const oee = TOOLS.filter((t) => t.name.startsWith("oee."));
    expect(oee.length).toBeGreaterThanOrEqual(11);
  });

  it("设备域 ≥ 9 个工具", () => {
    const eq = TOOLS.filter((t) => t.name.startsWith("equipment."));
    expect(eq.length).toBeGreaterThanOrEqual(9);
  });

  it("质量域 ≥ 9 个工具", () => {
    const q = TOOLS.filter((t) => t.name.startsWith("quality."));
    expect(q.length).toBeGreaterThanOrEqual(9);
  });

  it("工艺域 ≥ 8 个工具", () => {
    const p = TOOLS.filter((t) => t.name.startsWith("process."));
    expect(p.length).toBeGreaterThanOrEqual(8);
  });

  it("能耗域 ≥ 8 个工具", () => {
    const e = TOOLS.filter((t) => t.name.startsWith("energy."));
    expect(e.length).toBeGreaterThanOrEqual(8);
  });

  it("排产域 ≥ 8 个工具", () => {
    const s = TOOLS.filter((t) => t.name.startsWith("schedule."));
    expect(s.length).toBeGreaterThanOrEqual(8);
  });

  it("物料域 ≥ 8 个工具", () => {
    const m = TOOLS.filter((t) => t.name.startsWith("material."));
    expect(m.length).toBeGreaterThanOrEqual(8);
  });

  it("含 nexus_finalize + nexus_advise", () => {
    expect(BY_NAME.has("nexus_finalize")).toBe(true);
    expect(BY_NAME.has("nexus_advise")).toBe(true);
  });

  it("全部工具 tier=domain（业务域）或 core（收尾工具）", () => {
    for (const t of TOOLS) {
      expect(["domain", "core"]).toContain(t.tier);
    }
  });

  it("全部工具契约字段完整（whenToUse/outputSchema/outputExample）", () => {
    for (const t of TOOLS) {
      expect(t.whenToUse.triggers.length, `${t.name} triggers 空`).toBeGreaterThan(0);
      expect(t.outputSchema, `${t.name} 缺 outputSchema`).toBeDefined();
      expect(t.outputExample, `${t.name} 缺 outputExample`).toBeDefined();
    }
  });

  it("dot-namespacing 命名规范（domain.tool 或 nexus_xxx）", () => {
    for (const t of TOOLS) {
      const ok = /^\w+\.[\w_]+$/.test(t.name) || /^nexus_\w+$/.test(t.name);
      expect(ok, `${t.name} 命名不规范`).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// EvidenceEnvelope 输出（抽样几个工具）
// ─────────────────────────────────────────────────────────────────────────────

describe("S4 工具输出 EvidenceEnvelope", () => {
  const mockCtx = {
    taskId: "t", runId: "r", nodeId: "n", intent: "",
    emit: async () => ({} as never),
    requireConfirmation: async () => ({ approved: true }),
    resolveRef: () => undefined,
  } as unknown as Parameters<FlowConnector["execute"]>[1];

  async function runTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const tool = BY_NAME.get(name)!;
    const gen = tool.execute(args, mockCtx);
    let final: ToolResult | undefined;
    while (true) {
      const r = await gen.next();
      if (r.done) { final = r.value; break; }
    }
    return final!;
  }

  /** 取工具输出的 EvidenceEnvelope（已校验结构）。 */
  function env(result: ToolResult): import("../../src/core/evidence-envelope.js").EvidenceEnvelope<Record<string, unknown>> {
    return result.output as import("../../src/core/evidence-envelope.js").EvidenceEnvelope<Record<string, unknown>>;
  }

  /** 取工具输出的 data 负载（松类型，便于断言）。 */
  function data(result: ToolResult): Record<string, unknown> & {
    [k: string]: unknown;
    events?: Array<{ reason: string }>;
    topDefects?: Array<{ type: string }>;
  } {
    return env(result).data as Record<string, unknown> & {
      events?: Array<{ reason: string }>;
      topDefects?: Array<{ type: string }>;
    };
  }

  it("oee.realtime 输出 EvidenceEnvelope（anomaly 场景 OEE 低）", async () => {
    const result = await runTool("oee.realtime", { scenarioId: "anomaly", line: "L01" });
    expect(isEvidenceEnvelope(result.output)).toBe(true);
    expect(env(result).freshness).toBe("realtime");
    expect(env(result).confidence).toBe("measured");
    expect(env(result).source.system).toBe("MES");
    expect(data(result).oee).toBeLessThan(0.7);
  });

  it("oee.realtime normal 场景 OEE 高", async () => {
    const result = await runTool("oee.realtime", { scenarioId: "normal", line: "L01" });
    expect(data(result).oee).toBeGreaterThan(0.75);
  });

  it("equipment.downtime crisis 场景有停机事件", async () => {
    const result = await runTool("equipment.downtime", { scenarioId: "crisis", line: "L01" });
    expect(data(result).eventCount).toBeGreaterThan(0);
    expect(data(result).events?.[0]?.reason).toBeDefined();
  });

  it("equipment.failure_predict 输出 confidence=estimated", async () => {
    const result = await runTool("equipment.failure_predict", { scenarioId: "anomaly" });
    expect(env(result).confidence).toBe("estimated");
    expect(typeof data(result).failureRisk30d).toBe("number");
  });

  it("quality.pareto 输出帕累托缺陷分布", async () => {
    const result = await runTool("quality.pareto", { scenarioId: "anomaly", line: "L01" });
    expect((data(result).topDefects ?? []).length).toBeGreaterThan(0);
    expect(env(result).freshness).toBe("daily");
  });

  it("process.deviation crisis 场景有超规范参数", async () => {
    const result = await runTool("process.deviation", { scenarioId: "crisis", line: "L01" });
    expect(data(result).outOfSpecCount).toBeGreaterThan(0);
  });

  it("energy.realtime anomaly 场景检测异常", async () => {
    const result = await runTool("energy.realtime", { scenarioId: "anomaly", line: "L01" });
    expect(data(result).anomaly).toBe(true);
    expect(data(result).deltaPct).toBeGreaterThan(15);
  });

  it("schedule.attainment crisis 场景达成率低", async () => {
    const result = await runTool("schedule.attainment", { scenarioId: "crisis", line: "L01" });
    expect(data(result).attainment).toBeLessThan(0.5);
  });

  it("material.wip_level anomaly 场景 WIP 超水位", async () => {
    const result = await runTool("material.wip_level", { scenarioId: "anomaly", line: "L01" });
    expect(data(result).status).toBe("over_capacity");
  });

  it("nexus_advise 输出建议信封 + extension 事件", async () => {
    const tool = BY_NAME.get("nexus_advise")!;
    const events: ToolEvent[] = [];
    const gen = tool.execute({
      recommendations: [
        { title: "校准温度", rationale: "偏差 6%", impact: 0.8, executionScore: 0.9, confidence: 0.85 },
      ],
    }, mockCtx);
    let final: ToolResult | undefined;
    while (true) {
      const r = await gen.next();
      if (r.done) { final = r.value; break; }
      events.push(r.value);
    }
    expect(isEvidenceEnvelope(final!.output)).toBe(true);
    expect((final!.output as { confidence: string }).confidence).toBe("inferred");
    expect(events.some((e) => e.type === "extension")).toBe(true);
  });

  it("nexus_finalize 返回 finalized=true", async () => {
    const result = await runTool("nexus_finalize", { summary: "完成" });
    expect((result.output as { finalized: boolean }).finalized).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 场景切换正确性
// ─────────────────────────────────────────────────────────────────────────────

describe("S4 场景数据一致性", () => {
  const mockCtx = {
    taskId: "t", runId: "r", nodeId: "n", intent: "",
    emit: async () => ({} as never),
    requireConfirmation: async () => ({ approved: true }),
    resolveRef: () => undefined,
  } as unknown as Parameters<FlowConnector["execute"]>[1];

  async function runOee(scenarioId: string, line: string): Promise<number> {
    const tool = BY_NAME.get("oee.realtime")!;
    const gen = tool.execute({ scenarioId, line }, mockCtx);
    let final: ToolResult | undefined;
    while (true) { const r = await gen.next(); if (r.done) { final = r.value; break; } }
    return (final!.output as { data: { oee: number } }).data.oee;
  }

  it("crisis OEE < anomaly OEE < normal OEE（L01）", async () => {
    const normal = await runOee("normal", "L01");
    const anomaly = await runOee("anomaly", "L01");
    const crisis = await runOee("crisis", "L01");
    expect(crisis).toBeLessThan(anomaly);
    expect(anomaly).toBeLessThan(normal);
  });

  it("多产线数据独立（L01 vs L03 在 anomaly 场景）", async () => {
    const l01 = await runOee("anomaly", "L01");
    const l03 = await runOee("anomaly", "L03");
    expect(l01).toBeLessThan(l03); // L01 是问题产线，L03 正常
  });
});
