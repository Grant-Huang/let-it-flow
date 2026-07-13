/**
 * 动态 DSL 单测：验证 createSkill 统一使用 async steps(input) 写法。
 *
 * 核心能力：
 *   - input.step(name, fn)：声明式注册步骤，fn 内可条件/循环
 *   - ctx.call(toolName, params)：查注册表调已注册工具（含语义别名）
 *   - ctx.requireConfirmation(gate)：HITL 暂停点
 *   - ctx.emit(event)：透传事件
 */
import { describe, it, expect } from "vitest";
import { createSkill } from "../../../src/agent/skill-bridge.js";
import type { FlowConnector, ToolResult } from "../../../src/tools/base.js";
import type { ToolEvent } from "../../../src/core/stream-events.js";

/** mock ExecutionContext（dsl 执行需要 emit/requireConfirmation）。 */
function mockCtx(extra: Partial<{
  emit: (e: ToolEvent) => Promise<unknown>;
  requireConfirmation: (g: unknown) => Promise<{ approved: boolean; params?: Record<string, unknown> }>;
  resolveTool: (name: string) => FlowConnector | undefined;
  resolveRef: (ref: string) => unknown;
}> = {}) {
  return {
    taskId: "t",
    runId: "r",
    nodeId: "n",
    intent: "",
    emit: extra.emit ?? (async () => ({})),
    requireConfirmation: extra.requireConfirmation ?? (async () => ({ approved: true })),
    resolveRef: extra.resolveRef ?? (() => undefined),
    // DSL 专用：ctx.call 解析工具名 → connector（由 boot 注入注册表）
    resolveTool: extra.resolveTool ?? (() => undefined),
  } as unknown as Parameters<FlowConnector["execute"]>[1];
}

