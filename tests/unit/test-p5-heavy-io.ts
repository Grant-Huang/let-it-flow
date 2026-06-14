import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import {
  buildPodcastDag,
  PodcastParams,
} from "../../src/planner/templates.js";
import { validateDag } from "../../src/planner/validator.js";
import { plan } from "../../src/planner/planner.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { FlowConnector, ToolResult } from "../../src/tools/base.js";
import type { ToolEvent } from "../../src/core/stream-events.js";
import {
  registerBuiltinTools,
  registerHeavyIoTools,
} from "../../src/tools/index.js";
import { SubprocessAdapter } from "../../src/tools/heavy-io/subprocess-adapter.js";
import type { HeavyIoConfig } from "../../src/tools/heavy-io/provider.js";
import type { LlmService } from "../../src/services/llm-service.js";

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lif-p5-"));
  process.env.LIF_DATA_DIR = tmpRoot;
});

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

/** 伪 domain 工具（让 validateDag + hasDomainTools 通过）。 */
function fakeDomainTool(name: string): FlowConnector {
  return {
    name,
    tier: "domain",
    description: `fake ${name}`,
    inputSchema: {},
    async *execute(params): AsyncGenerator<ToolEvent, ToolResult> {
      return { output: params };
    },
  };
}

/** 注册 core + 全部 domain 工具（伪实现）的 registry。 */
function fullRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  for (const name of ["core.web_search", "core.web_fetch", "core.llm_node", "core.deliver"]) {
    reg.register(fakeDomainTool(name));
  }
  for (const name of [
    "domain.translate",
    "domain.rewrite",
    "domain.seam_repair",
    "domain.terminology",
    "domain.image_prompts",
    "domain.tts",
    "domain.image_gen",
    "domain.subtitle",
    "domain.video_build",
  ]) {
    reg.register(fakeDomainTool(name));
  }
  return reg;
}

