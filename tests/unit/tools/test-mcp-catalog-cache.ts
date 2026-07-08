/**
 * McpCatalogCache 单元测试（L0/L2 改造版）。
 *
 * 验证（07-mestar-integration-spec.md §5 v2）：
 *   - 分页拉取 catalog（mock mestar.catalog.search）
 *   - L0.2：deriveSemantic 优先用服务自带 semanticTags（删除 route 依赖）
 *   - L0.3：BucketItem 纳入新字段（displayName/aliases/exampleQueries/inputSummary/domain）
 *   - L2.2：tool-index.json 双 tag 体系（中文 semanticTags + 英文 entries）
 *   - executable=false 的工具不进语义索引/分桶
 *   - ModuleMap 含 domain 聚合统计
 *   - 预热失败不阻塞（降级到无缓存）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  McpCatalogCache,
  deriveSemantic,
  deriveEnglishSemantic,
  type CatalogItem,
} from "../../../src/tools/mcp/mcp-catalog-cache.js";
import type { McpClient, McpToolCallResult } from "../../../src/tools/mcp/mcp-client.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "mcp-catalog-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** 构造 mock McpClient，模拟 mestar.catalog.search 分页返回。 */
function makeMockClient(pages: CatalogItem[][]): McpClient {
  let callIdx = 0;
  return {
    callTool: vi.fn(async (_name: string, args: { limit?: number; cursor?: string }): Promise<McpToolCallResult> => {
      const page = pages[Math.min(callIdx, pages.length - 1)] ?? [];
      callIdx++;
      const nextCursor = callIdx < pages.length ? String(callIdx * (args.limit ?? 200)) : undefined;
      const total = pages.reduce((sum, p) => sum + p.length, 0);
      return {
        content: [{ type: "text", text: JSON.stringify({ items: page, total, nextCursor }) }],
        structuredContent: { items: page, total, nextCursor },
      } as McpToolCallResult;
    }),
  } as unknown as McpClient;
}

/**
 * 构造典型 catalog item（对齐 mestar v0.2.0 实际返回字段）。
 *
 * 默认形态：可执行只读查询工具，含服务自带 semanticTags / exampleQueries / inputSummary / domain。
 */
function makeItem(overrides: Partial<CatalogItem> = {}): CatalogItem {
  return {
    name: "mestar.query.uempEquipBomView_FORM_Tree.uempEquipBomform.platform.select",
    legacyName: "mestar.query.uempEquipBomView_FORM_Tree.uempEquipBomform.platform.select",
    title: "设备BOM",
    displayName: "查询设备BOM清单",
    description: "查询设备的物料清单，含备件、数量、版本等信息",
    domain: "Equipment",
    subDomain: "Bom",
    semanticTags: ["设备BOM", "备件清单"],
    aliases: ["设备物料清单", "BOM"],
    exampleQueries: ["我想查设备的BOM", "看一下设备备件清单"],
    inputSummary: [
      { name: "equipmentCode", label: "设备编码", type: "string", required: true },
      { name: "bomVersion", label: "BOM版本", type: "string", required: false },
    ],
    semanticQuality: "ok",
    kind: "platformController",
    risk: "readOnly",
    executable: true,
    route: null,
    menu: { name: "设备BOM", rel: "uempEquipBomView_FORM_Tree" },
    module: { name: "Uemp", source: "entityPrefix" },
    ...overrides,
  };
}

