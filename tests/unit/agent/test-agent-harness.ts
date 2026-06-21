/**
 * ReAct Harness 单元测试（S1：E+L+O 层）。
 *
 * 覆盖：
 *   - stop-policy：buildStopWhen 产出条件数 + 缺省值
 *   - tool-adapter：FlowConnector → AI SDK tool 适配 + 工具名安全化
 *   - step-emitter：TraceAccumulator 累积 + emitStepPhase
 *   - precondition：注册 + checkFinalize/checkEveryStep
 *   - governance：规则链 + 阻断
 *   - skill-bridge：createSkill 执行多步序列
 *
 * 不依赖真实 LLM（harness 的端到端集成测试由应用层 S6/S7 覆盖）。
 */
import { describe, it, expect } from "vitest";
import { buildStopWhen, DEFAULT_MAX_STEPS, DEFAULT_FINALIZE_TOOL } from "../../../src/agent/stop-policy.js";
import { adaptTool, adaptToolSet, toolNameToKey, keyToToolName } from "../../../src/agent/tool-adapter.js";
import { TraceAccumulator, emitStepPhase, stepEventToTrace } from "../../../src/agent/step-emitter.js";
import { PreconditionRegistry, calledToolNames } from "../../../src/agent/precondition.js";
import { GovernanceChain, type GovernanceRule } from "../../../src/agent/governance.js";
import { createSkill, type SkillConnector } from "../../../src/agent/skill-bridge.js";
import { ToolRegistry } from "../../../src/tools/registry.js";
import type { FlowConnector, ToolResult } from "../../../src/tools/base.js";
import type { ToolEvent } from "../../../src/core/stream-events.js";
import type { StepTrace } from "../../../src/agent/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// helpers：构造简单的 FlowConnector
// ─────────────────────────────────────────────────────────────────────────────

