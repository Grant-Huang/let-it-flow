/**
 * Mestar MCP 接入 E2E 测试（Phase M3）。
 *
 * 验证完整链路（07-mestar-integration-spec.md §2 五层管道 + §7 LazyMcpActionTool）：
 *   1. McpCatalogCache 预热 → 分桶缓存就绪
 *   2. EmbeddingToolRouter 构建向量索引
 *   3. CompositeToolResolver 解析 semantic="device_bom" → 命中工具
 *   4. LazyMcpActionTool 执行（activate → build_params → callTool）→ EvidenceEnvelope
 *   5. CatalogSearchResolver 在线兜底 + 回写本地索引
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpCatalogCache, type CatalogItem } from "../../../src/tools/mcp/mcp-catalog-cache.js";
import { EmbeddingToolRouter, type Embedder } from "../../../src/orchestrator/embedding-router.js";
import { IndexToolResolver } from "../../../src/orchestrator/index-resolver.js";
import { CompositeToolResolver } from "../../../src/orchestrator/composite-resolver.js";
import { CatalogSearchResolver } from "../../../src/orchestrator/catalog-search-resolver.js";
import { createLazyMcpActionTool } from "../../../src/tools/mcp/lazy-mcp-action-tool.js";
import type { McpClient, McpToolCallResult } from "../../../src/tools/mcp/mcp-client.js";
import type { ExecutionContext } from "../../../src/tools/base.js";
import type { SemanticNeed, BizContext } from "../../../src/orchestrator/types.js";

let tmpDir: string;
let toolIndexPath: string;
let cacheDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mestar-e2e-"));
  toolIndexPath = join(tmpDir, "tool-index.json");
  cacheDir = join(tmpDir, "mestar");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const ctx: BizContext = { scenarioId: "anomaly", line: "L01" };

/** 构造 mock ExecutionContext（lazyTool.execute 需要，但 LazyMcpActionTool 内部不依赖它）。 */
function makeMockExecCtx(): ExecutionContext {
  return {
    taskId: "test-task",
    runId: "test-run",
    nodeId: "test-node",
    emit: vi.fn(async (event) => ({ ...event, seq: 0, taskId: "test-task", ts: Date.now() })) as ExecutionContext["emit"],
    requireConfirmation: vi.fn(async () => ({ approved: true })) as ExecutionContext["requireConfirmation"],
    resolveRef: vi.fn(() => undefined) as ExecutionContext["resolveRef"],
  };
}

/** 驱动 lazy 工具的 async generator 到完成，收集中间事件与最终结果。 */
async function drainGenerator(gen: AsyncGenerator<unknown, unknown>): Promise<{ events: unknown[]; result: any }> {
  const events: unknown[] = [];
  let result: unknown;
  while (true) {
    const { value, done } = await gen.next();
    if (done) {
      result = value;
      break;
    }
    events.push(value);
  }
  return { events, result: result as any };
}

/** 设备BOM 查询工具（catalog 项）。 */
const deviceBomItem: CatalogItem = {
  name: "mestar.query.uempEquipBomView_FORM_Tree.uempEquipBomform.platform.select",
  title: "设备BOM",
  description: "platformController platform#select 设备清单查询",
  kind: "platformController",
  risk: "readOnly",
  executable: true,
  route: { adapter: "platformController", bean: "platform", method: "select", entity: "UempEquipBom" },
  menu: { name: "设备BOM", rel: "uempEquipBomView_FORM_Tree" },
  module: { name: "Uemp", source: "entityPrefix" },
};

