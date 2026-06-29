/**
 * B1 动作→读取闭环单测：验证 write/destructive 动作执行后，
 * 读取工具能通过 lookupActionOverride 消费副作用，使"执行→复检"反映变化。
 *
 * 核心断言：动作执行前后的读取值必须有可观测的差异。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { buildNexusTools } from "../../../../apps/nexusops/tools/index.js";
import { registerMcpActionTools } from "../../../../apps/nexusops/tools/domains/mcp-actions.js";
import { actionStore } from "../../../../apps/nexusops/tools/mock-data/action-store.js";
import type { FlowConnector, ToolResult } from "../../../../src/tools/base.js";

const TOOLS = [...buildNexusTools(), ...registerMcpActionTools()];
const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

const mockCtx = {
  taskId: "t",
  runId: "r",
  nodeId: "n",
  intent: "",
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
    if (r.done) {
      final = r.value;
      break;
    }
  }
  return final!;
}

function dataOf(result: ToolResult): Record<string, unknown> {
  const env = result.output as { data: Record<string, unknown> };
  return env.data;
}

// 每个测试前重置 actionStore，保证隔离
beforeEach(() => actionStore.reset());

describe("B1 动作→读取闭环（action override feedback）", () => {
  describe("QMS 质量闭环", () => {
    it("mcp.qms.quarantine 后 → quality.defect_rate 下降（隔离件不再计入当期缺陷）", async () => {
      const line = "L01";
      const scenarioId = "anomaly";
      const before = await runTool("quality.defect_rate", { scenarioId, line });
      const beforeDefect = dataOf(before).defectRate as number;

      await runTool("mcp.qms.quarantine", {
        scenarioId,
        line,
        batchId: "B-2026-0619-01",
        reason: "尺寸超差疑似批量",
        qty: 200,
      });

      const after = await runTool("quality.defect_rate", { scenarioId, line });
      const afterDefect = dataOf(after).defectRate as number;

      expect(afterDefect).toBeLessThan(beforeDefect);
      expect(dataOf(after).actionApplied).toBe("quarantined");
    });

    it("mcp.qms.scrap_batch 后 → quality.scrap 的 scrapRate 下降（报废已处置）", async () => {
      const scenarioId = "anomaly";
      const line = "L01";
      const before = await runTool("quality.scrap", { scenarioId, line });
      const beforeScrap = dataOf(before).scrapRate as number;

      await runTool("mcp.qms.scrap_batch", {
        scenarioId,
        line,
        batchId: "B-2026-0619-02",
        qty: 50,
        reason: "不可修复",
      });

      const after = await runTool("quality.scrap", { scenarioId, line });
      expect(dataOf(after).scrapRate as number).toBeLessThan(beforeScrap);
    });

    it("mcp.qms.rework_order 后 → quality.fpy 回升（返工排程后一次合格率改善）", async () => {
      const scenarioId = "anomaly";
      const line = "L01";
      const before = await runTool("quality.fpy", { scenarioId, line });
      const beforeFpy = dataOf(before).fpy as number;

      await runTool("mcp.qms.rework_order", {
        scenarioId,
        line,
        batchId: "B-2026-0619-03",
        qty: 30,
        reworkProcess: "二次精加工",
      });

      const after = await runTool("quality.fpy", { scenarioId, line });
      expect(dataOf(after).fpy as number).toBeGreaterThan(beforeFpy);
    });
  });

  describe("ERP 物料闭环", () => {
    it("mcp.erp.material_issue 后 → material.inventory 库存小时数回升", async () => {
      const scenarioId = "crisis"; // crisis 库存极低（4h），变化更显著
      const line = "L01";
      const before = await runTool("material.inventory", { scenarioId, line });
      const beforeHours = dataOf(before).inventoryHours as number;

      await runTool("mcp.erp.material_issue", {
        scenarioId,
        line,
        materialCode: "X-12",
        qty: 500,
        toLine: line,
      });

      const after = await runTool("material.inventory", { scenarioId, line });
      expect(dataOf(after).inventoryHours as number).toBeGreaterThan(beforeHours);
    });

    it("mcp.erp.purchase_request 后 → material.shortage 缺料风险下降", async () => {
      const scenarioId = "anomaly";
      const line = "L01";
      const before = await runTool("material.shortage", { scenarioId, line });
      const beforeRisk = dataOf(before).shortageRisk as number;

      await runTool("mcp.erp.purchase_request", {
        scenarioId,
        line,
        materialCode: "X-12",
        qty: 1000,
        urgency: "urgent",
      });

      const after = await runTool("material.shortage", { scenarioId, line });
      expect(dataOf(after).shortageRisk as number).toBeLessThan(beforeRisk);
    });
  });

  describe("EAM 停线闭环（destructive）", () => {
    it("mcp.eam.stop_line 后 → oee.realtime 崩至 0（可用率/性能率归零）", async () => {
      const scenarioId = "anomaly";
      const line = "L01";
      const before = await runTool("oee.realtime", { scenarioId, line });
      expect(dataOf(before).oee as number).toBeGreaterThan(0);

      await runTool("mcp.eam.stop_line", {
        scenarioId,
        line,
        reason: "主轴轴承断裂，紧急停机",
        duration: "4h",
      });

      const after = await runTool("oee.realtime", { scenarioId, line });
      expect(dataOf(after).oee).toBe(0);
      expect(dataOf(after).availability).toBe(0);
      expect(dataOf(after).performance).toBe(0);
      expect(dataOf(after).actionApplied).toBe("line_stopped");
    });
  });

  describe("process 调参闭环", () => {
    it("mcp.process.adjust_parameters 后 → oee.realtime 性能率回升", async () => {
      const scenarioId = "anomaly";
      const line = "L01";
      const before = await runTool("oee.realtime", { scenarioId, line });
      const beforePerf = dataOf(before).performance as number;

      await runTool("mcp.process.adjust_parameters", {
        scenarioId,
        line,
        parameters: { 温度: 185, 压力: 4.2 },
        reason: "回调至标准工艺窗口",
      });

      const after = await runTool("oee.realtime", { scenarioId, line });
      expect(dataOf(after).performance as number).toBeGreaterThan(beforePerf);
      expect(dataOf(after).actionApplied).toBe("process_adjusted");
    });
  });

  describe("无动作时读取值稳定（回归保护）", () => {
    it("未执行任何动作 → 连续两次读取 quality.defect_rate 值一致", async () => {
      const args = { scenarioId: "anomaly", line: "L01" };
      const r1 = await runTool("quality.defect_rate", args);
      const r2 = await runTool("quality.defect_rate", args);
      expect(dataOf(r1).defectRate).toEqual(dataOf(r2).defectRate);
      expect(dataOf(r1).actionApplied).toBeUndefined();
    });

    it("未执行任何动作 → 连续两次读取 material.inventory 值一致", async () => {
      const args = { scenarioId: "anomaly", line: "L01" };
      const r1 = await runTool("material.inventory", args);
      const r2 = await runTool("material.inventory", args);
      expect(dataOf(r1).inventoryHours).toEqual(dataOf(r2).inventoryHours);
    });
  });
});
