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
}> = {}) {
  return {
    taskId: "t",
    runId: "r",
    nodeId: "n",
    intent: "",
    emit: extra.emit ?? (async () => ({})),
    requireConfirmation: extra.requireConfirmation ?? (async () => ({ approved: true })),
    resolveRef: () => undefined,
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
