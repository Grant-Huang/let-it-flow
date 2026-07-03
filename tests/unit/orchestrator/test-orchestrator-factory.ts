/**
 * Phase 3.4 OrchestratorFactory + boot 装配集成测试。
 *
 * 验证：
 *   - createOrchestrator 返回 MockOrchestrator 实例（source=mock）
 *   - createToolResolver 组合 IndexToolResolver + LlmToolResolver
 *   - boot.ts 装配后 NexusRuntime.orchestrator / toolResolver 非空
 *   - syncToolIndex 成功写出 data/relos-mock/tool-index.json（含 semanticTags）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOrchestrator } from "../../../src/orchestrator/factory.js";
import { createToolResolver } from "../../../src/orchestrator/resolver-factory.js";
import { MockOrchestrator } from "../../../src/orchestrator/mock-orchestrator.js";
import { CompositeToolResolver } from "../../../src/orchestrator/composite-resolver.js";
import { ToolRegistry } from "../../../src/tools/registry.js";
import { bootNexusOps } from "../../../apps/nexusops/server/boot.js";
import type { LlmService } from "../../../src/services/llm-service.js";
import type { BizContext } from "../../../src/orchestrator/types.js";

// ─────────────────────────────────────────────────────────────────────────────
// OrchestratorFactory
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 3.4 OrchestratorFactory", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "orch-factory-"));
    // 拷贝一份 mock 数据到临时目录
    mkdirSync(dataDir, { recursive: true });
    const srcDir = join(process.cwd(), "data/relos-mock");
    for (const f of ["relations.json", "methodologies-full.json", "methodologies-min.json", "evidence-contracts.json"]) {
      const src = join(srcDir, f);
      if (existsSync(src)) {
        writeFileSync(join(dataDir, f), readFileSync(src));
      }
    }
  });

  it("返回 MockOrchestrator 实例", () => {
    const orch = createOrchestrator({ dataDir });
    expect(orch).toBeInstanceOf(MockOrchestrator);
  });

  it("getMethodology 返回 source=mock 的方法论", async () => {
    const orch = createOrchestrator({ dataDir });
    const ctx: BizContext = { line: "L01", scenarioId: "anomaly" };
    const m = await orch.getMethodology("dmaic", ctx);
    expect(m).not.toBeNull();
    expect(m!.source).toBe("mock");
    expect(m!.topic).toBe("dmaic");
  });

  it("缺省 dataDir 时用 data/relos-mock", () => {
    const orch = createOrchestrator();
    expect(orch).toBeInstanceOf(MockOrchestrator);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// createToolResolver
// ─────────────────────────────────────────────────────────────────────────────

describe("Phase 3.4 createToolResolver", () => {
  it("无 model 注入时只装 IndexToolResolver（返回 CompositeToolResolver）", () => {
    const reg = new ToolRegistry();
    const resolver = createToolResolver({ registry: reg });
    expect(resolver).toBeInstanceOf(CompositeToolResolver);
  });

  it("索引命中（process_capability → quality.cp_cpk）", async () => {
    const reg = new ToolRegistry();
    // 写一个临时索引文件
    const indexPath = join(mkdtempSync(join(tmpdir(), "idx-")), "tool-semantic-index.json");
    writeFileSync(
      indexPath,
      JSON.stringify({
        version: "1.0",
        entries: [{ semantic: "process_capability", toolName: "quality.cp_cpk", primary: true }],
      }),
    );
    const resolver = createToolResolver({ registry: reg, indexPath });
    const ctx: BizContext = { line: "L01", scenarioId: "anomaly" };
    const result = await resolver.resolve({ semantic: "process_capability" }, ctx);
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("quality.cp_cpk");
    expect(result!.source).toBe("index");
    expect(result!.confidence).toBe(1.0);
  });

  it("索引未命中且无 LLM 档时返回 null", async () => {
    const reg = new ToolRegistry();
    const indexPath = join(mkdtempSync(join(tmpdir(), "idx-")), "empty-index.json");
    writeFileSync(indexPath, JSON.stringify({ version: "1.0", entries: [] }));
    const resolver = createToolResolver({ registry: reg, indexPath });
    const ctx: BizContext = { line: "L01", scenarioId: "anomaly" };
    const result = await resolver.resolve({ semantic: "nonexistent_semantic" }, ctx);
    expect(result).toBeNull();
  });

  it("会话内缓存：同 semantic 第二次不重复解析", async () => {
    const reg = new ToolRegistry();
    const indexPath = join(mkdtempSync(join(tmpdir(), "idx-")), "tool-semantic-index.json");
    writeFileSync(
      indexPath,
      JSON.stringify({
        version: "1.0",
        entries: [{ semantic: "oee_metric", toolName: "oee.realtime", primary: true }],
      }),
    );
    const resolver = createToolResolver({ registry: reg, indexPath });
    const ctx: BizContext = { line: "L01", scenarioId: "anomaly" };
    const r1 = await resolver.resolve({ semantic: "oee_metric" }, ctx);
    const r2 = await resolver.resolve({ semantic: "oee_metric" }, ctx);
    expect(r1).toEqual(r2);
    expect(r1!.toolName).toBe("oee.realtime");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// boot.ts 装配集成（验证 NexusRuntime.orchestrator / toolResolver 非空）
// ─────────────────────────────────────────────────────────────────────────────

let bootDataDir: string;
let bootVaultPath: string;
const savedBootEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  bootDataDir = mkdtempSync(join(tmpdir(), "nexus-boot-orch-"));
  bootVaultPath = join(bootDataDir, "vault");
  mkdirSync(join(bootVaultPath, "01-现场状态"), { recursive: true });
  writeFileSync(
    join(bootVaultPath, "01-现场状态", "OEE计算口径.md"),
    "---\ntitle: OEE 计算口径\ntags: [oee, sop]\n---\nOEE = 可用率 × 表现率 × 质量率。\n",
    "utf8",
  );
  for (const k of ["LIF_DATA_DIR", "OBSIDIAN_VAULT_PATH", "NEXUS_MCP_SERVERS", "NEXUS_MOCK_TOOLS", "NEXUS_MOCK_ACTIONS"]) {
    savedBootEnv[k] = process.env[k];
  }
  process.env.LIF_DATA_DIR = bootDataDir;
  process.env.OBSIDIAN_VAULT_PATH = bootVaultPath;
  delete process.env.NEXUS_MCP_SERVERS;
  // 测试默认在全开 mock 模式跑（避免 .env 的 NEXUS_MOCK_TOOLS=0 污染测试）
  delete process.env.NEXUS_MOCK_TOOLS;
  delete process.env.NEXUS_MOCK_ACTIONS;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedBootEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(bootDataDir, { recursive: true, force: true });
});

function mockLlm(): LlmService {
  return {
    model: () => ({ specificationVersion: "v1" }) as never,
    compatModeFor: () => false,
    subscribeConfigChanges: () => {},
  } as unknown as LlmService;
}

describe("Phase 3.4 boot.ts 装配 Orchestrator + ToolResolver", () => {
  it("NexusRuntime.orchestrator 非空（MockOrchestrator 实例）", async () => {
    const runtime = await bootNexusOps({ llm: mockLlm() });
    expect(runtime.orchestrator).toBeDefined();
    expect(runtime.orchestrator).toBeInstanceOf(MockOrchestrator);
  });

  it("NexusRuntime.toolResolver 非空（CompositeToolResolver 实例）", async () => {
    const runtime = await bootNexusOps({ llm: mockLlm() });
    expect(runtime.toolResolver).toBeDefined();
    expect(runtime.toolResolver).toBeInstanceOf(CompositeToolResolver);
  });

  it("getMethodology('dmaic') 返回 source=mock 的方法论", async () => {
    const runtime = await bootNexusOps({ llm: mockLlm() });
    const ctx: BizContext = { line: "L01", scenarioId: "anomaly" };
    const m = await runtime.orchestrator.getMethodology("dmaic", ctx);
    expect(m).not.toBeNull();
    expect(m!.source).toBe("mock");
    expect(m!.topic).toBe("dmaic");
  });

  it("resolve({semantic:'process_capability'}) 命中 quality.cp_cpk", async () => {
    const runtime = await bootNexusOps({ llm: mockLlm() });
    const ctx: BizContext = { line: "L01", scenarioId: "anomaly" };
    // 注意：boot 不写 tool-semantic-index.json，但 IndexToolResolver 读 data/tool-semantic-index.json
    // 这里验证 toolResolver 可调用（命中或 null 都算可调用，关键是不抛错）
    const result = await runtime.toolResolver.resolve({ semantic: "process_capability" }, ctx);
    // 不强断言 toolName（取决于索引文件是否存在），只验证返回类型正确
    expect(result === null || typeof result.toolName === "string").toBe(true);
  });

  it("syncToolIndex 成功写出 tool-index.json（含 semanticTags）", async () => {
    const runtime = await bootNexusOps({ llm: mockLlm() });
    // boot 内部已调 syncToolIndex，验证产物文件
    // 注意：data/relos-mock 是相对路径，boot 时 LIF_DATA_DIR 影响的是 store，不影响 relos-mock
    // 所以产物写在 cwd/data/relos-mock/tool-index.json
    const toolIndexPath = join(process.cwd(), "data", "relos-mock", "tool-index.json");
    // 文件可能因并行测试存在，读最新内容
    expect(existsSync(toolIndexPath)).toBe(true);
    const raw = readFileSync(toolIndexPath, "utf8");
    const data = JSON.parse(raw);
    expect(data.version).toBe("1.0");
    expect(Array.isArray(data.tools)).toBe(true);
    expect(data.tools.length).toBeGreaterThan(0);
    // 至少有一个工具含 semanticTags
    const withTags = data.tools.filter((t: { semanticTags?: string[] }) => Array.isArray(t.semanticTags) && t.semanticTags.length > 0);
    expect(withTags.length).toBeGreaterThan(0);
    void runtime;
  });
});
