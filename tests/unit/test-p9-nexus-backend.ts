/**
 * S6 NexusOps 后端装配单测。
 *
 * 验证 boot.ts 的装配产出（不触发真实 LLM 网络调用）：
 *   - 工具集注册完整（core builtin + nexus domain.* + skill.* + core.knowledge_base）
 *   - KB providers 装配（临时 vault）
 *   - preconditions/governance 规则可被触发
 *   - taskRuntime.customRunner 已注入并可被 TaskRegistry 调用
 *
 * 真实 ReAct 全链路（需 LLM 网络）留 e2e（S8）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "../../src/tools/registry.js";
import { TaskRegistry } from "../../src/tasks/registry.js";
import { buildNexusTools } from "../../apps/nexusops/tools/index.js";
import { buildNexusSkills } from "../../apps/nexusops/skills/index.js";
import { bootNexusOps } from "../../apps/nexusops/server/boot.js";
import { buildNexusPreconditions } from "../../apps/nexusops/server/preconditions.js";
import { buildNexusGovernance } from "../../apps/nexusops/server/governance.js";
import { buildNexusPostToolUseChain } from "../../apps/nexusops/server/post-rules.js";
import { buildNexusPrepareStep } from "../../apps/nexusops/server/prepare-step.js";
import { SkillRegistry } from "../../src/agent/skill-registry.js";
import { isEvidenceEnvelope } from "../../src/core/evidence-envelope.js";
import type { LlmService } from "../../src/services/llm-service.js";

let dataDir: string;
let vaultPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "nexus-boot-"));
  vaultPath = join(dataDir, "vault");
  mkdirSync(join(vaultPath, "01-现场状态"), { recursive: true });
  writeFileSync(
    join(vaultPath, "01-现场状态", "OEE计算口径.md"),
    "---\ntitle: OEE 计算口径\ntags: [oee, sop]\n---\nOEE = 可用率 × 表现率 × 质量率。\n",
    "utf8",
  );
  for (const k of ["LIF_DATA_DIR", "OBSIDIAN_VAULT_PATH", "NEXUS_MCP_SERVERS", "NEXUS_MAX_STEPS"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.LIF_DATA_DIR = dataDir;
  process.env.OBSIDIAN_VAULT_PATH = vaultPath;
  delete process.env.NEXUS_MCP_SERVERS;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** mock LlmService：model() 返回桩 LanguageModel（不真调网络）。 */
function mockLlm(): LlmService {
  return {
    model: () => ({ specificationVersion: "v1" }) as never,
    modelById: () => ({ specificationVersion: "v1" }) as never,
    subscribeConfigChanges: () => {},
    compatMode: false,
    compatModeFor: () => false,
  } as unknown as LlmService;
}

