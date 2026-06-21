import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../src/api/app.js";
import { TaskRegistry, type TaskRuntime } from "../../src/tasks/registry.js";
import { createDefaultToolRegistry } from "../../src/executor/default-tools.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { registerBuiltinTools } from "../../src/tools/index.js";
import { LlmService } from "../../src/services/llm-service.js";
import { plan, type PlannerConfig } from "../../src/planner/planner.js";
import type { ConsumerTemplate } from "../../src/planner/consumer-template.js";
import type { WorkflowDAG } from "../../src/planner/dag-schema.js";
import type { FlowConnector, ToolTrigger, ToolResult } from "../../src/tools/base.js";
import type { ToolEvent } from "../../src/core/stream-events.js";
import type { ToolManifest } from "../../src/tools/registry.js";

/**
 * 内联最小 ConsumerTemplate（替代已废弃的 podcastTemplate）。
 * 仅用于验证 planner 模板兜底机制，不耦合 podcast 业务。
 * 结构复刻原 podcast 文本子链：fetch → rewrite(llm_node) → deliver，
 * 保留断言对 fetch/rewrite/deliver 三节点的验证语义。
 */
const fallbackTemplate: ConsumerTemplate = {
  templateId: "research",
  description: "研究主题并交付（最小兜底模板，复刻 fetch→rewrite→deliver 三节点）",
  matchPattern: /研究|总结|report|做成|做一期|分析|播客/,
  match: (intent: string) => /研究|总结|report|做成|做一期|分析|播客/.test(intent),
  async extractParams(): Promise<unknown> {
    return { topic: "test", style: "summary", language: "zh" };
  },
  build(_params: unknown, _fullPipeline: boolean): WorkflowDAG {
    const confirmed = { maxTokens: 4000, strip: true, summarize: false };
    return {
      schemaVersion: "1.0",
      nodes: [
        {
          id: "fetch",
          toolName: "core.web_fetch",
          params: { urls: ["https://example.com"] },
          inputRefs: {},
          dependsOn: [],
          requireConfirmation: false,
          onNodeError: "skip",
          contentPipeline: confirmed,
        },
        {
          id: "rewrite",
          toolName: "core.llm_node",
          params: { prompt: "改写素材", style: "summary", role: "writer" },
          inputRefs: { "$.tasks.fetch.output[0].content": "context" },
          dependsOn: ["fetch"],
          requireConfirmation: false,
          onNodeError: "skip",
          contentPipeline: { maxTokens: 6000, strip: true, summarize: false },
        },
        {
          id: "deliver",
          toolName: "core.deliver",
          params: { artifactType: "research_report" },
          inputRefs: { "$.tasks.rewrite.output": "items" },
          dependsOn: ["rewrite"],
          requireConfirmation: false,
          onNodeError: "skip",
          contentPipeline: confirmed,
        },
      ],
      onNodeError: "skip",
      retryAttempts: 0,
    };
  },
};

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lif-contract-"));
  process.env.LIF_DATA_DIR = tmpRoot;
});

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

/** 注册全部 core 工具的 registry（无 domain，便于纯 core 测试）。 */
function coreRegistry(): ToolRegistry {
  const reg = createDefaultToolRegistry();
  const llm = new LlmService({ apiKey: "sk-test-fake" });
  registerBuiltinTools(reg, { llm });
  return reg;
}