describe("deriveSemantic（L0.2：优先服务自带 semanticTags）", () => {
  it("服务自带 semanticTags → 直接用（中文标签）", () => {
    const item = makeItem({ semanticTags: ["设备BOM", "备件清单"] });
    const tags = deriveSemantic(item);
    expect(tags).toEqual(["设备BOM", "备件清单"]);
  });

  it("无 semanticTags + 有 exampleQueries → 用 exampleQueries 派生", () => {
    const item = makeItem({
      semanticTags: undefined,
      exampleQueries: ["查设备故障", "看设备停机记录"],
    });
    const tags = deriveSemantic(item);
    expect(tags).toEqual(["查设备故障", "看设备停机记录"]);
  });

  it("无 semanticTags + 无 exampleQueries + 有 domain → domain 兜底派生", () => {
    const item = makeItem({
      semanticTags: undefined,
      exampleQueries: undefined,
      domain: "Equipment",
    });
    const tags = deriveSemantic(item);
    expect(tags).toEqual(["equipment_query"]);
  });

  it("无 semanticTags + 无 exampleQueries + 无 domain + 有 module → module 兜底", () => {
    const item = makeItem({
      semanticTags: undefined,
      exampleQueries: undefined,
      domain: undefined,
      module: { name: "Ueqc", source: "x" },
    });
    const tags = deriveSemantic(item);
    expect(tags).toEqual(["ueqc_query"]);
  });

  it("executable=false → 不派生（返回空）", () => {
    const item = makeItem({ executable: false, semanticTags: ["x"] });
    expect(deriveSemantic(item)).toEqual([]);
  });

  it("risk=businessCritical → 不派生", () => {
    const item = makeItem({ risk: "businessCritical", semanticTags: ["x"] });
    expect(deriveSemantic(item)).toEqual([]);
  });

  it("完全无语义信息 → 返回空（删除 route.method 依赖）", () => {
    const item = makeItem({
      semanticTags: undefined,
      exampleQueries: undefined,
      domain: undefined,
      module: undefined,
      // 注意：route=null 也能正常处理（L0.2 核心改造点）
      route: null,
    });
    expect(deriveSemantic(item)).toEqual([]);
  });
});

describe("deriveEnglishSemantic（L2.2：英文 snake_case key）", () => {
  it("domain + subDomain → domain_subDomain", () => {
    const item = makeItem({ domain: "Equipment", subDomain: "Bom" });
    expect(deriveEnglishSemantic(item)).toBe("equipment_bom");
  });

  it("subDomain=general → 只用 domain", () => {
    const item = makeItem({ domain: "Equipment", subDomain: "General" });
    expect(deriveEnglishSemantic(item)).toBe("equipment");
  });

  it("只有 domain → 用 domain", () => {
    const item = makeItem({ domain: "Quality", subDomain: undefined });
    expect(deriveEnglishSemantic(item)).toBe("quality");
  });

  it("executable=false → 返回 null", () => {
    const item = makeItem({ executable: false });
    expect(deriveEnglishSemantic(item)).toBeNull();
  });
});

