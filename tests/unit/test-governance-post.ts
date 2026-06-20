/**
 * postToolUse 钩子单测（B1 平台机制）。
 *
 * 验证：
 *   - PostToolUseChain：warn 收集 + block 终止
 *   - governanceToHooks：合并 pre + post
 *   - tool-adapter：postToolUse warn 注入 _warnings / block 替换结果
 */
import { describe, it, expect } from "vitest";
import {
  GovernanceChain,
  PostToolUseChain,
  governanceToHooks,
  type GovernanceRule,
  type PostToolUseRule,
} from "../../src/agent/governance.js";
import { adaptTool } from "../../src/agent/tool-adapter.js";
import type { FlowConnector, ToolResult } from "../../src/tools/base.js";
import type { ToolEvent } from "../../src/core/stream-events.js";

describe("PostToolUseChain", () => {
  it("空链全放行（warns 为空，无 block）", () => {
    const chain = new PostToolUseChain();
    const r = chain.postToolUse("oee.realtime", {}, { data: 1 });
    expect(r.block).toBeUndefined();
    expect(r.warns).toEqual([]);
  });

  it("warn 规则收集到 warns 列表", () => {
    const chain = new PostToolUseChain();
    chain.add({
      id: "warn_inferred",
      description: "inferred 证据需交叉验证",
      check: (_name, _args, result) => {
        const env = result as { confidence?: string };
        if (env?.confidence === "inferred") {
          return { pass: false, reason: "inferred 证据，请交叉验证", severity: "warn" as const };
        }
        return { pass: true };
      },
    });
    const r = chain.postToolUse("oee.realtime", {}, { confidence: "inferred" });
    expect(r.block).toBeUndefined();
    expect(r.warns.length).toBe(1);
    expect(r.warns[0]!.reason).toContain("inferred");
    expect(r.warns[0]!.severity).toBe("warn");
  });

  it("block 规则终止遍历（首个 block 即返回）", () => {
    const chain = new PostToolUseChain();
    let secondChecked = false;
    chain.add({
      id: "block_conflict",
      description: "证据冲突阻断",
      check: () => ({ pass: false, reason: "证据冲突", severity: "block" as const }),
    });
    chain.add({
      id: "second_rule",
      description: "不应被检查",
      check: () => {
        secondChecked = true;
        return { pass: true };
      },
    });
    const r = chain.postToolUse("oee.realtime", {}, {});
    expect(r.block).toBeDefined();
    expect(r.block!.severity).toBe("block");
    expect(r.block!.reason).toBe("证据冲突");
    expect(secondChecked).toBe(false); // block 后不再遍历
  });

  it("多 warn 合并 + block 优先", () => {
    const chain = new PostToolUseChain();
    chain.add({
      id: "warn1",
      description: "warn1",
      check: () => ({ pass: false, reason: "warn1", severity: "warn" as const }),
    });
    chain.add({
      id: "block1",
      description: "block1",
      check: () => ({ pass: false, reason: "block1", severity: "block" as const }),
    });
    const r = chain.postToolUse("x", {}, {});
    expect(r.warns.length).toBe(1); // warn1 已收集
    expect(r.block).toBeDefined();
    expect(r.block!.reason).toBe("block1");
  });

  it("重复 id 抛错", () => {
    const chain = new PostToolUseChain();
    chain.add({ id: "r1", description: "r1", check: () => ({ pass: true }) });
    expect(() => chain.add({ id: "r1", description: "r1", check: () => ({ pass: true }) })).toThrow();
  });

  it("severity 缺省为 warn", () => {
    const chain = new PostToolUseChain();
    chain.add({
      id: "default_warn",
      description: "无 severity",
      check: () => ({ pass: false, reason: "默认 warn" }),
    });
    const r = chain.postToolUse("x", {}, {});
    expect(r.warns.length).toBe(1);
    expect(r.warns[0]!.severity).toBe("warn");
  });
});

