import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import {
  routeTemplate,
  extractUrls,
} from "../../src/planner/templates.js";
import {
  isPodcastIntent,
  buildPodcastDag,
  PodcastParams,
  podcastTemplate,
} from "../../examples/podcast-generator/template.js";
import { guardrailCheck } from "../../src/planner/guardrail.js";
import { validateDag } from "../../src/planner/validator.js";
import { plan } from "../../src/planner/planner.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { FlowConnector, ToolResult } from "../../src/tools/base.js";
import type { ToolEvent } from "../../src/core/stream-events.js";
import { WorkflowDAG } from "../../src/planner/dag-schema.js";

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lif-p4-"));
  process.env.LIF_DATA_DIR = tmpRoot;
});

// ─────────────────────────────────────────────────────────────────────────────
// helpers：注册伪版 core.* 工具（让 validateDag 通过）
// ─────────────────────────────────────────────────────────────────────────────

function fakeTool(name: string): FlowConnector<unknown> {
  return {
    name,
    tier: "core",
    description: `fake ${name}`,
    inputSchema: {},
    whenToUse: { triggers: [], notFor: [] },
    outputSchema: { type: "object" },
    outputExample: {},
    async *execute(params): AsyncGenerator<ToolEvent, ToolResult> {
      return { output: params };
    },
  };
}

function registryWithCoreTools(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const name of ["core.web_search", "core.web_fetch", "core.llm_node", "core.deliver"]) {
    reg.register(fakeTool(name));
  }
  return reg;
}

