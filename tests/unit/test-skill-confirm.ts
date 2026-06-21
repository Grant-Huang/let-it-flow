/**
 * skill-confirm 单测（D4）。
 *
 * 验证：
 *   - extractStepSequence：从 trace 提取工具序列 + 去重连续重复
 *   - buildConfirmPayload：候选记录 → 确认门 payload
 *   - toolSequenceToDynamicFn：工具序列 → DynamicStepsFn（步骤事件数 = 工具数、未注册工具降级、转发调工具返回 output）
 *   - acceptToDraftSkill：确认 → draft SkillConnector（status=draft，输出含 _shadow，dynamicSteps 存在）
 */
import { describe, it, expect } from "vitest";
import {
  extractStepSequence,
  buildConfirmPayload,
  toolSequenceToDynamicFn,
  acceptToDraftSkill,
} from "../../src/agent/skill-confirm.js";
import { createSkill } from "../../src/agent/skill-bridge.js";
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

/** mock ExecutionContext（DSL 执行需要 emit/requireConfirmation/resolveTool）。 */
function mockCtx(resolveTool?: (name: string) => FlowConnector | undefined) {
  return {
    taskId: "t",
    runId: "r",
    nodeId: "n",
    intent: "",
    emit: async () => ({}),
    requireConfirmation: async () => ({ approved: true }),
    resolveRef: () => undefined,
    resolveTool: resolveTool ?? (() => undefined),
  } as unknown as Parameters<FlowConnector["execute"]>[1];
}

/** 消费 skill execute generator，取最终 ToolResult + 全部事件。 */
async function runSkill(
  skill: FlowConnector,
  args: Record<string, unknown>,
  ctx: Parameters<FlowConnector["execute"]>[1],
): Promise<{ events: ToolEvent[]; final: ToolResult | undefined }> {
  const gen = skill.execute(args, ctx);
  const events: ToolEvent[] = [];
  let final: ToolResult | undefined;
  while (true) {
    const r = await gen.next();
    if (r.done) {
      final = r.value;
      break;
    }
    events.push(r.value);
  }
  return { events, final };
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

describe("toolSequenceToDynamicFn", () => {
  it("工具序列 → DynamicStepsFn（执行产出的 workflow_node 事件数 = 工具数）", async () => {
    const tools = new Map([
      ["oee.realtime", makeTool("oee.realtime")],
      ["oee.decompose", makeTool("oee.decompose")],
    ]);
    const ctx = mockCtx((name) => tools.get(name));
    const dynamicFn = toolSequenceToDynamicFn(["oee.realtime", "oee.decompose"]);
    const skill = createSkill({
      name: "test.seq",
      description: "d",
      whenToUse: { triggers: ["t"], notFor: [] },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      outputExample: {},
      steps: dynamicFn,
    });
    const { events } = await runSkill(skill, {}, ctx);
    const nodeEvents = events.filter((e) => e.type === "workflow_node");
    // 步骤事件数 = 工具数（每个工具一个 step）
    expect(nodeEvents.length).toBe(2);
    const names = nodeEvents.map((e) => (e.payload as { name: string }).name);
    expect(names.some((n) => n.includes("oee.realtime"))).toBe(true);
    expect(names.some((n) => n.includes("oee.decompose"))).toBe(true);
  });

  it("未注册工具 → 步骤降级标记 _skillStepError（不抛错中断）", async () => {
    const tools = new Map([["oee.realtime", makeTool("oee.realtime")]]);
    const ctx = mockCtx((name) => tools.get(name));
    const dynamicFn = toolSequenceToDynamicFn(["oee.realtime", "unknown.tool"]);
    const skill = createSkill({
      name: "test.missing",
      description: "d",
      whenToUse: { triggers: ["t"], notFor: [] },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      outputExample: {},
      steps: dynamicFn,
    });
    const { final } = await runSkill(skill, {}, ctx);
    const stepResults = (final!.output as { data: { _skill?: { stepResults: unknown[] } } }).data
      ._skill?.stepResults ?? [];
    // 第二步应为 _skillStepError 降级标记
    const second = stepResults[1] as { _skillStepError?: boolean; toolName?: string };
    expect(second._skillStepError).toBe(true);
    expect(second.toolName).toBe("unknown.tool");
  });

  it("步骤转发调用工具并返回 output", async () => {
    const tools = new Map([["oee.realtime", makeTool("oee.realtime")]]);
    const ctx = mockCtx((name) => tools.get(name));
    const dynamicFn = toolSequenceToDynamicFn(["oee.realtime"]);
    const skill = createSkill({
      name: "test.forward",
      description: "d",
      whenToUse: { triggers: ["t"], notFor: [] },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      outputExample: {},
      steps: dynamicFn,
    });
    const { final } = await runSkill(skill, { line: "L01" }, ctx);
    const stepResults = (final!.output as { data: { _skill?: { stepResults: unknown[] } } }).data
      ._skill?.stepResults ?? [];
    const first = stepResults[0] as { tool: string };
    expect(first.tool).toBe("oee.realtime");
  });
});

describe("acceptToDraftSkill", () => {
  it("确认 → draft SkillConnector（status=draft，dynamicSteps 存在）", () => {
    const skill = acceptToDraftSkill(
      {
        signature: "oee.realtime→oee.decompose",
        name: "skill.oee_auto",
        description: "自动沉淀 OEE 诊断",
        steps: ["oee.realtime", "oee.decompose"],
      },
      (n) => undefined,
    );
    expect(skill.status).toBe("draft");
    expect(skill.kind).toBe("skill");
    expect(skill.name).toBe("skill.oee_auto");
    expect(typeof skill.dynamicSteps).toBe("function");
    expect(skill.description).toContain("draft");
  });

  it("draft skill 执行 → 输出含 _shadow 标记", async () => {
    const tools = new Map([["oee.realtime", makeTool("oee.realtime")]]);
    const ctx = mockCtx((name) => tools.get(name));
    const skill = acceptToDraftSkill(
      { signature: "x", name: "skill.x", description: "d", steps: ["oee.realtime"] },
      (n) => tools.get(n),
    );
    const { final } = await runSkill(skill, {}, ctx);
    expect(final!.output).toHaveProperty("_shadow", true);
  });
});