describe("S6 NexusOps 后端装配", () => {
  it("boot 装配后工具池含 core builtin + nexus domain + skill + kb", async () => {
    const runtime = await bootNexusOps({ llm: mockLlm() });
    const names = new Set(runtime.toolRegistry.list().map((t) => t.name));

    // core builtin
    expect(names.has("core.web_search")).toBe(true);
    expect(names.has("core.web_fetch")).toBe(true);
    // nexus domain（抽样）
    expect(names.has("oee.realtime")).toBe(true);
    expect(names.has("equipment.downtime")).toBe(true);
    expect(names.has("quality.pareto")).toBe(true);
    // nexus 收尾/建议
    expect(names.has("nexus_finalize")).toBe(true);
    expect(names.has("nexus_advise")).toBe(true);
    // skill
    expect(names.has("skill.oee_diagnose")).toBe(true);
    expect(names.has("skill.downtime_root_cause")).toBe(true);
    // kb
    expect(names.has("core.knowledge_base")).toBe(true);

    // 工具总数 >= 60（domain）+ 2 skill + 4 core builtin + 1 kb + 2 nexus = 69
    expect(runtime.toolRegistry.list().length).toBeGreaterThanOrEqual(60);
  });

  it("boot 装配 Obsidian KB provider（临时 vault）", async () => {
    const runtime = await bootNexusOps({ llm: mockLlm() });
    expect(runtime.knowledgeProviders.length).toBeGreaterThanOrEqual(1);
    expect(runtime.knowledgeProviders.some((p) => p.id === "obsidian")).toBe(true);
    const obsidian = runtime.knowledgeProviders.find((p) => p.id === "obsidian")!;
    expect(obsidian.ready()).toBe(true);
    const hits = await obsidian.search({ query: "OEE 计算口径", topK: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.title).toContain("OEE");
  });

  it("taskRuntime.customRunner 已注入", async () => {
    const runtime = await bootNexusOps({ llm: mockLlm() });
    expect(typeof runtime.taskRuntime.customRunner).toBe("function");
    expect(runtime.taskRuntime.llm).toBeDefined();
    expect(runtime.taskRuntime.toolRegistry).toBe(runtime.toolRegistry);
  });

  it("MCP server 未配时 router 为空（降级不阻塞）", async () => {
    const runtime = await bootNexusOps({ llm: mockLlm() });
    expect(runtime.mcpRouter.listServerIds()).toEqual([]);
  });
});

describe("S6 NexusOps precondition 规则", () => {
  it("讨论 OEE 但无 oee.* 取证 → precondition 未满足", () => {
    const reg = buildNexusPreconditions();
    const trace = [
      {
        stepNumber: 0,
        thought: "用户问 OEE 为什么低，我直接给建议",
        toolCalls: [
          { id: "tc1", toolName: "nexus_advise", args: {}, result: {}, durationMs: 0 },
        ],
        finishReason: "tool-calls",
        usage: { totalTokens: 10 },
        durationMs: 0,
      },
    ];
    const r = reg.checkFinalize(trace as never);
    expect(r.met).toBe(false);
    if (!r.met) {
      expect(r.missingTool).toBe("oee.realtime");
      expect(r.prompt).toContain("oee");
    }
  });

  it("讨论 OEE 且已 oee.* 取证 → 满足", () => {
    const reg = buildNexusPreconditions();
    const trace = [
      {
        stepNumber: 0,
        thought: "先查 OEE 实测",
        toolCalls: [
          { id: "tc1", toolName: "oee.realtime", args: {}, result: {}, durationMs: 0 },
          { id: "tc2", toolName: "nexus_advise", args: {}, result: {}, durationMs: 0 },
        ],
        finishReason: "tool-calls",
        usage: { totalTokens: 10 },
        durationMs: 0,
      },
    ];
    expect(reg.checkFinalize(trace as never).met).toBe(true);
  });

  it("讨论停机但无 equipment.* 取证 → 未满足", () => {
    const reg = buildNexusPreconditions();
    const trace = [
      {
        stepNumber: 0,
        thought: "停机原因是设备老化，建议...",
        toolCalls: [
          { id: "tc1", toolName: "nexus_advise", args: {}, result: {}, durationMs: 0 },
        ],
        finishReason: "tool-calls",
        usage: { totalTokens: 10 },
        durationMs: 0,
      },
    ];
    const r = reg.checkFinalize(trace as never);
    expect(r.met).toBe(false);
    if (!r.met) expect(r.missingTool).toBe("equipment.downtime");
  });

  it("不涉及 OEE/停机的建议 → 不触发前置条件", () => {
    const reg = buildNexusPreconditions();
    const trace = [
      {
        stepNumber: 0,
        thought: "能耗偏高，建议优化",
        toolCalls: [
          { id: "tc1", toolName: "energy.realtime", args: {}, result: {}, durationMs: 0 },
          { id: "tc2", toolName: "nexus_advise", args: {}, result: {}, durationMs: 0 },
        ],
        finishReason: "tool-calls",
        usage: { totalTokens: 10 },
        durationMs: 0,
      },
    ];
    expect(reg.checkFinalize(trace as never).met).toBe(true);
  });
});

describe("S6 NexusOps governance 规则", () => {
  it("批量排产变更（>3 工单）被阻断", () => {
    const chain = buildNexusGovernance();
    const r = chain.preToolUse("mcp.mes.schedule_work_order", {
      orderIds: ["o1", "o2", "o3", "o4"],
    });
    expect(r.allow).toBe(false);
    if (!r.allow) expect(r.reason).toContain("批量");
  });

  it("小批量排产变更放行", () => {
    const chain = buildNexusGovernance();
    const r = chain.preToolUse("mcp.mes.schedule_work_order", { orderIds: ["o1"] });
    expect(r.allow).toBe(true);
  });

  it("非排产工具放行", () => {
    const chain = buildNexusGovernance();
    const r = chain.preToolUse("oee.realtime", {});
    expect(r.allow).toBe(true);
  });

  it("批量下达工单（items >3）被阻断", () => {
    const chain = buildNexusGovernance();
    const r = chain.preToolUse("mcp.mes.reallocate_capacity", { items: [1, 2, 3, 4, 5] });
    expect(r.allow).toBe(false);
  });
});

describe("S6 customRunner 注入 TaskRegistry", () => {
  it("TaskRegistry 走 customRunner 分支（不触发真实 LLM）", async () => {
    // customRunner 内部会调 runReactHarness，需真实 model；
    // 这里只验证注入路径正确（start 会调 customRunner 而非 runPlanned/runStub）。
    const runtime = await bootNexusOps({ llm: mockLlm() });
    let runnerCalled = false;
    const wrappedRuntime = {
      ...runtime.taskRuntime,
      customRunner: async () => {
        runnerCalled = true;
      },
    };
    const registry = new TaskRegistry(undefined, wrappedRuntime);
    const meta = registry.start("测试意图");
    await registry.join(meta.id);
    expect(runnerCalled).toBe(true);
  });
});

describe("S6 装配产物一致性", () => {
  it("buildNexusTools 与 boot 工具集一致（无重复注册）", () => {
    const standalone = buildNexusTools();
    const skills = buildNexusSkills();
    const allNames = [...standalone, ...skills].map((t) => t.name);
    const unique = new Set(allNames);
    expect(unique.size).toBe(allNames.length); // 无重名
  });

  it("ToolRegistry 可独立构造并注册 nexus 工具", () => {
    const reg = new ToolRegistry();
    for (const t of buildNexusTools()) reg.register(t);
    for (const s of buildNexusSkills()) reg.register(s);
    expect(reg.list().length).toBeGreaterThanOrEqual(62); // 60 domain + 2 skill
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A1: every_step precondition
// ─────────────────────────────────────────────────────────────────────────────

describe("S6 every_step precondition（A1）", () => {
  it("注册了 every_step 型规则（oee + downtime 各一条）", () => {
    const reg = buildNexusPreconditions();
    const everyStep = reg.everyStepOnes();
    expect(everyStep.length).toBe(2);
    expect(everyStep.some((p) => p.id.includes("oee"))).toBe(true);
    expect(everyStep.some((p) => p.id.includes("downtime"))).toBe(true);
  });

  it("every_step 规则与 on_finalize 逻辑一致（同 trace 结果相同）", () => {
    const reg = buildNexusPreconditions();
    const trace = [
      {
        stepNumber: 0,
        thought: "用户问 OEE 为什么低，我直接给建议",
        toolCalls: [
          { id: "tc1", toolName: "nexus_advise", args: {}, result: {}, durationMs: 0 },
        ],
        finishReason: "tool-calls",
        usage: { totalTokens: 10 },
        durationMs: 0,
      },
    ];
    const everyStep = reg.checkEveryStep(trace as never);
    expect(everyStep.length).toBeGreaterThan(0);
    expect(everyStep.some((r) => r.missingTool === "oee.realtime")).toBe(true);
  });

  it("collectEveryStepReminders 返回提示文本", async () => {
    const { collectEveryStepReminders } = await import("../../apps/nexusops/server/preconditions.js");
    const trace = [
      {
        stepNumber: 0,
        thought: "停机原因是设备老化",
        toolCalls: [
          { id: "tc1", toolName: "nexus_advise", args: {}, result: {}, durationMs: 0 },
        ],
        finishReason: "tool-calls",
        usage: { totalTokens: 10 },
        durationMs: 0,
      },
    ];
    const reminders = collectEveryStepReminders(trace as never);
    expect(reminders.length).toBeGreaterThan(0);
    expect(reminders.some((r) => r.includes("停机"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A2: destructive governance 阻断
// ─────────────────────────────────────────────────────────────────────────────

describe("S6 destructive governance 阻断（A2）", () => {
  it("destructive 工具默认被阻断（无 NEXUS_ALLOW_DESTRUCTIVE）", () => {
    delete process.env.NEXUS_ALLOW_DESTRUCTIVE;
    const chain = buildNexusGovernance();
    const r = chain.preToolUse("mcp.mes.force_stop_line", {}, "destructive");
    expect(r.allow).toBe(false);
    if (!r.allow) {
      expect(r.ruleId).toBe("block_destructive_by_default");
      expect(r.reason).toContain("destructive");
    }
  });

  it("NEXUS_ALLOW_DESTRUCTIVE=1 时 destructive 放行（HITL 仍兜底）", () => {
    process.env.NEXUS_ALLOW_DESTRUCTIVE = "1";
    try {
      const chain = buildNexusGovernance();
      const r = chain.preToolUse("mcp.mes.force_stop_line", {}, "destructive");
      expect(r.allow).toBe(true);
    } finally {
      delete process.env.NEXUS_ALLOW_DESTRUCTIVE;
    }
  });

  it("safe 工具不受 destructive 规则影响", () => {
    delete process.env.NEXUS_ALLOW_DESTRUCTIVE;
    const chain = buildNexusGovernance();
    expect(chain.preToolUse("oee.realtime", {}, "safe").allow).toBe(true);
  });

  it("write 工具不受 destructive 规则影响（走 HITL 而非 governance 阻断）", () => {
    delete process.env.NEXUS_ALLOW_DESTRUCTIVE;
    const chain = buildNexusGovernance();
    expect(chain.preToolUse("mcp.mes.update_schedule", { orderIds: ["o1"] }, "write").allow).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A3: prepareStep 动态裁工具
// ─────────────────────────────────────────────────────────────────────────────

describe("S6 prepareStep 动态裁工具（A3）", () => {
  it("boot 装配后 prepareStep 可构造（allToolNames 非空）", async () => {
    const runtime = await bootNexusOps({ llm: mockLlm() });
    const names = runtime.toolRegistry.listByTiers(["core", "domain", "custom"]).map((t) => t.name);
    const prepareStep = buildNexusPrepareStep(names);
    expect(typeof prepareStep).toBe("function");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B2: postToolUse 一致性校验规则
// ─────────────────────────────────────────────────────────────────────────────

describe("S6 postToolUse 一致性校验规则（B2）", () => {
  it("buildNexusPostToolUseChain 产出 PostToolUseChain", () => {
    const chain = buildNexusPostToolUseChain();
    expect(typeof chain.postToolUse).toBe("function");
  });

  it("inferred 证据首次出现 → 低强度 warn（inferred 总是 strength<0.5）", () => {
    const chain = buildNexusPostToolUseChain();
    const inferred = {
      data: {}, freshness: "realtime", capturedAt: "2026-01-01T00:00:00Z",
      confidence: "inferred", source: { system: "llm", provenance: "x" },
    };
    const r = chain.postToolUse("oee.realtime", {}, inferred);
    // realtime(1.0)×inferred(0.4)=0.4 < 0.5 → 低强度 warn 触发
    // inferred-repeat 首次未达 2 次阈值，不触发
    expect(r.warns.some((w) => !w.pass && w.reason.includes("强度"))).toBe(true);
    expect(r.warns.some((w) => !w.pass && w.reason.includes("inferred") && w.reason.includes("交叉验证"))).toBe(false);
    expect(r.block).toBeUndefined();
  });

  it("inferred 证据第二次出现 → 低强度 warn + inferred 重复 warn", () => {
    const chain = buildNexusPostToolUseChain();
    const inferred = {
      data: {}, freshness: "realtime", capturedAt: "2026-01-01T00:00:00Z",
      confidence: "inferred", source: { system: "llm", provenance: "x" },
    };
    chain.postToolUse("oee.realtime", {}, inferred); // 第 1 次
    const r = chain.postToolUse("oee.realtime", {}, inferred); // 第 2 次
    // 两条 warn 都应触发：低强度 + inferred 重复
    expect(r.warns.some((w) => !w.pass && w.reason.includes("交叉验证"))).toBe(true);
    expect(r.warns.some((w) => !w.pass && w.reason.includes("强度"))).toBe(true);
  });

  it("低强度证据（historical + inferred）→ warn", () => {
    const chain = buildNexusPostToolUseChain();
    const lowStrength = {
      data: {}, freshness: "historical", capturedAt: "2020-01-01T00:00:00Z",
      confidence: "inferred", source: { system: "old", provenance: "x" },
    };
    const r = chain.postToolUse("oee.history", {}, lowStrength);
    // historical(0.4) × inferred(0.4) = 0.16 < 0.5 → warn
    expect(r.warns.some((w) => !w.pass && w.reason.includes("强度"))).toBe(true);
  });

  it("measured realtime 证据 → 无 warn", () => {
    const chain = buildNexusPostToolUseChain();
    const strong = {
      data: {}, freshness: "realtime", capturedAt: "2026-06-20T00:00:00Z",
      confidence: "measured", source: { system: "MES", provenance: "/oee" },
    };
    const r = chain.postToolUse("oee.realtime", {}, strong);
    expect(r.warns.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C2: review pass callSite 注册
// ─────────────────────────────────────────────────────────────────────────────

describe("S6 review pass callSite 注册（C2）", () => {
  it("nexus_review 已在 CALL_SITES 枚举", async () => {
    const { CALL_SITES } = await import("../../src/llm/call-sites.js");
    expect(CALL_SITES).toContain("nexus_review");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D3/D5: SkillRegistry 与 boot 挂接
// ─────────────────────────────────────────────────────────────────────────────

describe("S6 SkillRegistry 与 boot 挂接（D3/D5）", () => {
  it("SkillRegistry 可独立构造（空状态）", () => {
    const reg = new SkillRegistry();
    expect(reg.promotableCandidates()).toEqual([]);
    expect(reg.activeSkills()).toEqual([]);
  });

  it("buildNexusSkills 接受可选 registry 参数（不抛错）", () => {
    const reg = new SkillRegistry();
    const skills = buildNexusSkills(reg);
    expect(skills.length).toBeGreaterThanOrEqual(2); // 至少 2 个手写 skill
    expect(skills.some((s) => s.name === "skill.oee_diagnose")).toBe(true);
  });

  it("boot 装配后 skill.* 含手写 + 无 active registry skill（默认）", async () => {
    const runtime = await bootNexusOps({ llm: mockLlm() });
    const names = runtime.toolRegistry.list().map((t) => t.name);
    expect(names.includes("skill.oee_diagnose")).toBe(true);
    expect(names.includes("skill.downtime_root_cause")).toBe(true);
  });
});