/** 构造完整 mock McpClient（catalog.search + activate + build_params + 业务工具调用）。 */
function makeFullMockClient(items: CatalogItem[]): McpClient {
  const activatedTools = new Set<string>();
  const callTool = vi.fn(async (name: string, args: Record<string, unknown>): Promise<McpToolCallResult> => {
    // catalog.search：返回全量 items
    if (name === "mestar.catalog.search") {
      return {
        content: [{ type: "text", text: JSON.stringify({ items, total: items.length }) }],
        structuredContent: { items, total: items.length },
      } as McpToolCallResult;
    }
    // catalog.activate：记录已激活工具
    if (name === "mestar.catalog.activate") {
      for (const n of (args.toolNames as string[]) ?? []) activatedTools.add(n);
      return { content: [{ type: "text", text: "activated" }] } as McpToolCallResult;
    }
    // query.build_params：返回默认参数
    if (name === "mestar.query.build_params") {
      return {
        content: [{ type: "text", text: JSON.stringify({ params: { page: 1, size: 20 } }) }],
        structuredContent: { params: { page: 1, size: 20 } },
      } as McpToolCallResult;
    }
    // 业务工具调用（设备BOM 查询返回 mock 数据）
    if (name === deviceBomItem.name) {
      return {
        content: [
          { type: "text", text: JSON.stringify({ rows: [{ equipNo: "E001", equipName: "数控车床" }], total: 1 }) },
        ],
        structuredContent: { rows: [{ equipNo: "E001", equipName: "数控车床" }], total: 1 },
      } as McpToolCallResult;
    }
    throw new Error(`未 mock 的工具调用：${name}`);
  });
  return { callTool } as unknown as McpClient;
}

/** Mock Embedder（关键词向量，"设备"+"bom" 共现则高分）。 */
function makeMockEmbedder(): Embedder {
  return {
    embed: vi.fn(async (texts: string[]): Promise<number[][]> => {
      const keywords = ["设备", "bom", "product", "项目", "quality", "defect", "material", "process"];
      return texts.map((text) => {
        const lower = text.toLowerCase();
        return keywords.map((kw) => (lower.includes(kw) ? 1 : 0));
      });
    }),
  };
}

