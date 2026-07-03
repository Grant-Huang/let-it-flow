/**
 * Phase 4 E2E 验收测试。
 *
 * 验收标准（核心 E2E）：
 *   - 场景 A（DMAIC 不漂移）：DMAIC 方法论指导注入，prepare-step 正确识别 dmaic topic
 *   - 场景 B（开放问题 QS16949）：方法论指导注入 qs16949_audit，prepare-step 正确识别
 *   - 场景 C（质量评估）：quality-evaluator 产出 ComponentLayout 评估报告
 *   - ToolResolver 工具可调用（nexus_tool_resolver）
 *   - 方法论主题不漂移（inferMethodologyTopic 正确分类）
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootNexusOps } from "../../../../apps/nexusops/server/boot.js";
import { createOrchestrator } from "../../../../src/orchestrator/factory.js";
import { createToolResolver } from "../../../../src/orchestrator/resolver-factory.js";
import { createToolResolverTool } from "../../../../apps/nexusops/tools/tool-resolver-tool.js";
import { createQualityEvaluatorTool } from "../../../../apps/nexusops/tools/quality-evaluator-tool.js";
import { createQualityEvaluatorSkill, evaluateAnalysisQuality, assessmentToLayout } from "../../../../apps/nexusops/skills/quality-evaluator.js";
import { ToolRegistry } from "../../../../src/tools/registry.js";
import { buildNexusTools } from "../../../../apps/nexusops/tools/index.js";
import { renderReport } from "../../../../apps/nexusops/skills/report-renderer.js";
import { MockOrchestrator } from "../../../../src/orchestrator/mock-orchestrator.js";
import type { LlmService } from "../../../../src/services/llm-service.js";
import type { BizContext } from "../../../../src/orchestrator/types.js";

let dataDir: string;
let vaultPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "nexus-p4-"));
  vaultPath = join(dataDir, "vault");
  mkdirSync(join(vaultPath, "01-现场状态"), { recursive: true });
  writeFileSync(
    join(vaultPath, "01-现场状态", "OEE计算口径.md"),
    "---\ntitle: OEE 计算口径\ntags: [oee, sop]\n---\nOEE = 可用率 × 表现率 × 质量率。\n",
    "utf8",
  );
  for (const k of ["LIF_DATA_DIR", "OBSIDIAN_VAULT_PATH", "NEXUS_MCP_SERVERS", "NEXUS_MOCK_TOOLS", "NEXUS_MOCK_ACTIONS"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.LIF_DATA_DIR = dataDir;
  process.env.OBSIDIAN_VAULT_PATH = vaultPath;
  delete process.env.NEXUS_MCP_SERVERS;
  // 测试默认在全开 mock 模式跑（避免 .env 的 NEXUS_MOCK_TOOLS=0 污染测试）
  delete process.env.NEXUS_MOCK_TOOLS;
  delete process.env.NEXUS_MOCK_ACTIONS;
});

function mockLlm(): LlmService {
  return {
    model: () => ({ specificationVersion: "v1" }) as never,
    compatModeFor: () => false,
    subscribeConfigChanges: () => {},
  } as unknown as LlmService;
}

// ─────────────────────────────────────────────────────────────────────────────
// 场景 A：DMAIC 方法论不漂移
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4 场景 A：DMAIC 方法论指导注入", () => {
  it("DMAIC 意图命中 dmaic 方法论（含 D-M-A-I-C 五阶段）", async () => {
    const orch = createOrchestrator({ dataDir: "data/relos-mock" });
    const ctx: BizContext = { line: "L01", scenarioId: "anomaly" };
    const m = await orch.getMethodology("dmaic", ctx);
    expect(m).not.toBeNull();
    expect(m!.topic).toBe("dmaic");
    expect(m!.source).toBe("mock");
    expect(m!.phases?.length).toBeGreaterThanOrEqual(5);
    const phaseIds = m!.phases!.map((p) => p.id);
    expect(phaseIds).toContain("D");
    expect(phaseIds).toContain("C");
  });

  it("DMAIC 方法论的 M 阶段含必取证项（process_capability）", async () => {
    const orch = createOrchestrator({ dataDir: "data/relos-mock" });
    const ctx: BizContext = { line: "L01", scenarioId: "anomaly" };
    const m = await orch.getMethodology("dmaic", ctx);
    // Measure（M）阶段应要求 process_capability / defect_rate 等
    const measurePhase = m!.phases!.find((p) => p.id === "M");
    expect(measurePhase).toBeDefined();
    expect(measurePhase!.requiredData?.length).toBeGreaterThan(0);
    const semantics = measurePhase!.requiredData!.map((d) => d.semantic);
    expect(semantics).toContain("process_capability");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 场景 B：开放问题 QS16949 内审评估
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4 场景 B：QS16949 开放问题方法论", () => {
  it("qs16949_audit 方法论存在且为符合性评估（非根因诊断）", async () => {
    const orch = createOrchestrator({ dataDir: "data/relos-mock" });
    const ctx: BizContext = { line: "L01", scenarioId: "normal" };
    const m = await orch.getMethodology("qs16949_audit", ctx);
    expect(m).not.toBeNull();
    expect(m!.topic).toBe("qs16949_audit");
    expect(m!.source).toBe("mock");
    // 符合性评估类：guidance 应提及"评估"或"符合"
    expect(m!.guidance).toMatch(/评估|符合|审核/);
  });

  it("qs16949_audit 方法论的 phases 含四大工具取证（fmea/cpk/spc/calibration）", async () => {
    const orch = createOrchestrator({ dataDir: "data/relos-mock" });
    const ctx: BizContext = { line: "L01", scenarioId: "normal" };
    const m = await orch.getMethodology("qs16949_audit", ctx);
    const evidencePhase = m!.phases!.find((p) => p.id === "evidence");
    expect(evidencePhase).toBeDefined();
    const semantics = evidencePhase!.requiredData!.map((d) => d.semantic);
    expect(semantics).toContain("fmea");
    expect(semantics).toContain("process_capability");
    expect(semantics).toContain("spc_samples");
    expect(semantics).toContain("calibration_status");
  });

  it("qs16949_audit 方法论不要求因果链（getCausalChain 返回 null 是正常的）", async () => {
    const orch = createOrchestrator({ dataDir: "data/relos-mock" });
    const ctx: BizContext = { line: "L01", scenarioId: "normal" };
    // normal 场景下因果链应为空（符合性评估类问题不需要根因）
    const chain = await orch.getCausalChain("", ctx);
    // normal 场景无异常 → null 或空链
    expect(chain === null || (chain && chain.chains.length === 0)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 场景 C：质量评估器
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4 场景 C：LLM 结果质量评估器", () => {
  it("启发式评估（无 LLM 模型）产出 5 维度评分", async () => {
    const assessment = await evaluateAnalysisQuality(
      "分析 L01 的 OEE 水平",
      [
        { step: 1, tool: "oee.realtime", action: "取实时 OEE", finding: "OEE=85%" },
        { step: 2, tool: "quality.five_why", action: "取因果链", finding: "根因：刀具磨损" },
      ],
      "结论：OEE 偏低，根因是刀具磨损。建议：更换刀具。",
    );
    expect(assessment.overall).toBeGreaterThan(0);
    expect(assessment.overall).toBeLessThanOrEqual(10);
    expect(assessment.dimensions.length).toBe(5);
    const names = assessment.dimensions.map((d) => d.name);
    expect(names).toContain("主题一致性");
    expect(names).toContain("证据充分性");
    expect(names).toContain("根因合理性");
    expect(names).toContain("建议可执行性");
    expect(names).toContain("方法合规性");
  });

  it("评估结果转为 ComponentLayout 并渲染为 HTML", () => {
    const assessment = {
      overall: 7.5,
      dimensions: [
        { name: "主题一致性", score: 8.5, reason: "DMAIC 主题贯穿" },
        { name: "证据充分性", score: 7, reason: "5 个工具调用" },
      ],
      summary: "总体良好",
      improvements: ["建议增加交叉验证"],
    };
    const layout = assessmentToLayout(assessment);
    expect(layout.reportType).toBe("quality_assessment");
    expect(layout.components.length).toBeGreaterThan(0);
    const html = renderReport(layout);
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("7.5");
    expect(html).toContain("主题一致性");
    expect(html).toContain("总体良好");
    expect(html).toContain("建议增加交叉验证");
  });

  it("quality_evaluate skill 可执行并产出 HTML 评估报告", async () => {
    const skill = createQualityEvaluatorSkill();
    const toolRegistry = new ToolRegistry();
    for (const c of buildNexusTools()) {
      if (!toolRegistry.has(c.name)) toolRegistry.register(c);
    }
    if (!toolRegistry.has(skill.name)) toolRegistry.register(skill);

    const ctx = {
      taskId: "t", runId: "r", nodeId: "n", intent: "",
      args: {
        intent: "分析 L01 的 6Sigma 水平",
        finalText: "结论：当前 σ=2.5，根因是工艺参数漂移。建议：回调参数。",
        trace: [
          { step: 1, tool: "oee.realtime", action: "取 OEE", finding: "OEE=70%" },
          { step: 2, tool: "quality.cp_cpk", action: "取 Cpk", finding: "Cpk=0.8" },
        ],
      },
      emit: async () => ({} as never),
      requireConfirmation: async () => ({ approved: true }),
      resolveRef: () => undefined,
      resolveTool: (name: string) => toolRegistry.get(name),
    } as unknown as Parameters<import("../../../../src/tools/base.js").FlowConnector["execute"]>[1];

    const gen = skill.execute(ctx.args, ctx);
    let final: { output: unknown } | undefined;
    while (true) {
      const r = await gen.next();
      if (r.done) { final = r.value as { output: unknown }; break; }
    }
    const output = final!.output as { data: { html: string; _isHtmlReport: boolean; assessment: { overall: number } } };
    expect(output.data._isHtmlReport).toBe(true);
    expect(output.data.html).toContain("<!DOCTYPE html>");
    expect(output.data.html).toContain("分析质量评估");
    expect(output.data.assessment.overall).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ToolResolver 工具（nexus_tool_resolver）
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4 ToolResolver 工具", () => {
  it("nexus_tool_resolver 索引命中返回工具名", async () => {
    const indexPath = join(mkdtempSync(join(tmpdir(), "idx-")), "tool-semantic-index.json");
    writeFileSync(
      indexPath,
      JSON.stringify({
        version: "1.0",
        entries: [{ semantic: "process_capability", toolName: "quality.cp_cpk", primary: true }],
      }),
    );
    const reg = new ToolRegistry();
    const resolver = createToolResolver({ registry: reg, indexPath });
    const tool = createToolResolverTool(resolver);

    const gen = tool.execute({ semantic: "process_capability" }, {
      taskId: "t", runId: "r", nodeId: "n", intent: "",
      args: { semantic: "process_capability" },
      emit: async () => ({} as never),
      requireConfirmation: async () => ({ approved: true }),
      resolveRef: () => undefined,
      resolveTool: () => undefined,
    } as never);

    let final: { output: unknown } | undefined;
    while (true) {
      const r = await gen.next();
      if (r.done) { final = r.value as { output: unknown }; break; }
    }
    const envelope = final!.output as { data: { resolved: { toolName: string; source: string } | null } };
    expect(envelope.data.resolved).not.toBeNull();
    expect(envelope.data.resolved!.toolName).toBe("quality.cp_cpk");
    expect(envelope.data.resolved!.source).toBe("index");
  });

  it("nexus_tool_resolver 未命中返回 resolved=null", async () => {
    const indexPath = join(mkdtempSync(join(tmpdir(), "idx-")), "empty.json");
    writeFileSync(indexPath, JSON.stringify({ version: "1.0", entries: [] }));
    const reg = new ToolRegistry();
    const resolver = createToolResolver({ registry: reg, indexPath });
    const tool = createToolResolverTool(resolver);

    const gen = tool.execute({ semantic: "nonexistent" }, {
      taskId: "t", runId: "r", nodeId: "n", intent: "",
      args: { semantic: "nonexistent" },
      emit: async () => ({} as never),
      requireConfirmation: async () => ({ approved: true }),
      resolveRef: () => undefined,
      resolveTool: () => undefined,
    } as never);

    let final: { output: unknown } | undefined;
    while (true) {
      const r = await gen.next();
      if (r.done) { final = r.value as { output: unknown }; break; }
    }
    const envelope = final!.output as { data: { resolved: null } };
    expect(envelope.data.resolved).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// boot 装配完整性（Phase 4 全链路）
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4 boot 装配完整性", () => {
  it("boot 后 nexus_tool_resolver 工具已注册", async () => {
    const runtime = await bootNexusOps({ llm: mockLlm() });
    const tool = runtime.toolRegistry.get("nexus_tool_resolver");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("nexus_tool_resolver");
  });

  it("boot 后 skill.quality_evaluate 已注册", async () => {
    const runtime = await bootNexusOps({ llm: mockLlm() });
    const skill = runtime.toolRegistry.get("skill.quality_evaluate");
    expect(skill).toBeDefined();
  });

  it("boot 后 orchestrator.getMethodology('qs16949_audit') 可用", async () => {
    const runtime = await bootNexusOps({ llm: mockLlm() });
    const ctx: BizContext = { line: "L01", scenarioId: "normal" };
    const m = await runtime.orchestrator.getMethodology("qs16949_audit", ctx);
    expect(m).not.toBeNull();
    expect(m!.topic).toBe("qs16949_audit");
  });

  it("boot 后 nexus_quality_evaluate 工具已注册（Phase 4.7）", async () => {
    const runtime = await bootNexusOps({ llm: mockLlm() });
    const tool = runtime.toolRegistry.get("nexus_quality_evaluate");
    expect(tool).toBeDefined();
    expect(tool!.name).toBe("nexus_quality_evaluate");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// nexus_quality_evaluate 工具直接调用（Phase 4.7）
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4.7 nexus_quality_evaluate 工具", () => {
  it("调用 nexus_quality_evaluate 产出 HTML 评估报告（启发式降级）", async () => {
    const tool = createQualityEvaluatorTool(); // 无 model → 启发式
    const gen = tool.execute(
      {
        intent: "分析 L01 的 OEE 水平",
        finalText: "结论：OEE 偏低，根因是刀具磨损。建议：更换刀具。",
        trace: [
          { step: 1, tool: "oee.realtime", action: "取 OEE", finding: "OEE=70%" },
          { step: 2, tool: "quality.cp_cpk", action: "取 Cpk", finding: "Cpk=0.8" },
        ],
      },
      {
        taskId: "t", runId: "r", nodeId: "n", intent: "",
        args: {},
        emit: async () => ({} as never),
        requireConfirmation: async () => ({ approved: true }),
        resolveRef: () => undefined,
        resolveTool: () => undefined,
      } as never,
    );

    let final: { output: unknown } | undefined;
    while (true) {
      const r = await gen.next();
      if (r.done) { final = r.value as { output: unknown }; break; }
    }
    const out = final!.output as {
      data: { html: string; _isHtmlReport: boolean; assessment: { overall: number; dimensions: { name: string }[] } };
    };
    expect(out.data._isHtmlReport).toBe(true);
    expect(out.data.html).toContain("<!DOCTYPE html>");
    expect(out.data.html).toContain("分析质量评估");
    expect(out.data.assessment.overall).toBeGreaterThan(0);
    expect(out.data.assessment.dimensions.length).toBe(5);
  });

  it("nexus_quality_evaluate 缺 finalText 时仍能产出降级评分（不抛错）", async () => {
    const tool = createQualityEvaluatorTool();
    const gen = tool.execute(
      { intent: "空分析" },
      {
        taskId: "t", runId: "r", nodeId: "n", intent: "",
        args: {},
        emit: async () => ({} as never),
        requireConfirmation: async () => ({ approved: true }),
        resolveRef: () => undefined,
        resolveTool: () => undefined,
      } as never,
    );
    let final: { output: unknown } | undefined;
    while (true) {
      const r = await gen.next();
      if (r.done) { final = r.value as { output: unknown }; break; }
    }
    const out = final!.output as { data: { assessment: { overall: number } } };
    expect(out.data.assessment.overall).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// calibration_status 语义标注（Phase 4.5）
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 4.5 calibration_status 语义解析", () => {
  it("quality.calibration 工具标了 calibration_status 语义", async () => {
    const reg = new ToolRegistry();
    for (const c of buildNexusTools()) {
      if (!reg.has(c.name)) reg.register(c);
    }
    const calib = reg.get("quality.calibration");
    expect(calib).toBeDefined();
    expect(calib!.semanticTags).toContain("calibration_status");
  });

  it("ToolResolver 按 calibration_status 语义命中 quality.calibration", async () => {
    const reg = new ToolRegistry();
    for (const c of buildNexusTools()) {
      if (!reg.has(c.name)) reg.register(c);
    }
    // 用 registry 派生索引（syncToolIndex 后 IndexToolResolver 能查到）
    const resolver = createToolResolver({ registry: reg });
    const ctx: BizContext = { line: "L01", scenarioId: "normal" };
    const resolved = await resolver.resolve({ semantic: "calibration_status" }, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.toolName).toBe("quality.calibration");
  });
});