function json<T>(res: Response): Promise<{ status: string; data: T }> {
  return res.json() as Promise<{ status: string; data: T }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// 工具契约字段完整性（13 个工具）
// ─────────────────────────────────────────────────────────────────────────────
describe("P7 工具契约：whenToUse/outputSchema/outputExample 完整性", () => {
  it("全部 core 工具契约字段非空且结构合法", () => {
    const reg = coreRegistry();
    for (const tool of reg.list()) {
      expect(tool.whenToUse, `${tool.name} 缺 whenToUse`).toBeDefined();
      expect(Array.isArray(tool.whenToUse.triggers), `${tool.name} triggers 非数组`).toBe(true);
      expect(tool.whenToUse.triggers.length, `${tool.name} triggers 为空`).toBeGreaterThan(0);
      expect(Array.isArray(tool.whenToUse.notFor), `${tool.name} notFor 非数组`).toBe(true);
      expect(tool.outputSchema, `${tool.name} 缺 outputSchema`).toBeDefined();
      expect(tool.outputExample, `${tool.name} 缺 outputExample`).toBeDefined();
    }
  });

  it("web_search 契约内容符合 04 规范", () => {
    const reg = coreRegistry();
    const ws = reg.get("core.web_search")!;
    expect(ws.whenToUse.triggers).toContain("实时客观事实");
    expect(ws.whenToUse.notFor).toContain("已有 URL 的网页（走 web_fetch）");
    expect(ws.outputSchema).toHaveProperty("type", "object");
    expect(ws.outputSchema).toHaveProperty("properties.results");
    expect(ws.outputExample).toHaveProperty("results");
  });

  it("web_fetch 契约含 docs 数组结构", () => {
    const reg = coreRegistry();
    const wf = reg.get("core.web_fetch")!;
    expect(wf.whenToUse.triggers).toContain("已有 URL 的网页");
    expect(wf.outputSchema).toHaveProperty("properties.docs");
    expect(wf.outputExample.docs).toBeInstanceOf(Array);
  });

  it("llm_node 契约含 text 输出", () => {
    const reg = coreRegistry();
    const llm = reg.get("core.llm_node")!;
    expect(llm.whenToUse.triggers).toContain("播客文稿生成");
    expect(llm.outputExample).toHaveProperty("text");
  });

  it("deliver 契约标记为末端交付", () => {
    const reg = coreRegistry();
    const d = reg.get("core.deliver")!;
    expect(d.whenToUse.triggers).toContain("流程末端交付产物");
    expect(d.outputSchema).toHaveProperty("properties.content");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// forPlanner() 清单序列化
// ─────────────────────────────────────────────────────────────────────────────
describe("P7 ToolRegistry.forPlanner() 清单序列化", () => {
  it("返回纯契约（剥离 execute），字段完整", () => {
    const reg = coreRegistry();
    const manifests = reg.forPlanner();
    expect(manifests.length).toBe(4); // 4 个 core 工具
    for (const m of manifests) {
      expect(m).toHaveProperty("name");
      expect(m).toHaveProperty("tier");
      expect(m).toHaveProperty("description");
      expect(m).toHaveProperty("whenToUse");
      expect(m).toHaveProperty("inputSchema");
      expect(m).toHaveProperty("outputSchema");
      expect(m).toHaveProperty("outputExample");
      // 不含 execute（纯 metadata）
      expect(m).not.toHaveProperty("execute");
    }
  });

  it("?tier 过滤正确", () => {
    const reg = coreRegistry();
    const core = reg.forPlanner(["core"]);
    expect(core.every((m) => m.tier === "core")).toBe(true);
    expect(core.length).toBe(4);

    // domain 过滤（core-only registry 应返回空）
    const domain = reg.forPlanner(["domain"]);
    expect(domain.length).toBe(0);

    // 不传 tier 返回全部
    const all = reg.forPlanner();
    expect(all.length).toBe(4);
  });

  it("forPlanner 返回值可 JSON 序列化（喂给 LLM 不丢字段）", () => {
    const reg = coreRegistry();
    const manifests = reg.forPlanner();
    const serialized = JSON.stringify(manifests);
    const parsed = JSON.parse(serialized) as ToolManifest[];
    expect(parsed.length).toBe(4);
    expect(parsed[0]!.whenToUse.triggers.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// planner LLM 选工具路径 + 模板兜底
// ─────────────────────────────────────────────────────────────────────────────
describe("P7 planner LLM 选工具路径", () => {
  /** mock LLM：返回空壳模型（generateText 调真 OpenAI 会失败 → 回退模板路由）。 */
  function mockLlm(): LlmService {
    return {
      model: () => ({ specificationVersion: "v1" }) as never,
      modelById: () => ({ specificationVersion: "v1" }) as never,
      // P8.5：新方法 mock（registry 为空时回退全局）
      compatMode: false,
      compatModeFor: () => false,
      resolveEndpoint: () => undefined,
    } as unknown as LlmService;
  }

  it("LLM 不可用时回退模板路由（向后兼容）", async () => {
    // mock LLM 调真 generateText 会失败 → LLM 路径返回 null → 回退消费模板
    const reg = coreRegistry();
    const config: PlannerConfig = {
      llm: mockLlm(),
      registry: reg,
      maxRetries: 1,
      useLlmRouter: true,
      consumerTemplates: [fallbackTemplate],
    };
    const outcome = await plan("把 https://example.com 做成研究报告", config);
    expect(outcome.kind).toBe("proceed");
    if (outcome.kind === "proceed") {
      // 兜底走 fallback 模板，应含 fetch + rewrite + deliver（三节点文本子链）
      const ids = outcome.dag.nodes.map((n) => n.id);
      expect(ids).toContain("fetch");
      expect(ids).toContain("rewrite");
      expect(ids).toContain("deliver");
    }
  });

  it("useLlmRouter=false 直接走模板路由（跳过 LLM）", async () => {
    const reg = coreRegistry();
    const config: PlannerConfig = {
      llm: mockLlm(),
      registry: reg,
      maxRetries: 1,
      useLlmRouter: false,
      consumerTemplates: [fallbackTemplate],
    };
    const outcome = await plan("把 https://example.com 做成研究报告", config);
    expect(outcome.kind).toBe("proceed");
    if (outcome.kind === "proceed") {
      const ids = outcome.dag.nodes.map((n) => n.id);
      expect(ids).toContain("fetch");
    }
  });

  // LLM 选工具成功路径测试见 test-p7-llm-router.ts（需 vi.mock，单独成文件）
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/tools 端点
// ─────────────────────────────────────────────────────────────────────────────
describe("P7 GET /api/tools 端点", () => {
  function createRuntimeApp() {
    const toolRegistry = createDefaultToolRegistry();
    const llm = new LlmService({ apiKey: "sk-test-fake" });
    registerBuiltinTools(toolRegistry, { llm });
    const runtime: TaskRuntime = { llm, toolRegistry };
    return createApp(new TaskRegistry(undefined, runtime));
  }

  it("返回全部工具清单（4 个 core）", async () => {
    const app = createRuntimeApp();
    const res = await app.request("/api/tools");
    expect(res.status).toBe(200);
    const body = await json<{ tools: ToolManifest[]; count: number }>(res);
    expect(body.status).toBe("success");
    expect(body.data.count).toBe(4);
    expect(body.data.tools[0]).toHaveProperty("whenToUse");
    expect(body.data.tools[0]).not.toHaveProperty("execute");
  });

  it("?tier=core 过滤只返回 core 层", async () => {
    const app = createRuntimeApp();
    const res = await app.request("/api/tools?tier=core");
    expect(res.status).toBe(200);
    const body = await json<{ tools: ToolManifest[] }>(res);
    expect(body.data.tools.every((t) => t.tier === "core")).toBe(true);
    expect(body.data.tools.length).toBe(4);
  });

  it("?tier=domain 过滤返回空（未注册 domain 工具）", async () => {
    const app = createRuntimeApp();
    const res = await app.request("/api/tools?tier=domain");
    expect(res.status).toBe(200);
    const body = await json<{ tools: ToolManifest[] }>(res);
    expect(body.data.tools.length).toBe(0);
  });

  it("非法 tier 返回 400", async () => {
    const app = createRuntimeApp();
    const res = await app.request("/api/tools?tier=invalid");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 工具契约类型导出
// ─────────────────────────────────────────────────────────────────────────────
describe("P7 工具契约类型导出", () => {
  it("ToolTrigger / ToolManifest 类型可被消费方使用", () => {
    const trigger: ToolTrigger = { triggers: ["a"], notFor: ["b"] };
    const manifest: ToolManifest = {
      name: "x",
      tier: "core",
      description: "",
      whenToUse: trigger,
      inputSchema: {},
      outputSchema: {},
      outputExample: {},
    };
    expect(manifest.whenToUse.triggers).toEqual(["a"]);
  });

  it("实现 FlowConnector 必须含契约字段（编译期保证）", () => {
    // 这是类型层面的保证：缺字段无法通过 tsc。
    // 这里构造一个最小合法工具验证运行期字段可访问。
    const tool: FlowConnector = {
      name: "test",
      tier: "custom",
      description: "",
      inputSchema: {},
      whenToUse: { triggers: [], notFor: [] },
      outputSchema: {},
      outputExample: {},
      async *execute(): AsyncGenerator<ToolEvent, ToolResult> {
        return { output: {} };
      },
    };
    expect(tool.whenToUse.triggers).toEqual([]);
  });
});