describe("governanceToHooks 合并 pre + post", () => {
  it("pre 放行 + post 放行 → 全放行", () => {
    const pre = new GovernanceChain();
    const post = new PostToolUseChain();
    const hooks = governanceToHooks(pre, post);
    expect(hooks.preToolUse!("x", {}, "safe")).toEqual({ allow: true });
    expect(hooks.postToolUse!("x", {}, {})).toEqual({ pass: true });
  });

  it("pre 阻断 → 返回 allow:false", () => {
    const pre = new GovernanceChain();
    pre.add({
      id: "block_x",
      description: "block x",
      check: (name) => (name === "x" ? { allow: false, reason: "禁 x" } : { allow: true }),
    } satisfies GovernanceRule);
    const hooks = governanceToHooks(pre);
    expect(hooks.preToolUse!("x", {}, "safe").allow).toBe(false);
  });

  it("post warn → 返回 pass:false + severity:warn", () => {
    const pre = new GovernanceChain();
    const post = new PostToolUseChain();
    post.add({
      id: "warn_rule",
      description: "warn",
      check: () => ({ pass: false, reason: "警告", severity: "warn" }),
    } satisfies PostToolUseRule);
    const hooks = governanceToHooks(pre, post);
    const r = hooks.postToolUse!("x", {}, {});
    expect(r.pass).toBe(false);
    if (!r.pass) {
      expect(r.severity).toBe("warn");
      expect(r.reason).toContain("警告");
    }
  });

  it("post block → 返回 pass:false + severity:block", () => {
    const pre = new GovernanceChain();
    const post = new PostToolUseChain();
    post.add({
      id: "block_rule",
      description: "block",
      check: () => ({ pass: false, reason: "阻断", severity: "block" }),
    } satisfies PostToolUseRule);
    const hooks = governanceToHooks(pre, post);
    const r = hooks.postToolUse!("x", {}, {});
    expect(r.pass).toBe(false);
    if (!r.pass) expect(r.severity).toBe("block");
  });
});

/** 构造一个返回固定 output 的最小 FlowConnector（测试 tool-adapter 用）。 */
function makeConnector(name: string, output: unknown): FlowConnector {
  return {
    name,
    tier: "domain",
    description: "test",
    inputSchema: { type: "object", properties: {} },
    whenToUse: { triggers: ["t"], notFor: [] },
    outputSchema: { type: "object" },
    outputExample: {},
    async *execute(): AsyncGenerator<ToolEvent, ToolResult> {
      return { output };
    },
  };
}

const makeCtx = () => ({ taskId: "t", runId: "r", nodeId: "n" });

/** 调用适配工具的 execute（收敛 AI SDK tool 的两参签名 + 联合返回类型）。 */
async function runAdapted(
  adapted: ReturnType<typeof adaptTool>,
): Promise<Record<string, unknown>> {
  const fn = adapted.execute!;
  return (await fn({} as never, {} as never)) as unknown as Record<string, unknown>;
}

describe("tool-adapter postToolUse 集成", () => {
  it("warn → output 注入 _warnings，原数据保留", async () => {
    const connector = makeConnector("oee.realtime", {
      data: { oee: 0.65 },
      confidence: "inferred",
    });
    const adapted = adaptTool(
      connector,
      {
        governancePostToolUse: (_n, _a, result) => {
          const env = result as { confidence?: string };
          if (env?.confidence === "inferred") {
            return { pass: false, reason: "inferred 需交叉验证", severity: "warn" as const };
          }
          return { pass: true };
        },
      },
      makeCtx(),
    );
    const out = await runAdapted(adapted);
    expect(out._warnings).toBeDefined();
    expect((out._warnings as string[]).some((w) => w.includes("inferred"))).toBe(true);
    expect((out as { data: { oee: number } }).data.oee).toBe(0.65); // 原数据保留
  });

  it("block → output 替换为 { blocked: true, reason }", async () => {
    const connector = makeConnector("oee.realtime", { data: { oee: 0.65 } });
    const adapted = adaptTool(
      connector,
      {
        governancePostToolUse: () => ({
          pass: false,
          reason: "证据冲突，不可用",
          severity: "block" as const,
        }),
      },
      makeCtx(),
    );
    const out = await runAdapted(adapted);
    expect(out.blocked).toBe(true);
    expect(String(out.reason)).toContain("冲突");
    expect(out.data).toBeUndefined(); // 原数据被替换
  });

  it("放行 → output 原样（无 _warnings）", async () => {
    const connector = makeConnector("oee.realtime", { data: { oee: 0.65 } });
    const adapted = adaptTool(
      connector,
      { governancePostToolUse: () => ({ pass: true }) },
      makeCtx(),
    );
    const out = await runAdapted(adapted);
    expect(out._warnings).toBeUndefined();
    expect((out as { data: { oee: number } }).data.oee).toBe(0.65);
  });

  it("无 governancePostToolUse → output 原样（兼容）", async () => {
    const connector = makeConnector("oee.realtime", { data: { oee: 0.65 } });
    const adapted = adaptTool(connector, {}, makeCtx());
    const out = await runAdapted(adapted);
    expect((out as { data: { oee: number } }).data.oee).toBe(0.65);
  });
});
