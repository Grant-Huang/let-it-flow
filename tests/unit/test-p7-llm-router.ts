import { describe, it, expect, beforeEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";

/**
 * P7 planner LLM 选工具路径（成功路径，需 mock generateText）。
 * 单独成文件：用 vi.mock("ai") 替换 generateText 返回可控 DAG，
 * 验证 planner 优先采用 LLM 产出的工具编排。
 */

// mock ai 模块的 generateText：返回预设的 WorkflowDAG
let mockOutput: unknown = null;
vi.mock("ai", () => ({
  generateText: vi.fn(async () => ({ output: mockOutput })),
  Output: {
    object: (opts: { schema: { parse: (v: unknown) => unknown } }) => ({
      parse: (v: unknown) => opts.schema.parse(v),
    }),
  },
  streamText: vi.fn(),
}));

// 必须在 mock 声明之后导入（vi.mock 会 hoist）
import { plan } from "../../src/planner/planner.js";
import { createDefaultToolRegistry } from "../../src/executor/default-tools.js";
import { registerBuiltinTools } from "../../src/tools/index.js";
import { LlmService } from "../../src/services/llm-service.js";
import { podcastTemplate } from "../../examples/podcast-generator/template.js";

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lif-llm-router-"));
  process.env.LIF_DATA_DIR = tmpRoot;
  mockOutput = null;
});

function coreRegistry() {
  const reg = createDefaultToolRegistry();
  const llm = new LlmService({ apiKey: "sk-test-fake" });
  registerBuiltinTools(reg, { llm });
  return reg;
}

/** 构造 mock LlmService（model 无所谓，generateText 已被 mock）。 */
function mockLlm(): LlmService {
  return {
    model: () => ({ specificationVersion: "v1" }) as never,
    modelById: () => ({ specificationVersion: "v1" }) as never,
    // P8.5：新方法 mock（registry 为空回退全局）
    compatMode: false,
    compatModeFor: () => false,
    resolveEndpoint: () => undefined,
  } as unknown as LlmService;
}

describe("P7 planner LLM 选工具成功路径", () => {
  it("mock generateText 返回合法 DAG → planner 优先采用（非模板链）", async () => {
    // LLM 产出的节点链（与模板的 fetch/rewrite/deliver 明显不同）
    const fakeDag = {
      schemaVersion: "1.0",
      nodes: [
        {
          id: "llm_node_1",
          toolName: "core.llm_node",
          params: { prompt: "分析这段意图" },
          dependsOn: [],
          requireConfirmation: false,
          onNodeError: "skip",
          contentPipeline: { maxTokens: 4000, strip: true, summarize: false },
          inputRefs: {},
        },
        {
          id: "deliver_1",
          toolName: "core.deliver",
          params: { artifactType: "analysis" },
          dependsOn: ["llm_node_1"],
          requireConfirmation: false,
          onNodeError: "skip",
          contentPipeline: { maxTokens: 4000, strip: true, summarize: false },
          inputRefs: { "$.tasks.llm_node_1.output": "items" },
        },
      ],
      onNodeError: "skip",
      retryAttempts: 0,
    };
    mockOutput = fakeDag;

    const reg = coreRegistry();
    const outcome = await plan("分析最新的 AI 进展", {
      llm: mockLlm(),
      registry: reg,
      maxRetries: 1,
      useLlmRouter: true,
    });

    expect(outcome.kind).toBe("proceed");
    if (outcome.kind === "proceed") {
      // 验证采用 LLM 产出的节点（非模板路由的 fetch/rewrite）
      const ids = outcome.dag.nodes.map((n) => n.id);
      expect(ids).toContain("llm_node_1");
      expect(ids).toContain("deliver_1");
      expect(ids).not.toContain("fetch");
    }
  });

  it("mock generateText 返回 null → 回退模板路由", async () => {
    mockOutput = null; // LLM 返回空 → planner 回退

    const reg = coreRegistry();
    const outcome = await plan("把 https://example.com 做成播客", {
      llm: mockLlm(),
      registry: reg,
      maxRetries: 1,
      useLlmRouter: true,
      consumerTemplates: [podcastTemplate],
    });

    expect(outcome.kind).toBe("proceed");
    if (outcome.kind === "proceed") {
      // 回退到消费模板：含 fetch（模板特征节点）
      const ids = outcome.dag.nodes.map((n) => n.id);
      expect(ids).toContain("fetch");
    }
  });
});