// ─────────────────────────────────────────────────────────────────────────────
// 模板路由
// ─────────────────────────────────────────────────────────────────────────────
describe("P4 template routing", () => {
  it("命中 podcast 模板：含「播客」关键词", () => {
    // podcast 路由由消费模板 podcastTemplate.match() 负责（内核 routeTemplate 不识别业务模板）
    expect(podcastTemplate.match("把 https://example.com/a 做成播客", new ToolRegistry())).toBe(true);
    expect(isPodcastIntent("做一期 podcast")).toBe(true);
  });

  it("命中 research 模板", () => {
    expect(routeTemplate("分析一下新能源行业")).toBe("research");
  });

  it("命中 summary 模板", () => {
    expect(routeTemplate("总结这篇文章")).toBe("summary");
  });

  it("未命中返回 null", () => {
    expect(routeTemplate("帮点杯咖啡")).toBeNull();
  });

  it("extractUrls 从意图抽取 URL", () => {
    expect(extractUrls("把 https://a.com/x 和 https://b.com/y 做成播客")).toEqual([
      "https://a.com/x",
      "https://b.com/y",
    ]);
    expect(extractUrls("做一期关于 AI 的播客")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 模板 DAG 构建
// ─────────────────────────────────────────────────────────────────────────────
describe("P4 buildPodcastDag", () => {
  it("url 路径：fetch(requireConfirmation) → rewrite(requireConfirmation) → deliver", () => {
    const params = PodcastParams.parse({
      sourceMode: "url",
      urls: ["https://example.com/a"],
      style: "dialogue",
      language: "zh",
    });
    const dag = buildPodcastDag(params);
    const ids = dag.nodes.map((n) => n.id);
    expect(ids).toEqual(["fetch", "rewrite", "deliver"]);
    // HITL：fetch 与 rewrite 都要确认
    expect(dag.nodes.find((n) => n.id === "fetch")?.requireConfirmation).toBe(true);
    expect(dag.nodes.find((n) => n.id === "rewrite")?.requireConfirmation).toBe(true);
    expect(dag.nodes.find((n) => n.id === "deliver")?.requireConfirmation).toBe(false);
  });

  it("topic 路径：search → fetch → rewrite → deliver（四节点）", () => {
    const dag = buildPodcastDag(
      PodcastParams.parse({ sourceMode: "topic", topic: "AI 趋势", style: "narration" }),
    );
    const ids = dag.nodes.map((n) => n.id);
    expect(ids).toEqual(["search", "fetch", "rewrite", "deliver"]);
    expect(dag.nodes.find((n) => n.id === "fetch")?.dependsOn).toEqual(["search"]);
  });

  it("rewrite 节点 style 参数随 PodcastParams.style 变化", () => {
    for (const style of ["dialogue", "narration", "summary"] as const) {
      const dag = buildPodcastDag(
        PodcastParams.parse({ sourceMode: "url", urls: ["https://x.com"], style }),
      );
      const rewrite = dag.nodes.find((n) => n.id === "rewrite");
      expect(rewrite?.params.style).toBe(style);
    }
  });

  it("构建出的 DAG 经 validator 校验通过（工具已注册）", () => {
    const dag = buildPodcastDag(
      PodcastParams.parse({ sourceMode: "url", urls: ["https://x.com"], style: "summary" }),
    );
    const errors = validateDag(dag, registryWithCoreTools());
    expect(errors).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Guardrail
// ─────────────────────────────────────────────────────────────────────────────
describe("P4 guardrail", () => {
  it("proceed：命中 podcast + 有 URL", () => {
    // podcast 路由由消费模板负责；guardrailCheck 接收 consumerTemplates 查 findMissingParams
    const tid = podcastTemplate.match("把 https://example.com 做成播客", new ToolRegistry())
      ? "podcast"
      : routeTemplate("把 https://example.com 做成播客");
    const r = guardrailCheck("把 https://example.com 做成播客", tid, [podcastTemplate]);
    expect(r.decision).toBe("proceed");
    expect(r.templateId).toBe("podcast");
  });

  it("clarify：命中 podcast 但无主体（仅「做播客」）", () => {
    const tid = podcastTemplate.match("做播客", new ToolRegistry()) ? "podcast" : routeTemplate("做播客");
    const r = guardrailCheck("做播客", tid, [podcastTemplate]);
    expect(r.decision).toBe("clarify");
    expect(r.questions?.length).toBeGreaterThan(0);
  });

  it("reject：未命中 + 无可服务信号（「点咖啡」）", () => {
    const tid = routeTemplate("帮点杯咖啡");
    const r = guardrailCheck("帮点杯咖啡", tid, [podcastTemplate]);
    expect(r.decision).toBe("reject");
    expect(r.reason).toBeTruthy();
    expect(r.suggestRetry).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Validator
// ─────────────────────────────────────────────────────────────────────────────
describe("P4 validator", () => {
  it("检测环", () => {
    const dag: WorkflowDAG = {
      schemaVersion: "1.0",
      nodes: [
        { id: "a", toolName: "core.deliver", params: {}, inputRefs: {}, dependsOn: ["b"], requireConfirmation: false, onNodeError: "abort", contentPipeline: { maxTokens: 1000, strip: false, summarize: false } },
        { id: "b", toolName: "core.deliver", params: {}, inputRefs: {}, dependsOn: ["a"], requireConfirmation: false, onNodeError: "abort", contentPipeline: { maxTokens: 1000, strip: false, summarize: false } },
      ],
      onNodeError: "abort",
      retryAttempts: 0,
    };
    const errors = validateDag(dag, registryWithCoreTools());
    expect(errors.some((e) => e.includes("环") || e.includes("cycle") || e.includes("拓扑"))).toBe(true);
  });

  it("检测未注册工具", () => {
    const dag: WorkflowDAG = {
      schemaVersion: "1.0",
      nodes: [
        { id: "a", toolName: "core.unknown_tool", params: {}, inputRefs: {}, dependsOn: [], requireConfirmation: false, onNodeError: "abort", contentPipeline: { maxTokens: 1000, strip: false, summarize: false } },
      ],
      onNodeError: "abort",
      retryAttempts: 0,
    };
    const errors = validateDag(dag, registryWithCoreTools());
    expect(errors.some((e) => e.includes("未注册"))).toBe(true);
  });

  it("检测依赖不存在的节点", () => {
    const dag: WorkflowDAG = {
      schemaVersion: "1.0",
      nodes: [
        { id: "a", toolName: "core.deliver", params: {}, inputRefs: {}, dependsOn: ["ghost"], requireConfirmation: false, onNodeError: "abort", contentPipeline: { maxTokens: 1000, strip: false, summarize: false } },
      ],
      onNodeError: "abort",
      retryAttempts: 0,
    };
    const errors = validateDag(dag, registryWithCoreTools());
    expect(errors.some((e) => e.includes("ghost"))).toBe(true);
  });

  it("检测节点 id 重复", () => {
    const dag: WorkflowDAG = {
      schemaVersion: "1.0",
      nodes: [
        { id: "dup", toolName: "core.deliver", params: {}, inputRefs: {}, dependsOn: [], requireConfirmation: false, onNodeError: "abort", contentPipeline: { maxTokens: 1000, strip: false, summarize: false } },
        { id: "dup", toolName: "core.deliver", params: {}, inputRefs: {}, dependsOn: [], requireConfirmation: false, onNodeError: "abort", contentPipeline: { maxTokens: 1000, strip: false, summarize: false } },
      ],
      onNodeError: "abort",
      retryAttempts: 0,
    };
    const errors = validateDag(dag, registryWithCoreTools());
    expect(errors.some((e) => e.includes("重复"))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Planner（无 LLM key → generateText 抛错 → 启发式兜底，仍产出合法 DAG）
// ─────────────────────────────────────────────────────────────────────────────
describe("P4 planner (heuristic fallback)", () => {
  it("url 意图 → proceed，产出合法 podcast DAG", async () => {
    const outcome = await plan("把 https://example.com/a 做成播客", {
      llm: { model: () => ({ specificationVersion: "v1" }), compatModeFor: () => false, resolveEndpoint: () => undefined } as never,
      registry: registryWithCoreTools(),
      maxRetries: 1,
      consumerTemplates: [podcastTemplate],
    });
    expect(outcome.kind).toBe("proceed");
    if (outcome.kind === "proceed") {
      const ids = outcome.dag.nodes.map((n) => n.id);
      expect(ids).toEqual(["fetch", "rewrite", "deliver"]);
      expect(validateDag(outcome.dag, registryWithCoreTools())).toEqual([]);
    }
  });

  it("topic 意图 → proceed，产出 search→fetch→rewrite→deliver", async () => {
    const outcome = await plan("做一期关于 AI 趋势的播客", {
      llm: { model: () => ({ specificationVersion: "v1" }), compatModeFor: () => false, resolveEndpoint: () => undefined } as never,
      registry: registryWithCoreTools(),
      maxRetries: 1,
      consumerTemplates: [podcastTemplate],
    });
    expect(outcome.kind).toBe("proceed");
    if (outcome.kind === "proceed") {
      expect(outcome.dag.nodes.map((n) => n.id)).toEqual(["search", "fetch", "rewrite", "deliver"]);
    }
  });

  it("越界意图 → reject", async () => {
    const outcome = await plan("帮点杯咖啡", {
      llm: { model: () => ({ specificationVersion: "v1" }), compatModeFor: () => false, resolveEndpoint: () => undefined } as never,
      registry: registryWithCoreTools(),
      maxRetries: 1,
      consumerTemplates: [podcastTemplate],
    });
    expect(outcome.kind).toBe("reject");
    if (outcome.kind === "reject") {
      expect(outcome.reason).toBeTruthy();
    }
  });

  it("style 推断：含「总结」→ summary", async () => {
    const outcome = await plan("把 https://example.com 总结成播客", {
      llm: { model: () => ({ specificationVersion: "v1" }), compatModeFor: () => false, resolveEndpoint: () => undefined } as never,
      registry: registryWithCoreTools(),
      maxRetries: 1,
      consumerTemplates: [podcastTemplate],
    });
    expect(outcome.kind).toBe("proceed");
    if (outcome.kind === "proceed") {
      const rewrite = outcome.dag.nodes.find((n) => n.id === "rewrite");
      expect(rewrite?.params.style).toBe("summary");
    }
  });
});