/** 消费 skill execute generator，取最终 ToolResult + 全部事件。 */
async function runSkill(
  skill: FlowConnector,
  args: Record<string, unknown>,
  ctx?: Parameters<FlowConnector["execute"]>[1],
): Promise<{ events: ToolEvent[]; final: ToolResult | undefined }> {
  const gen = skill.execute(args, ctx ?? mockCtx());
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

// ─────────────────────────────────────────────────────────────────────────────
// 动态 DSL 基础：input.step + 条件分支
// ─────────────────────────────────────────────────────────────────────────────

describe("P2 动态 DSL 基础", () => {
  it("async steps(input) 动态写法：线性两步", async () => {
    const skill = createSkill({
      name: "test.dynamic.linear",
      description: "动态线性测试",
      whenToUse: { triggers: ["t"], notFor: [] },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      outputExample: {},
      async steps(input) {
        const { step } = input;
        const a = await step("第一步", async () => 1);
        const b = await step("第二步", async () => (a as number) + 1);
        return { threads: [], count: b as number };
      },
    });
    const { final } = await runSkill(skill, { count: 0 });
    expect(final?.output).toBeDefined();
    // 动态 DSL 返回值应作为 skill 最终输出（包装在 data._skill）
    const data = (final!.output as { data: { stepResults: unknown[]; _skill?: { stepCount: number } } }).data;
    expect(data._skill?.stepCount).toBe(2);
    expect(data.stepResults.length).toBe(2);
  });

  it("条件分支：单线索不打扰用户，多线索才反问", async () => {
    let confirmCalled = false;
    const ctx = mockCtx({
      requireConfirmation: async () => {
        confirmCalled = true;
        return { approved: true, params: { choice: 0 } };
      },
    });

    const buildSkill = (threadCount: number) =>
      createSkill({
        name: "test.dynamic.branch",
        description: "条件分支测试",
        whenToUse: { triggers: ["t"], notFor: [] },
        inputSchema: { type: "object", properties: {} },
        outputSchema: { type: "object" },
        outputExample: {},
        async steps(input) {
          const { step } = input;
          const threads = Array.from({ length: threadCount }, (_, i) => ({ id: i, summary: `t${i}` }));
          let selected = threads[0]!;
          if (threads.length > 1) {
            await step("请用户选", async (c) => {
              return c.requireConfirmation({ prompt: "选哪个", options: threads.map((t) => t.summary) });
            });
            selected = threads[0]!;
          }
          return { selected };
        },
      });

    // 单线索：不应调用 requireConfirmation
    confirmCalled = false;
    await runSkill(buildSkill(1), {}, ctx);
    expect(confirmCalled).toBe(false);

    // 多线索：应调用 requireConfirmation
    confirmCalled = false;
    await runSkill(buildSkill(3), {}, ctx);
    expect(confirmCalled).toBe(true);
  });

  it("校验-重写循环：可选步骤", async () => {
    const skill = createSkill({
      name: "test.dynamic.loop",
      description: "校验重写循环测试",
      whenToUse: { triggers: ["t"], notFor: [] },
      inputSchema: { type: "object", properties: { needsRevise: {} } },
      outputSchema: { type: "object" },
      outputExample: {},
      async steps(input) {
        const { step } = input;
        const draft = await step("初稿", async () => "草稿");
        let final = draft as string;
        // 条件步骤：只有 needsRevise=true 才执行
        if (input.needsRevise === true) {
          final = (await step("重写", async () => "重写稿")) as string;
        }
        return { script: final };
      },
    });

    // 无需重写：1 步
    const r1 = await runSkill(skill, { needsRevise: false });
    const d1 = (r1.final!.output as { data: { _skill?: { stepCount: number } } }).data;
    expect(d1._skill?.stepCount).toBe(1);

    // 需重写：2 步
    const r2 = await runSkill(skill, { needsRevise: true });
    const d2 = (r2.final!.output as { data: { _skill?: { stepCount: number } } }).data;
    expect(d2._skill?.stepCount).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ctx.call 语义别名：调注册表工具
// ─────────────────────────────────────────────────────────────────────────────

describe("P2 ctx.call 语义别名", () => {
  it("ctx.call 调用注册表中的工具并返回其 output", async () => {
    // 注册一个假 llm_node 工具，返回固定 JSON；同时记录收到的入参（验证别名参数标准化）
    let receivedParams: Record<string, unknown> = {};
    const fakeLlmNode: FlowConnector = {
      name: "core.llm_node",
      tier: "core",
      description: "假 llm",
      inputSchema: { type: "object", properties: {} },
      whenToUse: { triggers: [], notFor: [] },
      outputSchema: { type: "object" },
      outputExample: {},
      async *execute(params) {
        receivedParams = params as Record<string, unknown>;
        return { output: { result: "来自 llm_node" } };
      },
    };
    const ctx = mockCtx({ resolveTool: (name) => (name === "core.llm_node" ? fakeLlmNode : undefined) });

    const skill = createSkill({
      name: "test.call.alias",
      description: "ctx.call 别名测试",
      whenToUse: { triggers: [], notFor: [] },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      outputExample: {},
      async steps(input) {
        const { step } = input;
        const result = await step("分析", async (c) => {
          // "thought" 是 core.llm_node 的语义别名；directive 应被标准化为 prompt
          return c.call<{ result: string }>("thought", { directive: "分析一下" });
        });
        return { analysis: (result as { result: string }).result };
      },
    });

    const { final } = await runSkill(skill, {}, ctx);
    const data = (final!.output as { data: { stepResults: Array<{ result: string }> } }).data;
    expect(data.stepResults[0]!.result).toBe("来自 llm_node");
    // 关键：别名参数标准化 —— directive 应被映射为底层工具的 prompt 字段
    expect(receivedParams.prompt).toBe("分析一下");
    expect(receivedParams.directive).toBeUndefined();
  });

  it("ctx.call 别名映射：thought/generate → core.llm_node，kb.search → core.knowledge_base", async () => {
    // 验证别名解析逻辑（不实际调工具，只看解析到的目标工具名）
    const resolvedNames: string[] = [];
    const ctx = mockCtx({
      resolveTool: (name) => {
        resolvedNames.push(name);
        return undefined;
      },
    });

    const skill = createSkill({
      name: "test.alias.map",
      description: "别名映射测试",
      whenToUse: { triggers: [], notFor: [] },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      outputExample: {},
      async steps(input) {
        const { step } = input;
        await step("s1", async (c) => { try { await c.call("thought", {}); } catch {} });
        await step("s2", async (c) => { try { await c.call("generate", {}); } catch {} });
        await step("s3", async (c) => { try { await c.call("kb.search", {}); } catch {} });
        return { done: true };
      },
    });

    await runSkill(skill, {}, ctx);
    // 别名应解析到真实工具名
    expect(resolvedNames).toContain("core.llm_node");
    expect(resolvedNames).toContain("core.knowledge_base");
  });

  it("ctx.call 调用未注册工具时抛清晰错误", async () => {
    const skill = createSkill({
      name: "test.call.missing",
      description: "未注册工具测试",
      whenToUse: { triggers: [], notFor: [] },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      outputExample: {},
      async steps(input) {
        const { step } = input;
        await step("s", async (c) => c.call("nonexistent.tool", {}));
        return {};
      },
    });

    // 工具未注册，step 应抛错，skill 标记为部分失败
    const { final } = await runSkill(skill, {});
    const skillMeta = (final!.output as { data: { _skill?: { completed: boolean; errors?: string[] } } }).data._skill;
    expect(skillMeta?.completed).toBe(false);
    expect(skillMeta?.errors?.some((e) => e.includes("nonexistent") || e.includes("未注册"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// workflow_node 事件发射（步骤进度）
// ─────────────────────────────────────────────────────────────────────────────

describe("P2 动态 DSL 事件发射", () => {
  it("每个 step 调用都发 workflow_node 事件（含步骤名）", async () => {
    const skill = createSkill({
      name: "test.events",
      description: "事件发射测试",
      whenToUse: { triggers: [], notFor: [] },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      outputExample: {},
      async steps(input) {
        const { step } = input;
        await step("收集", async () => 1);
        await step("分析", async () => 2);
        return { done: true };
      },
    });

    const { events } = await runSkill(skill, {});
    const nodeEvents = events.filter((e) => e.type === "workflow_node");
    // 应有 tool_call + tool_result（skill 整体）+ 2 个 workflow_node（步骤）
    expect(nodeEvents.length).toBe(2);
    const names = nodeEvents.map((e) => (e.payload as { name: string }).name);
    expect(names).toContain("收集");
    expect(names).toContain("分析");
  });

  it("tool_call/tool_result 事件正常发射（skill 整体）", async () => {
    const skill = createSkill({
      name: "test.toolcall",
      description: "tool_call 事件测试",
      whenToUse: { triggers: [], notFor: [] },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      outputExample: {},
      async steps(input) {
        const { step } = input;
        await step("s1", async () => 1);
        return { done: true };
      },
    });

    const { events } = await runSkill(skill, {});
    const callEvents = events.filter((e) => e.type === "tool_call");
    const resultEvents = events.filter((e) => e.type === "tool_result");
    expect(callEvents.length).toBe(1);
    expect(resultEvents.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 错误处理
// ─────────────────────────────────────────────────────────────────────────────

describe("P2 动态 DSL 错误处理", () => {
  it("step 抛错时 skill 标记部分失败，不中断事件流", async () => {
    const skill = createSkill({
      name: "test.error",
      description: "错误处理测试",
      whenToUse: { triggers: [], notFor: [] },
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object" },
      outputExample: {},
      async steps(input) {
        const { step } = input;
        await step("成功步", async () => 1);
        await step("失败步", async () => { throw new Error("模拟失败"); });
        await step("不应到达", async () => 3); // 不应执行
        return {};
      },
    });

    const { events, final } = await runSkill(skill, {});
    const skillMeta = (final!.output as { data: { _skill?: { completed: boolean; stepCount: number; errors?: string[] } } }).data._skill;
    expect(skillMeta?.completed).toBe(false);
    expect(skillMeta?.stepCount).toBe(1); // 只有第一步成功
    expect(skillMeta?.errors?.some((e) => e.includes("模拟失败"))).toBe(true);
    // tool_result 事件仍应发射（含错误 caveat）
    const resultEvents = events.filter((e) => e.type === "tool_result");
    expect(resultEvents.length).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// StepCtx.resolveRef 透传（S1：skill 间数据流通道）
// ─────────────────────────────────────────────────────────────────────────────

describe("S1 StepCtx.resolveRef 透传", () => {
  it("ctx.resolveRef 透传自 ExecutionContext，能读到上游 skill / 工具的结构化产出", async () => {
    // 模拟上游 skill 产出的 EvidenceEnvelope.data
    const upstreamOutput = {
      data: { rootCause: "刀具磨损", metrics: { oee: 0.62 }, recs: [{ id: "r1" }] },
      freshness: "realtime",
      capturedAt: "2026-07-13T00:00:00Z",
      confidence: "inferred",
      source: { system: "skill", provenance: "oee_diagnose" },
    };

    const ctx = mockCtx({
      resolveRef: (ref: string) => {
        // 解析 $.tasks[prior_call_1].output 与 $.tasks[prior_call_1].output.data
        if (ref === "$.tasks[prior_call_1].output") return upstreamOutput;
        if (ref === "$.tasks[prior_call_1].output.data") return upstreamOutput.data;
        return undefined;
      },
    });

    const skill = createSkill({
      name: "test.s1.resolve_ref",
      description: "resolveRef 透传测试",
      whenToUse: { triggers: ["t"], notFor: [] },
      inputSchema: { type: "object", properties: { priorCallId: { type: "string" } } },
      outputSchema: { type: "object" },
      outputExample: {},
      async steps(input) {
        const { step } = input;
        const priorData = await step("读取前序产出", async (c) => {
          // 核心断言目标：skill 内能通过 ctx.resolveRef 读取上游产出
          return c.resolveRef!(`$.tasks[${input.priorCallId as string}].output.data`);
        });
        return { priorData };
      },
    });

    const { final } = await runSkill(skill, { priorCallId: "prior_call_1" }, ctx);
    const stepResults = (final!.output as { data: { stepResults: unknown[] } }).data.stepResults;
    expect(stepResults[0]).toEqual(upstreamOutput.data);
  });

  it("resolveRef 未注入时（ReAct/测试 mock 缺省），skill 走优雅降级路径", async () => {
    // 构造完全不提供 resolveRef 的 ExecutionContext（模拟 ReAct 路径未升级时的占位 ctx）
    const ctxWithoutResolveRef = {
      taskId: "t",
      runId: "r",
      nodeId: "n",
      intent: "",
      emit: async () => ({}),
      requireConfirmation: async () => ({ approved: true }),
      resolveTool: () => undefined,
      // 故意不提供 resolveRef
    } as unknown as Parameters<FlowConnector["execute"]>[1];

    const skill = createSkill({
      name: "test.s1.degrade",
      description: "resolveRef 缺省降级测试",
      whenToUse: { triggers: ["t"], notFor: [] },
      inputSchema: { type: "object", properties: { primaryRootCause: { type: "string" } } },
      outputSchema: { type: "object" },
      outputExample: {},
      async steps(input) {
        const { step } = input;
        const composed = await step("LLM 编排（降级）", async (c) => {
          // 推荐范式：先尝试 resolveRef，不可用时回退到 input 参数
          let v: unknown;
          if (c.resolveRef && typeof input.priorCallId === "string") {
            v = c.resolveRef(`$.tasks[${input.priorCallId as string}].output.data`);
          } else {
            v = { degraded: true, fromInput: { rootCause: input.primaryRootCause } };
          }
          return v;
        });
        return { composed };
      },
    });

    const { final } = await runSkill(skill, { primaryRootCause: "刀具磨损" }, ctxWithoutResolveRef);
    const stepResults = (final!.output as { data: { stepResults: Array<{ degraded: boolean; fromInput: { rootCause: string } }> } }).data.stepResults;
    expect(stepResults[0]!.degraded).toBe(true);
    expect(stepResults[0]!.fromInput.rootCause).toBe("刀具磨损");
  });

  it("StepsInput.priorCallId 支持 string 与 string[]（S2 约定字段，planner 透传）", async () => {
    // 验证 priorCallId 字段可作为 skill 输入参数透传，且不影响 step() 工厂
    const skill = createSkill({
      name: "test.s2.prior_call_id",
      description: "priorCallId 字段透传测试",
      whenToUse: { triggers: ["t"], notFor: [] },
      inputSchema: {
        type: "object",
        properties: {
          priorCallId: { type: ["string", "array"], items: { type: "string" } },
          priorKind: { type: "string" },
        },
      },
      outputSchema: { type: "object" },
      outputExample: {},
      async steps(input) {
        const { step } = input;
        const echoed = await step("回显约定字段", async () => {
          return {
            priorCallId: input.priorCallId,
            priorKind: input.priorKind,
          };
        });
        return echoed as Record<string, unknown>;
      },
    });

    // string 形态
    const r1 = await runSkill(skill, { priorCallId: "call_a", priorKind: "oee_diagnose" });
    const d1 = (r1.final!.output as { data: { stepResults: Array<{ priorCallId: unknown; priorKind: unknown }> } }).data.stepResults[0]!;
    expect(d1.priorCallId).toBe("call_a");
    expect(d1.priorKind).toBe("oee_diagnose");

    // string[] 形态
    const r2 = await runSkill(skill, { priorCallId: ["call_a", "call_b"], priorKind: "multi" });
    const d2 = (r2.final!.output as { data: { stepResults: Array<{ priorCallId: unknown }> } }).data.stepResults[0]!;
    expect(d2.priorCallId).toEqual(["call_a", "call_b"]);
  });
});
