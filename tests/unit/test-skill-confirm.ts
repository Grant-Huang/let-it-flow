/**
 * skill-confirm 单测（D4）。
 *
 * 验证：
 *   - extractStepSequence：从 trace 提取工具序列 + 去重连续重复
 *   - buildConfirmPayload：候选记录 → 确认门 payload
 *   - toolSequenceToSteps：工具序列 → SkillStep[]（含未注册工具降级）
 *   - acceptToDraftSkill：确认 → draft SkillConnector（status=draft，输出含 _shadow）
 */
import { describe, it, expect } from "vitest";
import {
  extractStepSequence,
  buildConfirmPayload,
  toolSequenceToSteps,
  acceptToDraftSkill,
} from "../../src/agent/skill-confirm.js";
import type { CandidateRecord } from "../../src/agent/skill-registry.js";
import type { StepTrace } from "../../src/agent/types.js";
import type { FlowConnector, ToolResult } from "../../src/tools/base.js";
import type { ToolEvent } from "../../src/core/stream-events.js";

/** 构造含若干工具调用的 trace。 */
function makeTrace(toolNames: string[]): StepTrace[] {
  return [
    {
      stepNumber: 0,
      toolCalls: toolNames.map((name, i) => ({
        id: `tc${i}`,
        toolName: name,
        args: {},
        result: {},
        durationMs: 0,
      })),
      finishReason: "tool-calls",
      usage: { totalTokens: 10 },
      durationMs: 0,
    },
  ];
}

/** 构造一个返回固定 output 的 echo 工具。 */
function makeTool(name: string): FlowConnector {
  return {
    name,
    tier: "domain",
    description: `test ${name}`,
    inputSchema: { type: "object", properties: {} },
    whenToUse: { triggers: ["t"], notFor: [] },
    outputSchema: { type: "object" },
    outputExample: {},
    async *execute(params): AsyncGenerator<ToolEvent, ToolResult> {
      return { output: { tool: name, params } };
    },
  };
}

describe("extractStepSequence", () => {
  it("提取工具序列（保持顺序）", () => {
    const seq = extractStepSequence(makeTrace(["oee.realtime", "oee.decompose", "equipment.downtime"]));
    expect(seq).toEqual(["oee.realtime", "oee.decompose", "equipment.downtime"]);
  });

  it("去重连续重复（连续两次同工具只记一次）", () => {
    const seq = extractStepSequence(makeTrace(["oee.realtime", "oee.realtime", "oee.decompose"]));
    expect(seq).toEqual(["oee.realtime", "oee.decompose"]);
  });

  it("非连续重复不去重", () => {
    const seq = extractStepSequence(makeTrace(["oee.realtime", "equipment.downtime", "oee.realtime"]));
    expect(seq).toEqual(["oee.realtime", "equipment.downtime", "oee.realtime"]);
  });

  it("rejected 工具跳过", () => {
    const trace: StepTrace[] = [
      {
        stepNumber: 0,
        toolCalls: [
          { id: "tc1", toolName: "oee.realtime", args: {}, result: {}, durationMs: 0 },
          { id: "tc2", toolName: "x.bad", args: {}, result: {}, rejected: true, durationMs: 0 },
        ],
        finishReason: "tool-calls",
        usage: { totalTokens: 10 },
        durationMs: 0,
      },
    ];
    expect(extractStepSequence(trace)).toEqual(["oee.realtime"]);
  });

  it("空 trace → 空序列", () => {
    expect(extractStepSequence([])).toEqual([]);
  });
});

describe("buildConfirmPayload", () => {
  it("候选记录 → payload 含建议名/描述/步骤/信号", () => {
    const rec: CandidateRecord = {
      signature: "oee.realtime→oee.decompose→equipment.downtime→process.parameters",
      occurrences: 5,
      dismissedCount: 0,
      firstSeen: "2026-06-20T00:00:00Z",
      lastSeen: "2026-06-20T01:00:00Z",
      sampleSequence: ["oee.realtime", "oee.decompose", "equipment.downtime", "process.parameters"],
    };
    const payload = buildConfirmPayload(rec);
    expect(payload.signature).toBe(rec.signature);
    expect(payload.suggestedName).toBe("skill.oee_auto");
    expect(payload.suggestedSteps).toEqual(rec.sampleSequence);
    expect(payload.suggestedDescription).toContain("5 次");
    expect(payload.signals.occurrences).toBe(5);
  });
});

describe("toolSequenceToSteps", () => {
  it("工具序列 → SkillStep[]（数量匹配）", () => {
    const tools = new Map([
      ["oee.realtime", makeTool("oee.realtime")],
      ["oee.decompose", makeTool("oee.decompose")],
    ]);
    const steps = toolSequenceToSteps(["oee.realtime", "oee.decompose"], (n) => tools.get(n));
    expect(steps.length).toBe(2);
    expect(steps[0]!.description).toContain("oee.realtime");
    expect(steps[1]!.description).toContain("oee.decompose");
  });

  it("未注册工具 → step.execute 返回错误标记（不抛错）", async () => {
    const steps = toolSequenceToSteps(["oee.realtime", "unknown.tool"], (n) =>
      n === "oee.realtime" ? makeTool("oee.realtime") : undefined,
    );
    const r = await steps[1]!.execute({} as never, {}, []);
    expect((r as { _skillStepError: boolean })._skillStepError).toBe(true);
    expect((r as { toolName: string }).toolName).toBe("unknown.tool");
  });

  it("step.execute 转发到工具并返回 output", async () => {
    const tools = new Map([["oee.realtime", makeTool("oee.realtime")]]);
    const steps = toolSequenceToSteps(["oee.realtime"], (n) => tools.get(n));
    const r = await steps[0]!.execute(
      { taskId: "t", runId: "r", nodeId: "n", emit: async () => ({} as never), requireConfirmation: async () => ({ approved: true }), resolveRef: () => undefined } as never,
      { line: "L01" },
      [],
    );
    expect((r as { tool: string }).tool).toBe("oee.realtime");
  });
});

describe("acceptToDraftSkill", () => {
  it("确认 → draft SkillConnector（status=draft）", () => {
    const tools = new Map([
      ["oee.realtime", makeTool("oee.realtime")],
      ["oee.decompose", makeTool("oee.decompose")],
    ]);
    const skill = acceptToDraftSkill(
      {
        signature: "oee.realtime→oee.decompose",
        name: "skill.oee_auto",
        description: "自动沉淀 OEE 诊断",
        steps: ["oee.realtime", "oee.decompose"],
      },
      (n) => tools.get(n),
    );
    expect(skill.status).toBe("draft");
    expect(skill.kind).toBe("skill");
    expect(skill.name).toBe("skill.oee_auto");
    expect(skill.steps.length).toBe(2);
    expect(skill.description).toContain("draft");
  });

  it("draft skill 执行 → 输出含 _shadow 标记", async () => {
    const tools = new Map([["oee.realtime", makeTool("oee.realtime")]]);
    const skill = acceptToDraftSkill(
      { signature: "x", name: "skill.x", description: "d", steps: ["oee.realtime"] },
      (n) => tools.get(n),
    );
    const gen = skill.execute({}, {
      taskId: "t", runId: "r", nodeId: "n",
      emit: async () => ({} as never),
      requireConfirmation: async () => ({ approved: true }),
      resolveRef: () => undefined,
    } as never);
    let final: ToolResult | undefined;
    while (true) {
      const r = await gen.next();
      if (r.done) { final = r.value; break; }
    }
    expect(final!.output).toHaveProperty("_shadow", true);
  });
});