describe("McpCatalogCache.warmup（L0.3 + L2.2）", () => {
  it("分页拉取 + 派生 + 分桶持久化（含新字段）", async () => {
    const items = [
      makeItem(), // Uemp 设备BOM 查询（executable，含富语义字段）
      makeItem({
        name: "mestar.business.uempEquipBomView_FORM_Tree.dyna_btn_default_del",
        title: "删除",
        kind: "templateAction",
        risk: "businessCritical",
        executable: false,
        semanticTags: undefined,
      }), // Uemp 删除按钮（不可执行，不进桶）
    ];
    const client = makeMockClient([items]);
    const cache = new McpCatalogCache({
      serverId: "mestar",
      client,
      cacheRoot: tmpDir,
      toolIndexPath: join(tmpDir, "tool-index.json"),
    });

    await cache.warmup();

    expect(cache.isReady()).toBe(true);

    // 模块地图正确（含 domain 统计）
    const map = cache.getModuleMap();
    expect(map).not.toBeNull();
    expect(map!.totalTools).toBe(2);
    expect(map!.totalExecutable).toBe(1);
    expect(map!.modules).toHaveLength(1);
    expect(map!.modules[0]!.name).toBe("Uemp");
    expect(map!.modules[0]!.executableCount).toBe(1);
    // domain 统计
    expect(map!.domains).toHaveLength(1);
    expect(map!.domains[0]!.name).toBe("Equipment");
    expect(map!.domains[0]!.executableCount).toBe(1);

    // 分桶只含 executable 工具
    const bucket = cache.getBucket("Uemp");
    expect(bucket).toHaveLength(1);
    expect(bucket[0]!.name).toContain("platform.select");
    // L0.3：新字段纳入 BucketItem
    expect(bucket[0]!.displayName).toBe("查询设备BOM清单");
    expect(bucket[0]!.domain).toBe("Equipment");
    expect(bucket[0]!.aliases).toEqual(["设备物料清单", "BOM"]);
    expect(bucket[0]!.exampleQueries).toEqual(["我想查设备的BOM", "看一下设备备件清单"]);
    expect(bucket[0]!.inputSummary).toHaveLength(2);
    // semanticTags 用服务自带的中文
    expect(bucket[0]!.semanticTags).toEqual(["设备BOM", "备件清单"]);

    // L2.2：tool-index.json 双 tag 体系（中文 semanticTags + 英文 entries）
    const indexRaw = readFileSync(join(tmpDir, "tool-index.json"), "utf8");
    const index = JSON.parse(indexRaw);
    // tools 数组含中文 semanticTags
    expect(index.tools.some((t: { name: string }) => t.name.includes("platform.select"))).toBe(true);
    const tool = index.tools.find((t: { name: string }) => t.name.includes("platform.select"));
    expect(tool.semanticTags).toEqual(["设备BOM", "备件清单"]);
    // entries 数组含英文 key
    expect(index.entries).toBeDefined();
    expect(index.entries.some((e: { toolName: string }) => e.toolName.includes("platform.select"))).toBe(true);
    const entry = index.entries.find((e: { toolName: string }) => e.toolName.includes("platform.select"));
    expect(entry.semantic).toBe("equipment_bom");

    // by-module 目录文件存在
    expect(existsSync(join(tmpDir, "mestar", "by-module", "Uemp.json"))).toBe(true);
  });

  it("多模块按 module 分桶 + 多 domain 统计", async () => {
    const items = [
      makeItem(), // Uemp / Equipment
      makeItem({
        name: "mestar.query.qcInspect.select",
        title: "质量检验",
        displayName: "查询质量检验记录",
        domain: "Quality",
        semanticTags: ["质量检验"],
        module: { name: "Ueqc", source: "entityPrefix" },
      }), // Ueqc / Quality
    ];
    const client = makeMockClient([items]);
    const cache = new McpCatalogCache({
      serverId: "mestar",
      client,
      cacheRoot: tmpDir,
      toolIndexPath: join(tmpDir, "tool-index.json"),
    });

    await cache.warmup();

    const map = cache.getModuleMap();
    expect(map!.modules).toHaveLength(2);
    const moduleNames = map!.modules.map((m) => m.name).sort();
    expect(moduleNames).toEqual(["Uemp", "Ueqc"]);
    // domain 统计
    expect(map!.domains).toHaveLength(2);
    const domainNames = map!.domains.map((d) => d.name).sort();
    expect(domainNames).toEqual(["Equipment", "Quality"]);

    expect(cache.getBucket("Uemp")).toHaveLength(1);
    expect(cache.getBucket("Ueqc")).toHaveLength(1);
  });

  it("findItem 按工具名查（LazyMcpActionTool 用）", async () => {
    const items = [makeItem()];
    const client = makeMockClient([items]);
    const cache = new McpCatalogCache({
      serverId: "mestar",
      client,
      cacheRoot: tmpDir,
      toolIndexPath: join(tmpDir, "tool-index.json"),
    });

    await cache.warmup();

    const found = cache.findItem("mestar.query.uempEquipBomView_FORM_Tree.uempEquipBomform.platform.select");
    expect(found).toBeDefined();
    expect(found!.inputSummary).toHaveLength(2);
    expect(found!.domain).toBe("Equipment");

    // 不存在的工具名
    expect(cache.findItem("nonexistent.tool")).toBeUndefined();
  });

  it("mestar 不可达 + 无本地缓存 → ready=false 不抛错", async () => {
    const failingClient = {
      callTool: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    } as unknown as McpClient;

    const cache = new McpCatalogCache({
      serverId: "mestar",
      client: failingClient,
      cacheRoot: tmpDir,
    });

    await cache.warmup();
    expect(cache.isReady()).toBe(false);
    expect(cache.getModuleMap()).toBeNull();
  });

  it("mestar 不可达 + 有过期缓存 → 降级用缓存 ready=true", async () => {
    // 先写一份过期缓存（含新字段）
    const cacheDir = join(tmpDir, "mestar");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(cacheDir, "by-module"), { recursive: true });
    const staleMap = {
      serverId: "mestar",
      generatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(), // 2 天前
      totalTools: 100,
      totalExecutable: 10,
      modules: [{ name: "Uemp", desc: "设备", toolCount: 100, executableCount: 10 }],
      domains: [{ name: "Equipment", toolCount: 100, executableCount: 10 }],
    };
    writeFileSync(join(cacheDir, "module-map.json"), JSON.stringify(staleMap));

    const failingClient = {
      callTool: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    } as unknown as McpClient;

    const cache = new McpCatalogCache({
      serverId: "mestar",
      client: failingClient,
      cacheRoot: tmpDir,
    });

    await cache.warmup();
    expect(cache.isReady()).toBe(true); // 降级用过期缓存
    const map = cache.getModuleMap();
    expect(map!.totalTools).toBe(100);
  });

  it("getAllBuckets 汇总全部分桶（供 EmbeddingRouter 用）", async () => {
    const items = [
      makeItem(),
      makeItem({
        name: "mestar.query.qcInspect.select",
        title: "质量检验",
        domain: "Quality",
        semanticTags: ["质量检验"],
        module: { name: "Ueqc", source: "entityPrefix" },
      }),
    ];
    const client = makeMockClient([items]);
    const cache = new McpCatalogCache({
      serverId: "mestar",
      client,
      cacheRoot: tmpDir,
      toolIndexPath: join(tmpDir, "tool-index.json"),
    });

    await cache.warmup();
    const all = cache.getAllBuckets();
    expect(all).toHaveLength(2);
  });

  it("L2.2：appendToolEntry 在线兜底回写（中文 + 英文双 tag）", async () => {
    const client = makeMockClient([[]]);
    const cache = new McpCatalogCache({
      serverId: "mestar",
      client,
      cacheRoot: tmpDir,
      toolIndexPath: join(tmpDir, "tool-index.json"),
    });
    await cache.warmup();

    // 在线兜底回写
    cache.appendToolEntry("mestar.query.newTool.select", "在线发现的新工具");

    const indexRaw = readFileSync(join(tmpDir, "tool-index.json"), "utf8");
    const index = JSON.parse(indexRaw);
    // tools 数组
    expect(index.tools.some((t: { name: string }) => t.name === "mestar.query.newTool.select")).toBe(true);
    // entries 数组
    expect(index.entries.some((e: { toolName: string }) => e.toolName === "mestar.query.newTool.select")).toBe(true);

    // 幂等：再写一次不重复
    cache.appendToolEntry("mestar.query.newTool.select", "在线发现的新工具");
    const indexRaw2 = readFileSync(join(tmpDir, "tool-index.json"), "utf8");
    const index2 = JSON.parse(indexRaw2);
    expect(index2.tools.filter((t: { name: string }) => t.name === "mestar.query.newTool.select")).toHaveLength(1);
  });

  it("warmup(force=true) 跳过 fast-path 强制全量重拉", async () => {
    // 第一次预热：拉取并持久化本地缓存
    const itemsV1 = [makeItem({ name: "tool.v1" })];
    const clientV1 = makeMockClient([itemsV1]);
    const cache = new McpCatalogCache({
      serverId: "mestar",
      client: clientV1,
      cacheRoot: tmpDir,
      toolIndexPath: join(tmpDir, "tool-index.json"),
    });
    await cache.warmup();
    expect(cache.getModuleMap()!.totalTools).toBe(1);

    // 第二次：用新 client（返回 itemsV2），但不 force → fast-path 命中，不调 mestar
    const itemsV2 = [makeItem({ name: "tool.v2" }), makeItem({ name: "tool.v2.b" })];
    const clientV2 = makeMockClient([itemsV2]);
    const cache2 = new McpCatalogCache({
      serverId: "mestar",
      client: clientV2,
      cacheRoot: tmpDir,
      toolIndexPath: join(tmpDir, "tool-index.json"),
    });
    await cache2.warmup(); // 不传 force
    // fast-path：仍是 V1 的数据（1 个工具），clientV2 没被调用
    expect(cache2.getModuleMap()!.totalTools).toBe(1);
    expect(clientV2.callTool).not.toHaveBeenCalled();

    // 第三次：force=true → 跳过 fast-path，调 clientV2 全量重拉
    await cache2.warmup(0, true);
    expect(clientV2.callTool).toHaveBeenCalled();
    expect(cache2.getModuleMap()!.totalTools).toBe(2); // V2 数据
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R8：版本感知刷新（refreshIfChanged）
// ─────────────────────────────────────────────────────────────────────────────

import { NoopVersionProvider, type CatalogVersionProvider } from "../../../src/tools/mcp/catalog-version-provider.js";

describe("refreshIfChanged（R8 版本感知刷新）", () => {
  it("无 versionProvider → 走全量刷新（向后兼容）", async () => {
    const client = makeMockClient([[makeItem()]]);
    const cache = new McpCatalogCache({
      serverId: "mestar",
      client,
      cacheRoot: tmpDir,
      toolIndexPath: join(tmpDir, "tool-index.json"),
    });
    const refreshed = await cache.refreshIfChanged();
    expect(refreshed).toBe(true);
    expect(cache.isReady()).toBe(true);
    expect(client.callTool).toHaveBeenCalled();
  });

  it("NoopVersionProvider → 也走全量刷新", async () => {
    const client = makeMockClient([[makeItem()]]);
    const cache = new McpCatalogCache({
      serverId: "mestar",
      client,
      cacheRoot: tmpDir,
      toolIndexPath: join(tmpDir, "tool-index.json"),
    });
    const refreshed = await cache.refreshIfChanged(new NoopVersionProvider());
    expect(refreshed).toBe(true);
    expect(client.callTool).toHaveBeenCalled();
  });

  it("版本未变 → 跳过刷新（不调 callTool）", async () => {
    const client = makeMockClient([[makeItem()]]);
    const cache = new McpCatalogCache({
      serverId: "mestar",
      client,
      cacheRoot: tmpDir,
      toolIndexPath: join(tmpDir, "tool-index.json"),
    });

    // 固定版本的 provider
    const provider: CatalogVersionProvider = { getVersion: async () => "v1" };

    // 第一次：版本 v1 → 全量刷新
    const r1 = await cache.refreshIfChanged(provider);
    expect(r1).toBe(true);
    expect(client.callTool).toHaveBeenCalledTimes(1);

    // 第二次：版本仍是 v1 → 跳过
    const r2 = await cache.refreshIfChanged(provider);
    expect(r2).toBe(false);
    expect(client.callTool).toHaveBeenCalledTimes(1); // 没增加
  });

  it("版本变化 → 触发全量刷新", async () => {
    const client = makeMockClient([[makeItem()]]);
    const cache = new McpCatalogCache({
      serverId: "mestar",
      client,
      cacheRoot: tmpDir,
      toolIndexPath: join(tmpDir, "tool-index.json"),
    });

    let version = "v1";
    const provider: CatalogVersionProvider = { getVersion: async () => version };

    // 第一次 v1 → 刷新
    await cache.refreshIfChanged(provider);
    expect(client.callTool).toHaveBeenCalledTimes(1);

    // 版本升到 v2 → 再次刷新
    version = "v2";
    const r = await cache.refreshIfChanged(provider);
    expect(r).toBe(true);
    expect(client.callTool).toHaveBeenCalledTimes(2);
  });

  it("provider 返回 undefined → 全量刷新（容错降级）", async () => {
    const client = makeMockClient([[makeItem()]]);
    const cache = new McpCatalogCache({
      serverId: "mestar",
      client,
      cacheRoot: tmpDir,
      toolIndexPath: join(tmpDir, "tool-index.json"),
    });

    const provider: CatalogVersionProvider = { getVersion: async () => undefined };
    const r = await cache.refreshIfChanged(provider);
    expect(r).toBe(true);
    expect(client.callTool).toHaveBeenCalled();
  });

  it("版本指纹持久化到 version.json", async () => {
    const client = makeMockClient([[makeItem()]]);
    const cache = new McpCatalogCache({
      serverId: "mestar",
      client,
      cacheRoot: tmpDir,
      toolIndexPath: join(tmpDir, "tool-index.json"),
    });

    const provider: CatalogVersionProvider = { getVersion: async () => "v1" };
    await cache.refreshIfChanged(provider);

    // version.json 应存在且含 v1
    const versionPath = join(tmpDir, "mestar", "version.json");
    expect(existsSync(versionPath)).toBe(true);
    const data = JSON.parse(readFileSync(versionPath, "utf8"));
    expect(data.fingerprint).toBe("v1");
  });
});