describe("Mestar MCP E2E（查设备BOM 全链路）", () => {
  it("预热 → 解析命中 → lazy 调用 → EvidenceEnvelope", async () => {
    const client = makeFullMockClient([deviceBomItem]);

    // 1. McpCatalogCache 预热
    const cache = new McpCatalogCache({
      serverId: "mestar",
      client,
      cacheRoot: tmpDir,
      toolIndexPath,
    });
    await cache.warmup();
    expect(cache.isReady()).toBe(true);
    expect(cache.getBucket("Uemp").length).toBeGreaterThan(0);

    // 2. EmbeddingToolRouter 构建向量索引
    const embedder = makeMockEmbedder();
    const router = new EmbeddingToolRouter({ cacheDir, embedder, directHitThreshold: 0.3 });
    await router.buildIndex(cache.getAllBuckets());
    expect(router.isReady()).toBe(true);

    // 3. CompositeToolResolver 解析 semantic="device_bom"
    //    （IndexToolResolver 会从 tool-index.json 命中，因为预热时派生了 semanticTags）
    const indexResolver = new IndexToolResolver(toolIndexPath);
    const resolver = new CompositeToolResolver([indexResolver, router]);
    const need: SemanticNeed = { semantic: "device_bom_query", required: true };
    const resolved = await resolver.resolve(need, ctx);
    expect(resolved).not.toBeNull();
    expect(resolved!.toolName).toContain("uempEquipBom");

    // 4. LazyMcpActionTool 执行（activate → build_params → callTool）
    const lazyTool = createLazyMcpActionTool({
      serverId: "mestar",
      client,
      catalogCache: cache,
    });
    expect(lazyTool.name).toBe("mcp.mestar.call");

    const { events, result: finalResult } = await drainGenerator(
      lazyTool.execute!({ toolName: resolved!.toolName }, makeMockExecCtx()),
    );

    // 4a. 产生了 tool_call + tool_result 事件
    const eventTypes = events.map((e) => (e as { type: string }).type);
    expect(eventTypes).toContain("tool_call");
    expect(eventTypes).toContain("tool_result");

    // 4b. 最终返回 ToolResult，output 是 EvidenceEnvelope
    expect(finalResult).toBeDefined();
    expect(finalResult.output).toBeDefined();
    expect(finalResult.output.data).toBeDefined();
    expect(finalResult.output.source.system).toBe("mestar");
    expect(finalResult.summary).toContain("完成");

    // 4c. client.callTool 被调用（activate + build_params + 业务工具）
    expect(client.callTool).toHaveBeenCalledWith("mestar.catalog.activate", expect.any(Object));
    expect(client.callTool).toHaveBeenCalledWith(resolved!.toolName, expect.any(Object));
  });

  it("LazyMcpActionTool args 缺失时自动调 build_params", async () => {
    const client = makeFullMockClient([deviceBomItem]);
    const lazyTool = createLazyMcpActionTool({ serverId: "mestar", client });

    const { result: finalResult } = await drainGenerator(
      lazyTool.execute!({ toolName: deviceBomItem.name }, makeMockExecCtx()),
    );

    // build_params 被调用
    expect(client.callTool).toHaveBeenCalledWith("mestar.query.build_params", { toolName: deviceBomItem.name });
    // 业务工具用 build_params 返回的参数调用
    expect(client.callTool).toHaveBeenCalledWith(deviceBomItem.name, { page: 1, size: 20 });
    expect(finalResult.output.data).toBeDefined();
  });

  it("CatalogSearchResolver 在线兜底 + 回写本地索引", async () => {
    // 用一个规则派生覆盖不到的工具（未知 module），确保回写新增条目
    const unknownItem: CatalogItem = {
      name: "mestar.query.customReport xyz.platform.select",
      title: "自定义报表XYZ",
      description: "customReport xyz query",
      kind: "platformController",
      risk: "readOnly",
      executable: true,
      route: { adapter: "platformController", bean: "platform", method: "select" },
      menu: { name: "自定义报表XYZ" },
      module: { name: "CustomXyz", source: "entityPrefix" }, // 未知 module，规则派生返回空
    };
    const client = makeFullMockClient([unknownItem]);

    const cache = new McpCatalogCache({
      serverId: "mestar",
      client,
      cacheRoot: tmpDir,
      toolIndexPath,
    });
    await cache.warmup();

    // 预热后该工具没有 semanticTags（规则派生覆盖不到），不在 tool-index.json 里
    // （文件可能不存在，因为 persistToToolIndex 在无 tagged 工具时不创建）
    let hadBefore = false;
    if (existsSync(toolIndexPath)) {
      const indexBefore = JSON.parse(readFileSync(toolIndexPath, "utf8"));
      hadBefore = indexBefore.tools.some((t: { name: string }) => t.name === unknownItem.name);
    }
    expect(hadBefore).toBe(false);

    // CatalogSearchResolver 在线兜底（用 need.semantic 作为回写 semantic）
    const searchResolver = new CatalogSearchResolver({
      serverId: "mestar",
      client,
      onResolved: (toolName, semantic) => cache.appendToolEntry(toolName, semantic),
    });

    const need: SemanticNeed = { semantic: "custom_xyz_report", description: "自定义报表XYZ", required: true };
    const resolved = await searchResolver.resolve(need, ctx);

    // 命中（在线搜索到工具）
    expect(resolved).not.toBeNull();
    expect(resolved!.source).toBe("fallback");
    expect(resolved!.toolName).toBe(unknownItem.name);

    // 验证 tool-index.json 被回写（新增了 custom_xyz_report 条目）
    const indexAfter = JSON.parse(readFileSync(toolIndexPath, "utf8"));
    const hasNewEntry = indexAfter.tools.some(
      (t: { name: string; semanticTags?: string[] }) =>
        t.name === unknownItem.name && t.semanticTags?.includes("custom_xyz_report"),
    );
    expect(hasNewEntry).toBe(true);
  });

  it("LazyMcpActionTool 执行失败返回错误 EvidenceEnvelope（不抛异常）", async () => {
    const failingClient: McpClient = {
      callTool: vi.fn(async () => {
        throw new Error("mestar connection refused");
      }),
    } as unknown as McpClient;

    const lazyTool = createLazyMcpActionTool({ serverId: "mestar", client: failingClient });
    let threw = false;
    let finalResult: any;
    try {
      const drained = await drainGenerator(
        lazyTool.execute!({ toolName: deviceBomItem.name }, makeMockExecCtx()),
      );
      finalResult = drained.result;
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);

    // 返回错误 EvidenceEnvelope
    expect(finalResult).toBeDefined();
    expect(finalResult.output.data.isError).toBe(true);
    expect(finalResult.summary).toContain("出错");
  });
});
