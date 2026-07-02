/**
 * 多视角根因分析工具单测（增量计划第 2 步）。
 *
 * 验证：
 *   1. process.fmea 输出 S/O/D + AP 行动优先级（替代旧 RPN 阈值）
 *   2. quality.five_why 输出逐层追问链 + 收敛根因
 *   3. quality.fishbone 输出 5M1E 六分支带证据
 *   4. computeAP 矩阵判定正确（H/M/L 边界）
 *   5. 三视角数据一致性（同场景同产线，三工具引用同一 CAUSAL_CHAIN 源）
 *   6. normal 场景无问题 → chains/fishbone 为空（合理）
 */
import { describe, it, expect } from "vitest";
import { buildNexusTools } from "../../../../apps/nexusops/tools/index.js";
import { computeAP } from "../../../../apps/nexusops/tools/mock-data/scenarios.js";
import type { FlowConnector, ToolResult } from "../../../../src/tools/base.js";

const TOOLS = buildNexusTools();
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

describe("多视角根因分析工具", () => {
  describe("process.fmea（S/O/D + AP 行动优先级）", () => {
    it("anomaly L01 输出三参数失效模式，含 S/O/D + AP 字段", async () => {
      const r = await runTool("process.fmea", { scenarioId: "anomaly", line: "L01" });
      const d = dataOf(r);
      const modes = d.failureModes as Array<Record<string, unknown>>;
      expect(modes.length).toBe(3);
      for (const m of modes) {
        expect(m).toHaveProperty("severity");
        expect(m).toHaveProperty("occurrence");
        expect(m).toHaveProperty("detection");
        expect(m).toHaveProperty("ap");
        expect(["H", "M", "L"]).toContain(m.ap);
        expect(m).toHaveProperty("failureMode");
        expect(m).toHaveProperty("control");
      }
    });

    it("anomaly L01 温度参数（S=9 O=6 D=5）AP=H（高风险）", async () => {
      const r = await runTool("process.fmea", { scenarioId: "anomaly", line: "L01" });
      const modes = dataOf(r).failureModes as Array<Record<string, unknown>>;
      const temp = modes.find((m) => m.param === "温度")!;
      expect(temp.severity).toBe(9);
      expect(temp.occurrence).toBe(6);
      expect(temp.detection).toBe(5);
      expect(temp.ap).toBe("H");
    });

    it("highRisk 过滤正确：只含 AP=H 的失效模式", async () => {
      const r = await runTool("process.fmea", { scenarioId: "crisis", line: "L01" });
      const d = dataOf(r);
      const high = d.highRisk as Array<Record<string, unknown>>;
      expect(high.length).toBeGreaterThan(0);
      for (const m of high) {
        expect(m.ap).toBe("H");
      }
    });

    it("normal 场景 S/O/D 低 → 无高风险项", async () => {
      const r = await runTool("process.fmea", { scenarioId: "normal", line: "L01" });
      const d = dataOf(r);
      const high = d.highRisk as Array<Record<string, unknown>>;
      expect(high.length).toBe(0);
    });
  });

  describe("quality.five_why", () => {
    it("anomaly L01 输出 5Why 链，5 层追问 + 收敛根因", async () => {
      const r = await runTool("quality.five_why", { scenarioId: "anomaly", line: "L01" });
      const d = dataOf(r);
      const chains = d.chains as Array<Record<string, unknown>>;
      expect(chains.length).toBeGreaterThanOrEqual(1);
      const first = chains[0]!;
      expect((first.layers as unknown[]).length).toBe(5);
      expect(first).toHaveProperty("rootCause");
      expect(first).toHaveProperty("stopCriteria");
      expect(d.hasIdentifiedRoot).toBe(true);
    });

    it("crisis L01 含多条链（停机链 + 能耗链）", async () => {
      const r = await runTool("quality.five_why", { scenarioId: "crisis", line: "L01" });
      const chains = dataOf(r).chains as Array<Record<string, unknown>>;
      expect(chains.length).toBe(2);
    });

    it("normal 场景无问题 → chains 为空 + hasIdentifiedRoot=false", async () => {
      const r = await runTool("quality.five_why", { scenarioId: "normal", line: "L01" });
      const d = dataOf(r);
      expect(d.chains as unknown[]).toHaveLength(0);
      expect(d.hasIdentifiedRoot).toBe(false);
    });
  });

  describe("quality.fishbone（5M1E 带证据完整版）", () => {
    it("anomaly L01 输出 6 分支，machine/method 分支非空", async () => {
      const r = await runTool("quality.fishbone", { scenarioId: "anomaly", line: "L01" });
      const d = dataOf(r);
      const branches = d.branches as Array<Record<string, unknown>>;
      expect(branches.length).toBe(6);
      const dims = branches.map((b) => b.dimension as string);
      expect(dims).toContain("人 (Man)");
      expect(dims).toContain("机 (Machine)");
      expect(dims).toContain("法 (Method)");
      // 证据引用应包含 mock 字段名
      const machineBranch = branches.find((b) => (b.dimension as string).includes("Machine"))!;
      const factors = machineBranch.factors as string[];
      expect(factors.length).toBeGreaterThan(0);
      expect(factors.some((f) => f.includes("healthScore"))).toBe(true);
    });

    it("topSuspect 在 anomaly 场景指向非'无显著异常'", async () => {
      const r = await runTool("quality.fishbone", { scenarioId: "anomaly", line: "L01" });
      const d = dataOf(r);
      expect(d.topSuspect).not.toContain("无显著异常");
    });

    it("normal 场景所有分支为空，topSuspect=无显著异常", async () => {
      const r = await runTool("quality.fishbone", { scenarioId: "normal", line: "L01" });
      const d = dataOf(r);
      expect(d.topSuspect).toContain("无显著异常");
      expect(d.excludedDimensions as unknown[]).toHaveLength(6);
    });

    it("excludedDimensions 正确列出空分支（normal 场景全空）", async () => {
      // P0-2 补充环境/测量数据后，anomaly L01 的 5M1E 全部有证据；
      // 改用 normal 场景验证"空分支被排除"机制本身（normal 全部分支为空）
      const r = await runTool("quality.fishbone", { scenarioId: "normal", line: "L01" });
      const d = dataOf(r);
      const excluded = d.excludedDimensions as string[];
      expect(excluded.length).toBe(6);
    });

    it("anomaly L01 补充环境/测量数据后 5M1E 全部有证据", async () => {
      // P0-2：环境（温湿度/HVAC）+ 测量（Gage R&R/校准）数据补全，
      // anomaly L01 不再有被排除的维度（5M1E 完整）
      const r = await runTool("quality.fishbone", { scenarioId: "anomaly", line: "L01" });
      const d = dataOf(r);
      const excluded = d.excludedDimensions as string[];
      expect(excluded.some((e) => e.includes("Environment"))).toBe(false);
      expect(excluded.some((e) => e.includes("Measurement"))).toBe(false);
    });
  });

  describe("computeAP 矩阵判定（AIAG-VDA 第五版）", () => {
    it("S=10 必为 H（最高严重度）", () => {
      expect(computeAP(10, 2, 2)).toBe("H");
    });
    it("S=9 O=6 D=5 为 H（S≥7 且 O≥6 且 D≥5）", () => {
      expect(computeAP(9, 6, 5)).toBe("H");
    });
    it("S=7 O=5 D=4 为 M（S≥7）", () => {
      expect(computeAP(7, 5, 4)).toBe("M");
    });
    it("S=5 O=5 D=4 为 M（O≥5 且 D≥4）", () => {
      expect(computeAP(5, 5, 4)).toBe("M");
    });
    it("S=3 O=2 D=2 为 L（全低）", () => {
      expect(computeAP(3, 2, 2)).toBe("L");
    });
  });

  describe("三视角数据一致性（同源 CAUSAL_CHAIN）", () => {
    it("anomaly L01：5Why 根因与鱼骨图主分支指向相关域", async () => {
      const r5why = await runTool("quality.five_why", { scenarioId: "anomaly", line: "L01" });
      const rFish = await runTool("quality.fishbone", { scenarioId: "anomaly", line: "L01" });
      const rootCause = (dataOf(r5why).chains as Array<Record<string, unknown>>)[0]!
        .rootCause as string;
      const topSuspect = dataOf(rFish).topSuspect as string;
      // 5Why 根因"滤网堵塞"属设备保养（machine），鱼骨图主分支应含 Machine
      expect(rootCause).toContain("润滑");
      expect(topSuspect).toContain("Machine");
    });

    it("crisis L01：FMEA 高风险项与 5Why 根因同域", async () => {
      const rFmea = await runTool("process.fmea", { scenarioId: "crisis", line: "L01" });
      const r5why = await runTool("quality.five_why", { scenarioId: "crisis", line: "L01" });
      const highRisk = dataOf(rFmea).highRisk as Array<Record<string, unknown>>;
      const rootCause = ((dataOf(r5why).chains as Array<Record<string, unknown>>)[0]!
        .rootCause as string);
      // 危机场景温度 S=10 必为高风险；5Why 指向预测性维护缺失
      expect(highRisk.length).toBeGreaterThan(0);
      expect(rootCause).toContain("预测性维护");
    });
  });

  describe("quality.root_cause_5m1e 与新工具共存（不破坏原工具）", () => {
    it("原 quality.root_cause_5m1e 仍可调用且返回布尔标签结构", async () => {
      const r = await runTool("quality.root_cause_5m1e", { scenarioId: "anomaly", line: "L01" });
      const d = dataOf(r);
      expect(d).toHaveProperty("man");
      expect(d).toHaveProperty("machine");
      expect(d).toHaveProperty("topSuspect");
      expect(d.topSuspect).toContain("machine");
    });
  });
});