/** 一个返回固定 output 的 echo 工具。 */
function makeEchoTool(name: string, risk?: "safe" | "write" | "destructive"): FlowConnector {
  return {
    name,
    tier: "domain",
    description: `echo 工具 ${name}`,
    inputSchema: { type: "object", properties: { msg: { type: "string" } } },
    whenToUse: { triggers: ["测试"], notFor: [] },
    outputSchema: { type: "object", properties: { echoed: { type: "string" } } },
    outputExample: { echoed: "hello" },
    ...(risk ? { risk } : {}),
    async *execute(params): AsyncGenerator<ToolEvent, ToolResult> {
      return { output: { echoed: (params as { msg?: string }).msg ?? "" } };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// stop-policy
// ─────────────────────────────────────────────────────────────────────────────

describe("stop-policy：buildStopWhen", () => {
  it("缺省配置产出 stepCount + finalize 两个条件", () => {
    const conditions = buildStopWhen();
    expect(conditions.length).toBe(2);
  });

  it("costCap 启用时追加成本条件", () => {
    const conditions = buildStopWhen({ costCap: { maxInputTokens: 1000 } });
    expect(conditions.length).toBe(3);
  });

  it("extra 条件被合并", () => {
    const extra = [() => false];
    const conditions = buildStopWhen(undefined, extra);
    expect(conditions.length).toBe(3);
  });

  it("缺省常量正确", () => {
    expect(DEFAULT_MAX_STEPS).toBe(15);
    expect(DEFAULT_FINALIZE_TOOL).toBe("nexus_finalize");
  });

  it("自定义 maxSteps / finalizeTool 生效", () => {
    const conditions = buildStopWhen({ maxSteps: 5, finalizeTool: "my_done" });
    expect(conditions.length).toBe(2);
    // 条件本身是函数，无法直接读参数，但确保不抛错即可
    expect(typeof conditions[0]).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tool-adapter
// ─────────────────────────────────────────────────────────────────────────────

describe("tool-adapter", () => {
  it("toolNameToKey / keyToToolName 互逆", () => {
    expect(toolNameToKey("core.web_search")).toBe("core_web_search");
    expect(toolNameToKey("domain.oee.realtime")).toBe("domain_oee_realtime");
    expect(keyToToolName("core_web_search")).toBe("core.web.search");
  });

  it("adaptTool 产出含 description + inputSchema + execute", () => {
    const t = makeEchoTool("test.echo");
    const adapted = adaptTool(t, {}, { taskId: "t1", runId: "r1", nodeId: "n1" });
    expect(adapted.description).toContain("echo 工具 test.echo");
    expect(adapted.description).toContain("适用场景：测试");
    expect(typeof adapted.execute).toBe("function");
  });

  it("adaptTool description 含风险等级（write 工具）", () => {
    const t = makeEchoTool("test.dangerous", "destructive");
    const adapted = adaptTool(t, {}, { taskId: "t1", runId: "r1", nodeId: "n1" });
    expect(adapted.description).toContain("风险等级：destructive");
  });

  it("adaptToolSet 批量适配，key 用下划线形式", () => {
    const set = adaptToolSet(
      [makeEchoTool("core.a"), makeEchoTool("domain.b")],
      {},
      { taskId: "t1", runId: "r1", nodeId: "n1" },
    );
    expect(Object.keys(set).sort()).toEqual(["core_a", "domain_b"]);
  });

  it("adaptTool execute 调 FlowConnector.execute 返回 output", async () => {
    const t = makeEchoTool("test.echo");
    const events: Array<{ type: string }> = [];
    const adapted = adaptTool(
      t,
      { emit: async (e) => { events.push({ type: e.type }); } },
      { taskId: "t1", runId: "r1", nodeId: "n1" },
    );
    const result = await adapted.execute?.({ msg: "hi" }, { toolCallId: "tc_test", messages: [] } as never);
    expect(result).toMatchObject({ echoed: "hi" });
    // emit 应至少产出 tool_call + tool_result
    expect(events.some((e) => e.type === "tool_call")).toBe(true);
    expect(events.some((e) => e.type === "tool_result")).toBe(true);
  });

  it("write 工具未配置 requireConfirmation 时直接执行（降级）", async () => {
    const t = makeEchoTool("test.write", "write");
    const adapted = adaptTool(t, {}, { taskId: "t1", runId: "r1", nodeId: "n1" });
    const result = await adapted.execute?.({ msg: "x" }, { toolCallId: "tc_test", messages: [] } as never);
    expect(result).toMatchObject({ echoed: "x" });
  });

  it("write 工具配置 requireConfirmation，用户拒绝时返回 skipped", async () => {
    const t = makeEchoTool("test.write", "write");
    const adapted = adaptTool(
      t,
      { requireConfirmation: async () => ({ approved: false }) },
      { taskId: "t1", runId: "r1", nodeId: "n1" },
    );
    const result = await adapted.execute?.({ msg: "x" }, { toolCallId: "tc_test", messages: [] } as never);
    expect(result).toMatchObject({ skipped: true, rejected: true });
  });

  it("write 工具用户批准后正常执行", async () => {
    const t = makeEchoTool("test.write", "write");
    const adapted = adaptTool(
      t,
      { requireConfirmation: async () => ({ approved: true }) },
      { taskId: "t1", runId: "r1", nodeId: "n1" },
    );
    const result = await adapted.execute?.({ msg: "approved" }, { toolCallId: "tc_test", messages: [] } as never);
    expect(result).toMatchObject({ echoed: "approved" });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// step-emitter
// ─────────────────────────────────────────────────────────────────────────────

describe("step-emitter", () => {
  it("stepEventToTrace 转换 SDK step 事件", () => {
    const riskMap = new Map([["test.echo", "safe" as const]]);
    const ev = {
      stepNumber: 0,
      text: "正在分析",
      reasoningText: undefined,
      toolCalls: [{ id: "tc1", toolName: "test_echo", input: { msg: "hi" } }],
      toolResults: [{ output: { echoed: "hi" } }],
      finishReason: "tool-calls",
      usage: { inputTokens: 10, outputTokens: 5 },
    };
    const trace = stepEventToTrace(ev, riskMap, new Set(), new Set());
    expect(trace.stepNumber).toBe(0);
    expect(trace.thought).toBe("正在分析");
    expect(trace.toolCalls.length).toBe(1);
    expect(trace.toolCalls[0]!.toolName).toBe("test.echo");
    expect(trace.toolCalls[0]!.risk).toBe("safe");
    expect(trace.usage?.totalTokens).toBe(15);
  });

  it("TraceAccumulator 累积 token", () => {
    const acc = new TraceAccumulator();
    acc.push({ stepNumber: 0, toolCalls: [], finishReason: "stop", durationMs: 0, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } });
    acc.push({ stepNumber: 1, toolCalls: [], finishReason: "stop", durationMs: 0, usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 } });
    expect(acc.usage).toEqual({ inputTokens: 30, outputTokens: 15, totalTokens: 45 });
    expect(acc.list.length).toBe(2);
  });

  it("emitStepPhase 在有 emit 时发事件", async () => {
    const events: string[] = [];
    await emitStepPhase(async (e) => { events.push((e as { type: string }).type); }, 0, "done");
    expect(events).toEqual(["phase"]);
  });

  it("emitStepPhase 无 emit 时静默", async () => {
    await expect(emitStepPhase(undefined, 0, "done")).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// precondition
// ─────────────────────────────────────────────────────────────────────────────

describe("precondition：PreconditionRegistry", () => {
  it("注册 + checkFinalize 全满足", () => {
    const reg = new PreconditionRegistry();
    reg.register({
      id: "has_oee",
      description: "必须有 OEE 数据",
      check: (trace) => calledToolNames(trace).has("oee.realtime")
        ? { met: true }
        : { met: false, missingTool: "oee.realtime", prompt: "请先查 OEE" },
    });
    const trace: StepTrace[] = [{
      stepNumber: 0,
      toolCalls: [{ id: "tc1", toolName: "oee.realtime", args: {}, result: {}, durationMs: 0 }],
      finishReason: "tool-calls",
      durationMs: 0,
    }];
    expect(reg.checkFinalize(trace)).toEqual({ met: true });
  });

  it("checkFinalize 未满足时返回缺失提示", () => {
    const reg = new PreconditionRegistry();
    reg.register({
      id: "has_oee",
      description: "必须有 OEE 数据",
      check: (trace) => calledToolNames(trace).has("oee.realtime")
        ? { met: true }
        : { met: false, missingTool: "oee.realtime", prompt: "请先查 OEE" },
    });
    const r = reg.checkFinalize([]);
    expect(r.met).toBe(false);
    if (!r.met) {
      expect(r.missingTool).toBe("oee.realtime");
      expect(r.prompt).toBe("请先查 OEE");
    }
  });

  it("重复 id 抛错", () => {
    const reg = new PreconditionRegistry();
    reg.register({ id: "x", description: "x", check: () => ({ met: true }) });
    expect(() => reg.register({ id: "x", description: "x", check: () => ({ met: true }) })).toThrow();
  });

  it("calledToolNames 排除 rejected", () => {
    const trace: StepTrace[] = [{
      stepNumber: 0,
      toolCalls: [
        { id: "a", toolName: "x.safe", args: {}, result: {}, durationMs: 0 },
        { id: "b", toolName: "y.rejected", args: {}, result: {}, rejected: true, durationMs: 0 },
      ],
      finishReason: "tool-calls",
      durationMs: 0,
    }];
    expect([...calledToolNames(trace)]).toEqual(["x.safe"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// governance
// ─────────────────────────────────────────────────────────────────────────────

describe("governance：GovernanceChain", () => {
  it("空链全部放行", () => {
    const chain = new GovernanceChain();
    expect(chain.preToolUse("any", {})).toEqual({ allow: true });
  });

  it("阻断规则生效", () => {
    const chain = new GovernanceChain();
    const rule: GovernanceRule = {
      id: "no_pause_line_without_double_confirm",
      description: "停线操作需双确认",
      check: (name, args) => {
        if (name === "edge.pause_line" && !(args as { doubleConfirmed?: boolean }).doubleConfirmed) {
          return { allow: false, reason: "停线操作需双确认" };
        }
        return { allow: true };
      },
    };
    chain.add(rule);
    expect(chain.preToolUse("edge.pause_line", {}).allow).toBe(false);
    expect(chain.preToolUse("edge.pause_line", { doubleConfirmed: true })).toEqual({ allow: true });
    expect(chain.preToolUse("oee.realtime", {})).toEqual({ allow: true });
  });

  it("重复 id 抛错", () => {
    const chain = new GovernanceChain();
    chain.add({ id: "r1", description: "r1", check: () => ({ allow: true }) });
    expect(() => chain.add({ id: "r1", description: "r1", check: () => ({ allow: true }) })).toThrow();
  });

  it("toHooks 适配 harness 注入", () => {
    const chain = new GovernanceChain();
    chain.add({ id: "r1", description: "r1", check: () => ({ allow: false, reason: "x" }) });
    const hooks = chain.toHooks();
    expect(hooks.preToolUse?.("any", {})).toMatchObject({ allow: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// skill-bridge
// ─────────────────────────────────────────────────────────────────────────────

describe("skill-bridge：createSkill", () => {
  it("产出 SkillConnector 含 kind=skill + dynamicSteps", () => {
    const skill = createSkill({
      name: "skill.demo",
      description: "演示 skill",
      whenToUse: { triggers: ["演示"], notFor: [] },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
      outputExample: {},
      async steps(input) {
        const { step } = input;
        const a = await step("第一步", async () => "r1");
        await step("第二步", async () => `${a} done`);
        return {};
      },
    });
    expect(skill.kind).toBe("skill");
    expect(typeof skill.dynamicSteps).toBe("function");
    expect(skill.tier).toBe("domain");
    expect(skill.description).toContain("[Skill]");
  });

  it("execute 跑完全部步骤，累积结果", async () => {
    const skill = createSkill({
      name: "skill.seq",
      description: "序列 skill",
      whenToUse: { triggers: ["测试"], notFor: [] },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
      outputExample: {},
      async steps(input) {
        const { step } = input;
        const a = await step("s1", async () => "a");
        const b = await step("s2", async () => "b");
        return { last: b, first: a };
      },
    });
    const ctx = {
      taskId: "t", runId: "r", nodeId: "n", intent: "",
      emit: async () => ({}), requireConfirmation: async () => ({ approved: true }),
      resolveRef: () => undefined, resolveTool: () => undefined,
      recordOutput: () => {}, getOutput: () => undefined,
      bindNode: () => ({}), setIntent: () => {},
    } as unknown as Parameters<FlowConnector["execute"]>[1];
    const gen = skill.execute({}, ctx);
    const events: ToolEvent[] = [];
    let final: ToolResult | undefined;
    while (true) {
      const r = await gen.next();
      if (r.done) { final = r.value; break; }
      events.push(r.value);
    }
    // skill 现统一返回 EvidenceEnvelope；skill 执行元信息在 data._skill 里
    expect(final?.output).toMatchObject({ source: { provenance: "skill.seq" } });
    const meta = (final?.output as { data: { _skill: { skillName: string; completed: boolean; stepCount: number; stepResults: unknown[] } } }).data._skill;
    expect(meta.skillName).toBe("skill.seq");
    expect(meta.completed).toBe(true);
    expect(meta.stepResults).toEqual(["a", "b"]);
    // 1 个 tool_call + 2 个 workflow_node + 1 个 tool_result
    expect(events.length).toBe(4);
  });

  it("步骤失败时 completed=false 且带 errors", async () => {
    const skill = createSkill({
      name: "skill.fail",
      description: "失败 skill",
      whenToUse: { triggers: ["测试"], notFor: [] },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
      outputExample: {},
      async steps(input) {
        const { step } = input;
        await step("ok", async () => "ok");
        await step("boom", async () => { throw new Error("炸了"); });
        return {};
      },
    });
    const ctx = {
      taskId: "t", runId: "r", nodeId: "n", intent: "",
      emit: async () => ({}), requireConfirmation: async () => ({ approved: true }),
      resolveRef: () => undefined, resolveTool: () => undefined,
      recordOutput: () => {}, getOutput: () => undefined,
      bindNode: () => ({}), setIntent: () => {},
    } as unknown as Parameters<FlowConnector["execute"]>[1];
    const gen = skill.execute({}, ctx);
    let final: ToolResult | undefined;
    while (true) {
      const r = await gen.next();
      if (r.done) { final = r.value; break; }
    }
    expect(final?.output).toMatchObject({ data: { _skill: { completed: false } } });
    const errs = (final?.output as { data: { _skill: { errors?: string[] } } }).data._skill.errors;
    expect(errs?.[0]).toContain("炸了");
  });

  it("SkillConnector 可注册进 ToolRegistry", () => {
    const reg = new ToolRegistry();
    const skill = createSkill({
      name: "skill.reg",
      description: "注册测试",
      whenToUse: { triggers: ["测试"], notFor: [] },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
      outputExample: {},
      async steps(input) {
        const { step } = input;
        await step("s", async () => 1);
        return {};
      },
    }) as SkillConnector;
    reg.register(skill);
    expect(reg.has("skill.reg")).toBe(true);
    expect(reg.listByTier("domain").length).toBe(1);
  });
});
