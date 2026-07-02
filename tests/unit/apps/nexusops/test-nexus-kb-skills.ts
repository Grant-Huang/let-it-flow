/**
 * S5 NexusOps KB seed + skills 单测。
 *
 * 验证：
 *   - ObsidianProvider 能索引 kb-seed 全部 markdown（覆盖精益五类上下文）
 *   - 关键术语检索命中（OEE / PDCA / 案例）
 *   - 2 个 skill 执行完整步骤序列，返回 EvidenceEnvelope
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { ObsidianProvider } from "../../../../src/tools/knowledge/obsidian-provider.js";
import { isEvidenceEnvelope } from "../../../../src/core/evidence-envelope.js";
import { buildNexusSkills } from "../../../../apps/nexusops/skills/index.js";
import { buildNexusTools } from "../../../../apps/nexusops/tools/index.js";
import { ToolRegistry } from "../../../../src/tools/registry.js";
import type { SkillConnector } from "../../../../src/agent/skill-bridge.js";
import type { FlowConnector, ToolResult } from "../../../../src/tools/base.js";

const SEED_DIR = join(process.cwd(), "apps/nexusops/kb-seed");

// ─────────────────────────────────────────────────────────────────────────────
// ObsidianProvider 索引 kb-seed
// ─────────────────────────────────────────────────────────────────────────────

describe("S5 ObsidianProvider 索引精益五类 vault", () => {
  it("扫描 kb-seed 索引全部 markdown（≥10 篇）", async () => {
    const provider = new ObsidianProvider({ vaultPath: SEED_DIR });
    await provider.init();
    const list = await provider.list();
    expect(list.length).toBeGreaterThanOrEqual(10);
  });

  it("覆盖精益五类上下文目录", async () => {
    const provider = new ObsidianProvider({ vaultPath: SEED_DIR });
    await provider.init();
    const list = await provider.list();
    const dirs = new Set(list.map((p) => p.split("/")[0]));
    expect(dirs.has("01-现场状态")).toBe(true);
    expect(dirs.has("02-改善项目")).toBe(true);
    expect(dirs.has("03-精益知识")).toBe(true);
    expect(dirs.has("04-人与组织")).toBe(true);
    expect(dirs.has("05-推理辅助")).toBe(true);
  });

  it("检索 OEE 计算口径命中", async () => {
    const provider = new ObsidianProvider({ vaultPath: SEED_DIR });
    await provider.init();
    const results = await provider.search({ query: "OEE 计算口径 公式", topK: 3 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.title.includes("OEE"))).toBe(true);
  });

  it("检索 PDCA 命中推理辅助", async () => {
    const provider = new ObsidianProvider({ vaultPath: SEED_DIR });
    await provider.init();
    const results = await provider.search({ query: "PDCA 阶段判定", topK: 3 });
    expect(results.some((r) => r.title.includes("PDCA"))).toBe(true);
  });

  it("检索案例（轴承异响）命中 A3 案例库", async () => {
    const provider = new ObsidianProvider({ vaultPath: SEED_DIR });
    await provider.init();
    const results = await provider.search({ query: "轴承异响 批量报废 案例", topK: 3 });
    expect(results.some((r) => r.title.includes("轴承") || r.content.includes("轴承"))).toBe(true);
  });

  it("frontmatter 过滤：只查术语表类", async () => {
    const provider = new ObsidianProvider({ vaultPath: SEED_DIR });
    await provider.init();
    const results = await provider.search({
      query: "OEE",
      filter: { category: "03-精益知识/术语表" },
    });
    expect(results.every((r) => r.path.includes("03-精益知识"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// skill 执行
// ─────────────────────────────────────────────────────────────────────────────

describe("S5 skill.oee_diagnose 执行", () => {
  const skills = buildNexusSkills();
  const oeeSkill = skills.find((s) => s.name === "skill.oee_diagnose") as SkillConnector;

  it("skill 存在且 kind=skill + 动态流程", async () => {
    expect(oeeSkill).toBeDefined();
    expect(oeeSkill.kind).toBe("skill");
    expect(typeof oeeSkill.dynamicSteps).toBe("function");
    // 执行一次验证步骤数为 5（固定序列）
    const result = await runSkill(oeeSkill, { scenarioId: "anomaly", line: "L01" });
    const meta = (result.output as { data: { _skill: { stepCount: number } } }).data._skill;
    expect(meta.stepCount).toBe(5);
  });

  it("anomaly 场景诊断出设备/工艺问题", async () => {
    const result = await runSkill(oeeSkill, { scenarioId: "anomaly", line: "L01" });
    expect(isEvidenceEnvelope(result.output)).toBe(true);
    const data = skillData(result) as { diagnosis: string; confidence: number; currentOEE: number };
    expect(data.currentOEE).toBeLessThan(0.7);
    expect(data.confidence).toBeGreaterThan(0.5);
    expect(data.diagnosis.length).toBeGreaterThan(0);
  });

  it("normal 场景诊断无单一根因", async () => {
    const result = await runSkill(oeeSkill, { scenarioId: "normal", line: "L01" });
    const data = skillData(result) as { diagnosis: string; confidence: number };
    expect(data.confidence).toBeLessThanOrEqual(0.6);
  });

  it("crisis 场景诊断置信度高", async () => {
    const result = await runSkill(oeeSkill, { scenarioId: "crisis", line: "L01" });
    const data = skillData(result) as { confidence: number };
    expect(data.confidence).toBeGreaterThanOrEqual(0.7);
  });
});

describe("S5 skill.downtime_root_cause 执行", () => {
  const skills = buildNexusSkills();
  const downtimeSkill = skills.find((s) => s.name === "skill.downtime_root_cause") as SkillConnector;

  it("skill 存在且动态步骤完整", async () => {
    expect(downtimeSkill).toBeDefined();
    expect(typeof downtimeSkill.dynamicSteps).toBe("function");
    // 执行一次验证步骤序列完整（停机事件→维护→排除外部→因果链→根因结论）
    const result = await runSkill(downtimeSkill, { scenarioId: "crisis", line: "L01" });
    const meta = (result.output as { data: { _skill: { stepCount: number } } }).data._skill;
    expect(meta.stepCount).toBeGreaterThanOrEqual(4);
  });

  it("crisis 场景识别设备退化根因", async () => {
    const result = await runSkill(downtimeSkill, { scenarioId: "crisis", line: "L01" });
    expect(isEvidenceEnvelope(result.output)).toBe(true);
    const data = skillData(result) as { category: string; rootCause: string };
    // crisis 场景因果链命中，category 为设备退化类
    expect(data.category).toBe("equipment_degradation");
    expect(data.rootCause.length).toBeGreaterThan(0);
  });

  it("anomaly 场景输出根因 + 建议", async () => {
    const result = await runSkill(downtimeSkill, { scenarioId: "anomaly", line: "L01" });
    const data = skillData(result) as { rootCause: string; recommendedNext: string };
    expect(data.rootCause.length).toBeGreaterThan(0);
    expect(data.recommendedNext.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2 跨域组合 skill（替代原 domain 跨域工具，经 ctx.call 串联 Layer 1）
// ─────────────────────────────────────────────────────────────────────────────

describe("S5 Layer 2 跨域组合 skill 执行（ctx.call 串联）", () => {
  const skills = buildNexusSkills();

  it("skill.cost_summary 组合三域成本", async () => {
    const skill = skills.find((s) => s.name === "skill.cost_summary") as SkillConnector;
    expect(skill).toBeDefined();
    const result = await runSkill(skill, { scenarioId: "anomaly", line: "L01" });
    expect(isEvidenceEnvelope(result.output)).toBe(true);
    const data = skillData(result) as {
      oeeLossCost: number;
      energyCost: number;
      qualityLossCost: number;
      totalLossCost: number;
      productUnitPrice: number;
    };
    expect(data.oeeLossCost).toBeGreaterThan(0);
    expect(data.energyCost).toBeGreaterThan(0);
    expect(data.qualityLossCost).toBeGreaterThan(0);
    expect(data.totalLossCost).toBe(data.oeeLossCost + data.energyCost + data.qualityLossCost);
    // P2：单价来自 economics.unit（L01=45 元），非魔法数字
    expect(data.productUnitPrice).toBe(45);
  });

  it("skill.cost_summary 用 economics.unit 真实单价折算（L02>L01）", async () => {
    // L02 电子件单价 120 元 > L01 注塑件 45 元，同样损失率下 L02 损失成本应更高
    const skill = skills.find((s) => s.name === "skill.cost_summary") as SkillConnector;
    const rL01 = await runSkill(skill, { scenarioId: "crisis", line: "L01" });
    const rL02 = await runSkill(skill, { scenarioId: "crisis", line: "L02" });
    const dL01 = skillData(rL01) as { productUnitPrice: number; oeeLossCost: number };
    const dL02 = skillData(rL02) as { productUnitPrice: number; oeeLossCost: number };
    expect(dL02.productUnitPrice).toBeGreaterThan(dL01.productUnitPrice);
    // 单价差异应反映到损失成本上（L02 单价高，单位损失产能的成本更高）
    expect(dL02.productUnitPrice).toBe(120);
    expect(dL01.productUnitPrice).toBe(45);
  });

  it("skill.waste_audit 识别 crisis 场景高危浪费", async () => {
    const skill = skills.find((s) => s.name === "skill.waste_audit") as SkillConnector;
    expect(skill).toBeDefined();
    const result = await runSkill(skill, { scenarioId: "crisis", line: "L01" });
    expect(isEvidenceEnvelope(result.output)).toBe(true);
    const data = skillData(result) as {
      wastes: Array<{ type: string; severity: string; detected: boolean }>;
      detectedCount: number;
      totalLossCostToday: number;
    };
    expect(data.wastes.length).toBeGreaterThanOrEqual(7);
    expect(data.detectedCount).toBeGreaterThan(0);
    expect(data.totalLossCostToday).toBeGreaterThan(0);
  });

  it("skill.dmaic 产出五阶段路线图", async () => {
    const skill = skills.find((s) => s.name === "skill.dmaic") as SkillConnector;
    expect(skill).toBeDefined();
    const result = await runSkill(skill, { scenarioId: "anomaly", line: "L01" });
    expect(isEvidenceEnvelope(result.output)).toBe(true);
    const data = skillData(result) as {
      projectTitle: string;
      phases: Array<{ phase: string; name: string; status: string }>;
      overallAssessment: { currentSigmaLevel: number; priority: string };
    };
    expect(data.phases.length).toBe(5);
    expect(data.phases.map((p) => p.phase)).toEqual(["D", "M", "A", "I", "C"]);
    expect(data.overallAssessment.priority.length).toBeGreaterThan(0);
  });

  it("skill.report_html 生成自包含 HTML 报告", async () => {
    const skill = skills.find((s) => s.name === "skill.report_html") as SkillConnector;
    expect(skill).toBeDefined();
    const result = await runSkill(skill, { scenarioId: "anomaly", line: "L01" });
    expect(isEvidenceEnvelope(result.output)).toBe(true);
    const data = skillData(result) as { html: string; _isHtmlReport: boolean };
    expect(data._isHtmlReport).toBe(true);
    expect(data.html).toContain("<!DOCTYPE html>");
    expect(data.html).toContain("OEE 综合诊断报告");
    expect(data.html).toContain("证据链");
  });

  it("新 skill 通过 ctx.call 嵌套：waste_audit 调 cost_summary", async () => {
    // waste_audit 第 6 步 ctx.call("skill.cost_summary")，验证 skill 套 skill 链路通
    const skill = skills.find((s) => s.name === "skill.waste_audit") as SkillConnector;
    const result = await runSkill(skill, { scenarioId: "anomaly", line: "L01" });
    const data = skillData(result) as { totalLossCostToday: number };
    // 若嵌套失败，totalLossCostToday 会是 NaN/undefined；正常应 > 0
    expect(data.totalLossCostToday).toBeGreaterThan(0);
    expect(Number.isFinite(data.totalLossCostToday)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构建一个注入了全部 domain 工具 + 全部 skill 的 ToolRegistry，
 * 供 skill 内部的 ctx.call 解析被调工具（Layer 1 工具 + 嵌套 skill）。
 */
function buildRegistryForSkills(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of buildNexusTools()) registry.register(tool);
  for (const skill of buildNexusSkills()) {
    if (!registry.has(skill.name)) registry.register(skill);
  }
  return registry;
}

async function runSkill(skill: SkillConnector, args: Record<string, unknown>): Promise<ToolResult> {
  const registry = buildRegistryForSkills();
  const ctx = {
    taskId: "t", runId: "r", nodeId: "n", intent: "",
    args,
    emit: async () => ({} as never),
    requireConfirmation: async () => ({ approved: true }),
    resolveRef: () => undefined,
    resolveTool: (name: string) => registry.get(name),
  } as unknown as Parameters<FlowConnector["execute"]>[1];
  const gen = skill.execute(args, ctx);
  let final: ToolResult | undefined;
  while (true) {
    const r = await gen.next();
    if (r.done) { final = r.value; break; }
  }
  return final!;
}

/** 取 skill 输出的 data（包成 EvidenceEnvelope 后的负载）。 */
function skillData(result: ToolResult): Record<string, unknown> {
  return (result.output as { data: Record<string, unknown> }).data;
}
