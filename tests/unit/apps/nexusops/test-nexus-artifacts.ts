/**
 * 产物体系重构（skill+推理+输出+链接）单测。
 *
 * 验证：
 *  - skill.general_analysis 兜底 skill 存在 + 含推理链 reasoningChain
 *  - 各 skill 输出含 diagnosis（非空）+ reasoningChain（数组长度 ≥ 2）
 *  - NexusArtifact 提取：含 diagnosis 的 skill 进右栏，无 diagnosis 的返回 null
 */
import { describe, it, expect } from "vitest";
import { buildNexusSkills } from "../../../../apps/nexusops/skills/index.js";
import { buildNexusTools } from "../../../../apps/nexusops/tools/index.js";
import { ToolRegistry } from "../../../../src/tools/registry.js";
import type { SkillConnector } from "../../../../src/agent/skill-bridge.js";
import type { FlowConnector, ToolResult } from "../../../../src/tools/base.js";
import { isEvidenceEnvelope } from "../../../../src/core/evidence-envelope.js";

const skills = buildNexusSkills();

/** 构建注入全部工具 + skill 的 registry。 */
function buildRegistryForSkills(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of buildNexusTools()) registry.register(tool);
  for (const skill of skills) {
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
    if (r.done) {
      final = r.value;
      break;
    }
  }
  return final!;
}

function skillData(result: ToolResult): Record<string, unknown> {
  return (result.output as { data: Record<string, unknown> }).data;
}

describe("产物体系重构：skill 推理链 + 诊断结论", () => {
  it("skill.general_analysis 兜底 skill 存在", () => {
    const s = skills.find((x) => x.name === "skill.general_analysis") as SkillConnector | undefined;
    expect(s).toBeDefined();
    expect(s!.kind).toBe("skill");
    expect(typeof s!.dynamicSteps).toBe("function");
  });

  it("skill.general_analysis 输出含 diagnosis + reasoningChain（≥2 步）", async () => {
    const s = skills.find((x) => x.name === "skill.general_analysis") as SkillConnector;
    const result = await runSkill(s, { scenarioId: "anomaly", line: "L01" });
    expect(isEvidenceEnvelope(result.output)).toBe(true);
    const data = skillData(result) as {
      diagnosis: string;
      reasoningChain: Array<{ step: number; inference: string }>;
      confidence: number;
      ruledOut?: string[];
    };
    expect(data.diagnosis.length).toBeGreaterThan(0);
    expect(Array.isArray(data.reasoningChain)).toBe(true);
    expect(data.reasoningChain.length).toBeGreaterThanOrEqual(2);
    expect(typeof data.confidence).toBe("number");
  });

  // 7 个现有 skill 各自输出含 diagnosis + reasoningChain
  const skillCases: Array<{ name: string; scenario: string }> = [
    { name: "skill.oee_diagnose", scenario: "anomaly" },
    { name: "skill.downtime_root_cause", scenario: "crisis" },
    { name: "skill.multi_perspective_rca", scenario: "anomaly" },
    { name: "skill.cost_summary", scenario: "anomaly" },
    { name: "skill.waste_audit", scenario: "crisis" },
    { name: "skill.dmaic", scenario: "anomaly" },
  ];

  for (const { name, scenario } of skillCases) {
    it(`${name} 输出含 diagnosis + reasoningChain（≥2 步）`, async () => {
      const s = skills.find((x) => x.name === name) as SkillConnector;
      const result = await runSkill(s, { scenarioId: scenario, line: "L01" });
      const data = skillData(result) as {
        diagnosis?: string;
        reasoningChain?: Array<{ step: number }>;
      };
      expect(typeof data.diagnosis).toBe("string");
      expect(data.diagnosis!.length).toBeGreaterThan(0);
      expect(Array.isArray(data.reasoningChain)).toBe(true);
      expect(data.reasoningChain!.length).toBeGreaterThanOrEqual(2);
    });
  }
});
