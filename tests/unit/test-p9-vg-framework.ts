/**
 * S3 平台 V+G 框架单测：Precondition 注册 + Governance 阻断 + harness 配置集成。
 *
 * 验证：
 *   - GovernanceChain.toHooks() 注入 tool-adapter 后能阻断工具执行
 *   - PreconditionRegistry 注入 HarnessConfig 后影响 finishReason
 *   - call-sites 含 nexus_agent / nexus_advise（已在 S1 加）
 */
import { describe, it, expect } from "vitest";
import { adaptTool } from "../../src/agent/tool-adapter.js";
import { GovernanceChain, PreconditionRegistry, calledToolNames } from "../../src/agent/index.js";
import type { FlowConnector, ToolResult } from "../../src/tools/base.js";
import type { ToolEvent } from "../../src/core/stream-events.js";
import { CALL_SITES } from "../../src/llm/call-sites.js";

/** 一个 echo 工具。 */
function makeEcho(name: string): FlowConnector {
  return {
    name,
    tier: "domain",
    description: `echo ${name}`,
    inputSchema: { type: "object", properties: {} },
    whenToUse: { triggers: ["测试"], notFor: [] },
    outputSchema: {},
    outputExample: {},
    async *execute(): AsyncGenerator<ToolEvent, ToolResult> {
      return { output: { ok: true } };
    },
  };
}

function makeCtx() {
  return { taskId: "t", runId: "r", nodeId: "n" } as const;
}

// ─────────────────────────────────────────────────────────────────────────────
// Governance 阻断集成（tool-adapter）
// ─────────────────────────────────────────────────────────────────────────────

describe("S3 Governance → tool-adapter 集成", () => {
  it("governance 规则阻断工具执行，返回 governance_blocked", async () => {
    const chain = new GovernanceChain();
    chain.add({
      id: "block_dangerous",
      description: "禁止危险工具",
      check: (name) => (name === "x.dangerous" ? { allow: false, reason: "禁止" } : { allow: true }),
    });
    const hooks = chain.toHooks();

    const tool = makeEcho("x.dangerous");
    const adapted = adaptTool(tool, { governancePreToolUse: hooks.preToolUse }, makeCtx());
    const result = await adapted.execute?.({}, { toolCallId: "tc", messages: [] } as never);
    expect(result).toMatchObject({ governance_blocked: true, skipped: true });
    expect((result as { reason: string }).reason).toBe("禁止");
  });

  it("governance 放行时正常执行", async () => {
    const chain = new GovernanceChain();
    chain.add({
      id: "allow_safe",
      description: "只放 safe 工具",
      check: (name) => (name === "x.safe" ? { allow: true } : { allow: false, reason: "no" }),
    });
    const tool = makeEcho("x.safe");
    const adapted = adaptTool(tool, { governancePreToolUse: chain.toHooks().preToolUse }, makeCtx());
    const result = await adapted.execute?.({}, { toolCallId: "tc", messages: [] } as never);
    expect(result).toMatchObject({ ok: true });
  });

  it("无 governance 钩子时不影响执行（向后兼容）", async () => {
    const tool = makeEcho("x.any");
    const adapted = adaptTool(tool, {}, makeCtx());
    const result = await adapted.execute?.({}, { toolCallId: "tc", messages: [] } as never);
    expect(result).toMatchObject({ ok: true });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Precondition 注册（V 层）
// ─────────────────────────────────────────────────────────────────────────────

describe("S3 PreconditionRegistry 业务规则场景", () => {
  it("场景：诊断前必须有 OEE 实测 + 停机原因（双前置条件）", () => {
    const reg = new PreconditionRegistry();
    reg.register({
      id: "need_oee",
      description: "诊断前必须有 OEE 实测",
      check: (trace) => calledToolNames(trace).has("oee.realtime")
        ? { met: true }
        : { met: false, missingTool: "oee.realtime", prompt: "请先调 oee.realtime 取实测 OEE" },
    });
    reg.register({
      id: "need_downtime",
      description: "诊断前必须有停机原因",
      check: (trace) => calledToolNames(trace).has("equipment.downtime")
        ? { met: true }
        : { met: false, missingTool: "equipment.downtime", prompt: "请先调 equipment.downtime 取停机原因" },
    });

    // 都缺
    expect(reg.checkFinalize([]).met).toBe(false);
    // 只补 OEE
    const half: import("../../src/agent/types.js").StepTrace[] = [{
      stepNumber: 0, finishReason: "tool-calls", durationMs: 0,
      toolCalls: [{ id: "tc1", toolName: "oee.realtime", args: {}, result: {}, durationMs: 0 }],
    }];
    const r1 = reg.checkFinalize(half);
    expect(r1.met).toBe(false);
    if (!r1.met) expect(r1.missingTool).toBe("equipment.downtime");
    // 全补齐
    const full = [...half, {
      stepNumber: 1, finishReason: "tool-calls", durationMs: 0,
      toolCalls: [{ id: "tc2", toolName: "equipment.downtime", args: {}, result: {}, durationMs: 0 }],
    }] as import("../../src/agent/types.js").StepTrace[];
    expect(reg.checkFinalize(full).met).toBe(true);
  });

  it("every_step 型条件可独立查询", () => {
    const reg = new PreconditionRegistry();
    reg.register({
      id: "step_guard",
      description: "每步检查",
      phase: "every_step",
      check: () => ({ met: false, missingTool: "x", prompt: "未满足" }),
    });
    expect(reg.everyStepOnes().length).toBe(1);
    expect(reg.finalizeOnes().length).toBe(0);
    const unmet = reg.checkEveryStep([]);
    expect(unmet.length).toBe(1);
    expect(unmet[0]!.missingTool).toBe("x");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// call-sites 扩展验证
// ─────────────────────────────────────────────────────────────────────────────

describe("S3 call-sites 含 nexus 调用点", () => {
  it("CALL_SITES 含 nexus_agent / nexus_advise", () => {
    expect(CALL_SITES).toContain("nexus_agent");
    expect(CALL_SITES).toContain("nexus_advise");
  });
});