// ─────────────────────────────────────────────────────────────────────────────
// 完整 7 步 DAG 构建
// ─────────────────────────────────────────────────────────────────────────────
describe("P5 full pipeline DAG", () => {
  it("fullPipeline=true 构建 10 节点完整链（url 路径）", () => {
    const dag = buildPodcastDag(
      PodcastParams.parse({
        sourceMode: "url",
        urls: ["https://example.com/a"],
        style: "dialogue",
      }),
      true,
    );
    const ids = dag.nodes.map((n) => n.id);
    expect(ids).toEqual([
      "fetch",
      "translate",
      "rewrite",
      "seam_repair",
      "terminology",
      "image_prompts",
      "tts",
      "image_gen",
      "subtitle",
      "video_build",
      "deliver",
    ]);
  });

  it("fullPipeline=true（topic 路径）含 search 节点", () => {
    const dag = buildPodcastDag(
      PodcastParams.parse({ sourceMode: "topic", topic: "AI", style: "narration" }),
      true,
    );
    expect(dag.nodes[0]!.id).toBe("search");
    expect(dag.nodes[1]!.id).toBe("fetch");
    expect(dag.nodes.length).toBe(12); // search + 11 节点
  });

  it("完整链校验通过（工具全注册）", () => {
    const dag = buildPodcastDag(
      PodcastParams.parse({ sourceMode: "url", urls: ["https://x.com"], style: "dialogue" }),
      true,
    );
    expect(validateDag(dag, fullRegistry())).toEqual([]);
  });

  it("tts 与 image_gen 并行：共享上游但互不依赖", () => {
    const dag = buildPodcastDag(
      PodcastParams.parse({ sourceMode: "url", urls: ["https://x.com"], style: "dialogue" }),
      true,
    );
    const tts = dag.nodes.find((n) => n.id === "tts")!;
    const imgGen = dag.nodes.find((n) => n.id === "image_gen")!;
    expect(tts.dependsOn).not.toContain("image_gen");
    expect(imgGen.dependsOn).not.toContain("tts");
  });

  it("video_build 依赖 tts + image_gen + subtitle", () => {
    const dag = buildPodcastDag(
      PodcastParams.parse({ sourceMode: "url", urls: ["https://x.com"], style: "dialogue" }),
      true,
    );
    const vb = dag.nodes.find((n) => n.id === "video_build")!;
    expect(vb.dependsOn.sort()).toEqual(["image_gen", "subtitle", "tts"].sort());
  });

  it("rewrite 保留 HITL 确认点（requireConfirmation: true）", () => {
    const dag = buildPodcastDag(
      PodcastParams.parse({ sourceMode: "url", urls: ["https://x.com"], style: "dialogue" }),
      true,
    );
    expect(dag.nodes.find((n) => n.id === "rewrite")?.requireConfirmation).toBe(true);
  });

  it("fullPipeline=false 仍为 P4 文本子链（向后兼容）", () => {
    const dag = buildPodcastDag(
      PodcastParams.parse({ sourceMode: "url", urls: ["https://x.com"], style: "dialogue" }),
      false,
    );
    expect(dag.nodes.map((n) => n.id)).toEqual(["fetch", "rewrite", "deliver"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Planner full-pipeline 检测
// ─────────────────────────────────────────────────────────────────────────────
describe("P5 planner full-pipeline detection", () => {
  it("含「视频」+ domain 工具齐全 → 完整链 DAG", async () => {
    const outcome = await plan("把 https://example.com 做成播客视频", {
      llm: { model: () => ({ specificationVersion: "v1" }) } as never,
      registry: fullRegistry(),
      maxRetries: 1,
    });
    expect(outcome.kind).toBe("proceed");
    if (outcome.kind === "proceed") {
      // 完整链应含 video_build
      expect(outcome.dag.nodes.some((n) => n.id === "video_build")).toBe(true);
    }
  });

  it("无「视频」关键词 → 文本子链（无 video_build）", async () => {
    const outcome = await plan("把 https://example.com 做成播客", {
      llm: { model: () => ({ specificationVersion: "v1" }) } as never,
      registry: fullRegistry(),
      maxRetries: 1,
    });
    expect(outcome.kind).toBe("proceed");
    if (outcome.kind === "proceed") {
      expect(outcome.dag.nodes.some((n) => n.id === "video_build")).toBe(false);
    }
  });

  it("含「视频」但 domain 工具未注册 → 降级文本子链", async () => {
    // 仅 core 工具的 registry
    const coreReg = new ToolRegistry();
    for (const name of ["core.web_search", "core.web_fetch", "core.llm_node", "core.deliver"]) {
      coreReg.register(fakeDomainTool(name));
    }
    const outcome = await plan("把 https://example.com 做成播客视频", {
      llm: { model: () => ({ specificationVersion: "v1" }) } as never,
      registry: coreReg,
      maxRetries: 1,
    });
    expect(outcome.kind).toBe("proceed");
    if (outcome.kind === "proceed") {
      expect(outcome.dag.nodes.some((n) => n.id === "video_build")).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 工具注册
// ─────────────────────────────────────────────────────────────────────────────
describe("P5 tool registration", () => {
  it("registerHeavyIoTools 注册全部 9 个 domain 工具", () => {
    const reg = new ToolRegistry();
    registerBuiltinTools(reg, { llm: { model: () => ({}) } as unknown as LlmService });
    const config: HeavyIoConfig = {
      repoRoot: "/fake/repo",
      artifactsDir: tmpRoot,
      pythonBin: "python3",
    };
    const adapter = new SubprocessAdapter(config);
    registerHeavyIoTools(reg, {
      adapter,
      llm: { model: () => ({}) } as unknown as LlmService,
      config,
    });
    const domainNames = [
      "domain.translate",
      "domain.rewrite",
      "domain.seam_repair",
      "domain.terminology",
      "domain.image_prompts",
      "domain.tts",
      "domain.image_gen",
      "domain.subtitle",
      "domain.video_build",
    ];
    for (const name of domainNames) {
      expect(reg.has(name)).toBe(true);
    }
  });

  it("SubprocessAdapter.workDirOf 拼接 artifactsDir/taskId", () => {
    const adapter = new SubprocessAdapter({ repoRoot: "/r", artifactsDir: tmpRoot });
    expect(adapter.workDirOf("t_123")).toBe(join(tmpRoot, "t_123"));
  });
});
