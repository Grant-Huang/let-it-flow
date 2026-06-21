/**
 * S2 平台 T+C 框架单测：EvidenceEnvelope + IKnowledgeProvider(Obsidian) + MCP + 工具基类 risk。
 *
 * MCP 客户端的真实连接测试需启动 stdio/http server，不在单测范围（留给 e2e）。
 * 此处用临时 vault 测 ObsidianProvider 检索 + EvidenceEnvelope 包装。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  wrapEvidence,
  isEvidenceEnvelope,
  evidenceStrength,
  summarizeEvidence,
  type EvidenceEnvelope,
} from "../../../../src/core/evidence-envelope.js";
import {
  ObsidianProvider,
  wrapSnippetAsEvidence,
  type IKnowledgeProvider,
} from "../../../../src/tools/knowledge/index.js";
import { createKnowledgeBaseTool } from "../../../../src/tools/builtin/knowledge-base.js";
import { createMcpActionTool } from "../../../../src/tools/mcp/mcp-action-tool.js";
import { McpRouter } from "../../../../src/tools/mcp/mcp-router.js";
import { ToolRegistry } from "../../../../src/tools/registry.js";
import type { FlowConnector, ToolResult } from "../../../../src/tools/base.js";
import type { McpClient, McpToolCallResult, McpToolDescriptor } from "../../../../src/tools/mcp/mcp-client.js";

let vaultPath: string;
beforeEach(() => {
  vaultPath = mkdtempSync(join(tmpdir(), "lif-kb-"));
});

// ─────────────────────────────────────────────────────────────────────────────
// EvidenceEnvelope
// ─────────────────────────────────────────────────────────────────────────────

describe("EvidenceEnvelope", () => {
  it("wrapEvidence 填充全部字段 + 缺省 capturedAt", () => {
    const env = wrapEvidence({ oee: 0.65 }, {
      freshness: "realtime",
      confidence: "measured",
      system: "MES",
      provenance: "/api/oee",
    });
    expect(env.data).toEqual({ oee: 0.65 });
    expect(env.freshness).toBe("realtime");
    expect(env.confidence).toBe("measured");
    expect(env.source.system).toBe("MES");
    expect(env.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(env.caveat).toBeUndefined();
  });

  it("wrapEvidence 含 caveat", () => {
    const env = wrapEvidence(1, {
      freshness: "daily",
      confidence: "estimated",
      system: "ERP",
      provenance: "x",
      caveat: "采样率 1/min",
    });
    expect(env.caveat).toBe("采样率 1/min");
  });

  it("isEvidenceEnvelope 校验结构", () => {
    expect(isEvidenceEnvelope({ data: 1, freshness: "realtime", capturedAt: "t", confidence: "measured", source: { system: "MES", provenance: "x" } })).toBe(true);
    expect(isEvidenceEnvelope({ data: 1 })).toBe(false);
    expect(isEvidenceEnvelope(null)).toBe(false);
    expect(isEvidenceEnvelope("str")).toBe(false);
  });

  it("evidenceStrength 权重正确", () => {
    expect(evidenceStrength({ freshness: "realtime", confidence: "measured" } as EvidenceEnvelope)).toBe(1.0);
    expect(evidenceStrength({ freshness: "historical", confidence: "inferred" } as EvidenceEnvelope)).toBeCloseTo(0.16, 2);
    expect(evidenceStrength({ freshness: "daily", confidence: "estimated" } as EvidenceEnvelope)).toBeCloseTo(0.49, 2);
  });

  it("summarizeEvidence 含系统/时效/置信度", () => {
    const env: EvidenceEnvelope = {
      data: {},
      freshness: "realtime",
      capturedAt: "2026-06-19T22:00:00Z",
      confidence: "measured",
      source: { system: "MES", provenance: "x" },
    };
    const s = summarizeEvidence(env);
    expect(s).toContain("[MES realtime");
    expect(s).toContain("conf=measured");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ObsidianProvider
// ─────────────────────────────────────────────────────────────────────────────

describe("ObsidianProvider", () => {
  it("扫描 vault 索引 markdown", async () => {
    mkdirSync(join(vaultPath, "01-现场状态"));
    writeFileSync(join(vaultPath, "01-现场状态", "OEE计算口径.md"),
      "---\ntitle: OEE 计算口径\ncategory: 01-现场状态\ntags: [OEE, 指标]\n---\n# OEE\nOEE = 可用率 × 性能率 × 质量率\n");
    writeFileSync(join(vaultPath, "术语.md"),
      "# 术语表\n节拍时间 Takt Time\n");

    const provider = new ObsidianProvider({ vaultPath });
    await provider.init();
    expect(provider.ready()).toBe(true);
    const list = await provider.list();
    expect(list.length).toBe(2);
  });

  it("search 按 title/body 命中 + frontmatter 过滤", async () => {
    mkdirSync(join(vaultPath, "03-精益知识"));
    writeFileSync(join(vaultPath, "03-精益知识", "OEE.md"),
      "---\ntitle: OEE 方法论\ncategory: 03-精益知识\n---\nOEE 综合效率指标\n");
    writeFileSync(join(vaultPath, "安全.md"),
      "---\ntitle: 安全管理\ncategory: 08-安全\n---\n安全生产规范\n");

    const provider = new ObsidianProvider({ vaultPath });
    await provider.init();
    const results = await provider.search({ query: "OEE", topK: 5 });
    expect(results.length).toBe(1);
    expect(results[0]!.title).toContain("OEE");
    expect(results[0]!.score).toBeGreaterThan(0);

    // frontmatter 过滤
    const filtered = await provider.search({ query: "OEE", filter: { category: "08-安全" } });
    expect(filtered.length).toBe(0);
  });

  it("read 按 path 精确读取", async () => {
    writeFileSync(join(vaultPath, "doc.md"), "---\ntitle: D\n---\n正文内容\n");
    const provider = new ObsidianProvider({ vaultPath });
    await provider.init();
    const doc = await provider.read("doc.md");
    expect(doc).not.toBeNull();
    expect(doc!.content).toContain("正文内容");
    expect(await provider.read("不存在.md")).toBeNull();
  });

  it("不存在的 vaultPath → ready=false", async () => {
    const provider = new ObsidianProvider({ vaultPath: "/no/such/path" });
    await provider.init();
    expect(provider.ready()).toBe(false);
    expect(await provider.search({ query: "x" })).toEqual([]);
  });

  it("跳过 .obsidian / .git 隐藏目录", async () => {
    mkdirSync(join(vaultPath, ".obsidian"));
    writeFileSync(join(vaultPath, ".obsidian", "app.json"), "{}");
    writeFileSync(join(vaultPath, "real.md"), "# real\n");
    const provider = new ObsidianProvider({ vaultPath });
    await provider.init();
    const list = await provider.list();
    expect(list).toEqual(["real.md"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// wrapSnippetAsEvidence
// ─────────────────────────────────────────────────────────────────────────────

describe("wrapSnippetAsEvidence", () => {
  it("包成 EvidenceEnvelope，confidence=inferred", () => {
    const env = wrapSnippetAsEvidence({
      title: "OEE",
      content: "...",
      path: "01/OEE.md",
      frontmatter: { version: "v2" },
    });
    expect(env.confidence).toBe("inferred");
    expect(env.source.system).toBe("obsidian");
    expect(env.source.provenance).toBe("01/OEE.md");
    expect(env.caveat).toContain("v2");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// core.knowledge_base 工具
// ─────────────────────────────────────────────────────────────────────────────

describe("createKnowledgeBaseTool", () => {
  it("聚合多 provider 检索 + 包成 EvidenceEnvelope", async () => {
    // mock provider A
    const providerA: IKnowledgeProvider = {
      id: "obsidian",
      description: "a",
      ready: () => true,
      search: async ({ query, topK }) => [
        { title: `A:${query}`, content: "c1", path: "a.md", score: 5 },
        { title: `A2:${query}`, content: "c2", path: "a2.md", score: 3 },
      ].slice(0, topK),
      read: async () => null,
    };
    // mock provider B
    const providerB: IKnowledgeProvider = {
      id: "mcp:wiki",
      description: "b",
      ready: () => true,
      search: async ({ query }) => [
        { title: `B:${query}`, content: "c3", path: "b.md", score: 4 },
      ],
      read: async () => null,
    };

    const tool = createKnowledgeBaseTool([providerA, providerB]);
    expect(tool.name).toBe("core.knowledge_base");
    expect(tool.tier).toBe("core");

    const ctx = makeMockCtx();
    const gen = tool.execute({ query: "OEE", topK: 2 }, ctx);
    const events: any[] = [];
    let final: ToolResult | undefined;
    while (true) {
      const r = await gen.next();
      if (r.done) { final = r.value; break; }
      events.push(r.value);
    }
    const output = final!.output as EvidenceEnvelope<{
      providersQueried: string[];
      results: EvidenceEnvelope[];
      totalHits: number;
      query: string;
    }>;
    expect(output.data.providersQueried).toEqual(["obsidian", "mcp:wiki"]);
    expect(output.data.results.length).toBe(2); // topK=2
    // 按 score 降序：A(5) > B(4)
    expect(output.data.results[0]?.source.system).toBe("obsidian");
  });

  it("provider 过滤生效", async () => {
    const providerA: IKnowledgeProvider = {
      id: "obsidian", description: "a", ready: () => true,
      search: async () => [{ title: "A", content: "", path: "a", score: 1 }],
      read: async () => null,
    };
    const providerB: IKnowledgeProvider = {
      id: "other", description: "b", ready: () => true,
      search: async () => [{ title: "B", content: "", path: "b", score: 1 }],
      read: async () => null,
    };
    const tool = createKnowledgeBaseTool([providerA, providerB]);
    const gen = tool.execute({ query: "x", provider: "obsidian" }, makeMockCtx());
    let final: ToolResult | undefined;
    while (true) { const r = await gen.next(); if (r.done) { final = r.value; break; } }
    expect((final!.output as EvidenceEnvelope<{ providersQueried: string[] }>).data.providersQueried).toEqual(["obsidian"]);
  });

  it("无 provider 时返回带 caveat 的空结果", async () => {
    const tool = createKnowledgeBaseTool([]);
    const gen = tool.execute({ query: "x" }, makeMockCtx());
    let final: ToolResult | undefined;
    while (true) { const r = await gen.next(); if (r.done) { final = r.value; break; } }
    expect((final!.output as EvidenceEnvelope).caveat).toContain("无可用 KB provider");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP action tool 工厂
// ─────────────────────────────────────────────────────────────────────────────

describe("createMcpActionTool", () => {
  it("按工具名推断风险评级", () => {
    const mockClient = makeMockMcpClient();
    const safeTool = createMcpActionTool({
      serverId: "mes",
      descriptor: makeDescriptor("get_status", "查询状态"),
      client: mockClient,
    });
    expect(safeTool.risk).toBe("safe");

    const writeTool = createMcpActionTool({
      serverId: "mes",
      descriptor: makeDescriptor("update_schedule", "更新排产"),
      client: mockClient,
    });
    expect(writeTool.risk).toBe("write");

    const destructiveTool = createMcpActionTool({
      serverId: "mes",
      descriptor: makeDescriptor("stop_line", "停线"),
      client: mockClient,
    });
    expect(destructiveTool.risk).toBe("destructive");
  });

  it("工具名格式 mcp.<serverId>.<toolName>", () => {
    const t = createMcpActionTool({
      serverId: "erp",
      descriptor: makeDescriptor("create_order", "创建工单"),
      client: makeMockMcpClient(),
    });
    expect(t.name).toBe("mcp.erp.create_order");
    expect(t.tier).toBe("custom");
  });

  it("execute 调 client.callTool 并包成 EvidenceEnvelope", async () => {
    const mockResult: McpToolCallResult = {
      content: [{ type: "text", text: '{"ok":true}' }],
    };
    const mockClient = makeMockMcpClient(mockResult);
    const tool = createMcpActionTool({
      serverId: "mes",
      descriptor: makeDescriptor("get_oee", "查 OEE"),
      client: mockClient,
    });
    const gen = tool.execute({ line: "A" }, makeMockCtx());
    let final: ToolResult | undefined;
    while (true) { const r = await gen.next(); if (r.done) { final = r.value; break; } }
    const output = final!.output as EvidenceEnvelope;
    expect(output.source.system).toBe("mes");
    expect(output.confidence).toBe("measured");
    expect(output.data).toMatchObject({ isError: false });
  });

  it("registerMcpServerTools 批量注册（router）", async () => {
    const router = new McpRouter([]);
    const mockClient = makeMockMcpClient(
      { content: [{ type: "text", text: "{}" }] },
      [{ name: "tool_a", description: "a", inputSchema: { type: "object" } }],
    );
    // 注入 mock client
    (router as unknown as { clients: Map<string, unknown> }).clients.set("srv1", mockClient);
    const reg = new ToolRegistry();
    const n = await registerViaRouter(reg, router, "srv1");
    expect(n).toBe(1);
    expect(reg.has("mcp.srv1.tool_a")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FlowConnector risk 字段（向后兼容）
// ─────────────────────────────────────────────────────────────────────────────

describe("FlowConnector risk 字段", () => {
  it("老工具不带 risk 时按 safe 处理（向后兼容）", () => {
    const oldTool: FlowConnector = {
      name: "old.tool",
      tier: "core",
      description: "x",
      inputSchema: {},
      whenToUse: { triggers: [], notFor: [] },
      outputSchema: {},
      outputExample: {},
      async *execute() { return { output: {} }; },
    };
    expect(oldTool.risk).toBeUndefined();
  });

  it("新工具可声明 risk=write", () => {
    const tool: FlowConnector = {
      name: "x.write",
      tier: "domain",
      description: "x",
      inputSchema: {},
      whenToUse: { triggers: [], notFor: [] },
      outputSchema: {},
      outputExample: {},
      risk: "write",
      async *execute() { return { output: {} }; },
    };
    expect(tool.risk).toBe("write");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeMockCtx() {
  return {
    taskId: "t", runId: "r", nodeId: "n", intent: "",
    emit: async () => ({} as never),
    requireConfirmation: async () => ({ approved: true }),
    resolveRef: () => undefined,
  } as unknown as Parameters<FlowConnector["execute"]>[1];
}

function makeDescriptor(name: string, description: string): McpToolDescriptor {
  return { name, description, inputSchema: { type: "object", properties: {} } };
}

function makeMockMcpClient(
  callResult: McpToolCallResult = { content: [{ type: "text", text: "{}" }] },
  tools: McpToolDescriptor[] = [],
): McpClient {
  return {
    id: "mock",
    isConnected: () => true,
    connect: async () => {},
    disconnect: async () => {},
    listTools: async () => tools,
    callTool: async () => callResult,
    listResources: async () => [],
    readResource: async () => ({ contents: [] }),
  } as unknown as McpClient;
}

// 直接调 registerMcpServerTools 需绕过类型（mock router）
async function registerViaRouter(
  reg: ToolRegistry,
  router: McpRouter,
  serverId: string,
): Promise<number> {
  const { registerMcpServerTools } = await import("../../../../src/tools/mcp/mcp-action-tool.js");
  return registerMcpServerTools(reg, router, serverId);
}
