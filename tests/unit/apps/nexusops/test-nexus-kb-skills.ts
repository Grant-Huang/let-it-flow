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

  it("skill 存在且 4 步", async () => {
    expect(downtimeSkill).toBeDefined();
    expect(typeof downtimeSkill.dynamicSteps).toBe("function");
    // 执行一次验证步骤数为 4（固定序列）
    const result = await runSkill(downtimeSkill, { scenarioId: "crisis", line: "L01" });
    const meta = (result.output as { data: { _skill: { stepCount: number } } }).data._skill;
    expect(meta.stepCount).toBe(4);
  });

  it("crisis 场景识别设备退化根因", async () => {
    const result = await runSkill(downtimeSkill, { scenarioId: "crisis", line: "L01" });
    expect(isEvidenceEnvelope(result.output)).toBe(true);
    const data = skillData(result) as { category: string; rootCause: string };
    expect(data.category).toBe("equipment_degradation");
    expect(data.rootCause).toContain("设备健康");
  });

  it("anomaly 场景输出根因 + 建议", async () => {
    const result = await runSkill(downtimeSkill, { scenarioId: "anomaly", line: "L01" });
    const data = skillData(result) as { rootCause: string; recommendedNext: string };
    expect(data.rootCause.length).toBeGreaterThan(0);
    expect(data.recommendedNext.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

async function runSkill(skill: SkillConnector, args: Record<string, unknown>): Promise<ToolResult> {
  const ctx = {
    taskId: "t", runId: "r", nodeId: "n", intent: "",
    args,
    emit: async () => ({} as never),
    requireConfirmation: async () => ({ approved: true }),
    resolveRef: () => undefined,
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
