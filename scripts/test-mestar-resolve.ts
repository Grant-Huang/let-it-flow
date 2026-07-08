/**
 * 真实 mestar 解析链测试脚本。
 *
 * 用真实 mestar 服务 + 真实 Embedding，测一条业务意图能否被解析到合适的 MCP 工具。
 *
 * 用法：
 *   pnpm tsx scripts/test-mestar-resolve.ts
 *
 * 测试意图："分析一下各订单的完成情况"
 * 预期：解析到查询订单/工单完成情况的 mestar catalog 工具。
 */
import "dotenv/config";
import { McpRouter } from "../src/tools/mcp/mcp-router.js";
import { McpCatalogCache } from "../src/tools/mcp/mcp-catalog-cache.js";
import { KpiCatalogCache } from "../src/tools/mcp/kpi-catalog-cache.js";
import { KpiResolver } from "../src/orchestrator/kpi-resolver.js";
import { EmbeddingToolRouter, makeAiEmbedder } from "../src/orchestrator/embedding-router.js";
import { type LlmClient } from "../src/orchestrator/llm-resolver.js";
import { CatalogSearchResolver } from "../src/orchestrator/catalog-search-resolver.js";
import { createToolResolver } from "../src/orchestrator/resolver-factory.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { LlmService } from "../src/services/llm-service.js";
import { loadConfig } from "../src/llm/config-loader.js";
import { ensureSeedConfig } from "../src/llm/seed.js";
import { generateText } from "ai";
import type { BizContext, SemanticNeed } from "../src/orchestrator/types.js";

// ── 测试意图 ──
const TEST_INTENT = "分析一下各订单的完成情况";

// 从意图中提取候选 semantic（LLM 视角会产出的语义标识）
// 实际运行时由 nexus_tool_resolver 调用，这里我们模拟几个可能的 semantic
const CANDIDATE_SEMANTICS = [
  { semantic: "order_completion", description: "查询订单完成情况、订单状态、完工率" },
  { semantic: "work_order_status", description: "工单完成状态、工单进度" },
  { semantic: "订单完成情况", description: TEST_INTENT },  // 中文 semantic（测中文 Embedding）
];

async function main() {
  console.log("═".repeat(80));
  console.log(`测试意图：${TEST_INTENT}`);
  console.log("═".repeat(80));

  // 1. 连接 mestar
  const raw = process.env.NEXUS_MCP_SERVERS;
  if (!raw) {
    console.error("❌ NEXUS_MCP_SERVERS 未配置");
    process.exit(1);
  }
  const configs = JSON.parse(raw);
  const mestarCfg = configs.find((c: { id: string }) => c.id === "mestar");
  if (!mestarCfg) {
    console.error("❌ 未找到 mestar server 配置");
    process.exit(1);
  }

  const router = new McpRouter(configs);
  const client = router.getClient("mestar")!;
  console.log("\n[1/6] 连接 mestar...");
  await client.connect();
  console.log("  ✅ mestar 已连接");

  // 临时目录（缓存隔离，避免污染正式 data 目录）
  const tmpRoot = `.tmp/mestar-resolve-test-${Date.now()}`;
  const { mkdirSync } = await import("node:fs");
  mkdirSync(tmpRoot, { recursive: true });

  // 2. 预热 catalog 缓存
  console.log("\n[2/6] 预热 McpCatalogCache...");
  const cache = new McpCatalogCache({
    serverId: "mestar",
    client,
    cacheRoot: tmpRoot,
    toolIndexPath: `${tmpRoot}/tool-index.json`,
  });
  const warmupStart = Date.now();
  await cache.warmup();
  console.log(`  ✅ 预热完成（${Date.now() - warmupStart}ms）`);
  const map = cache.getModuleMap();
  console.log(`     总工具：${map?.totalTools}，可执行：${map?.totalExecutable}`);
  console.log(`     模块数：${map?.modules.length}，业务域数：${map?.domains.length}`);
  console.log(`     Top 5 业务域：`);
  for (const d of (map?.domains ?? []).slice(0, 5)) {
    console.log(`       - ${d.name}：${d.executableCount} 个可查询工具`);
  }

  // 3. 预热 KPI 目录
  console.log("\n[3/6] 预热 KpiCatalogCache...");
  const kpiCache = new KpiCatalogCache({ serverId: "mestar", client, cacheRoot: tmpRoot });
  await kpiCache.warmup();
  console.log(`  ✅ KPI 目录：${kpiCache.getKpis().length} 个 KPI`);
  if (kpiCache.getKpis().length > 0) {
    console.log("     KPI 列表：");
    for (const k of kpiCache.getKpis().slice(0, 10)) {
      console.log(`       - ${k.id}（${k.label}）`);
    }
  }

  // 4. 构建 EmbeddingToolRouter
  console.log("\n[4/6] 构建 EmbeddingToolRouter 向量索引...");
  ensureSeedConfig();
  const llm = new LlmService({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    runtimeConfig: loadConfig(),
  });
  const embedModel = llm.embeddingModel();
  const embedder = makeAiEmbedder(embedModel);
  const embRouter = new EmbeddingToolRouter({
    cacheDir: `${tmpRoot}/mestar`,
    embedder,
  });
  const buildStart = Date.now();
  const buckets = cache.getAllBuckets();
  await embRouter.buildIndex(buckets);
  console.log(`  ✅ 向量索引构建完成（${Date.now() - buildStart}ms，${embRouter.indexSize()} 个向量）`);

  // 5. 装配完整解析链
  console.log("\n[5/6] 装配解析链（KpiResolver → Index → Embedding → LLM → CatalogSearch）...");
  const kpiResolver = new KpiResolver({ client, kpiCatalog: kpiCache });

  // LLM client 包装（供 LlmToolResolver 兜底）
  const agentModel = llm.model("nexus_agent");
  const compatMode = llm.compatModeFor ? llm.compatModeFor("nexus_agent") : false;
  const llmClient: LlmClient = {
    async complete(prompt: string): Promise<string> {
      const callArgs = compatMode
        ? { messages: [{ role: "user" as const, content: prompt }] }
        : { system: "你是工具选择助手。只返回 JSON。", messages: [{ role: "user" as const, content: prompt }] };
      const { text } = await generateText({ model: agentModel, ...callArgs, temperature: 0, maxOutputTokens: 300 });
      return text;
    },
  };

  // 用空 registry（mestar 工具不进 registry，走 catalog 模式）
  const registry = new ToolRegistry();

  const resolver = createToolResolver({
    registry,
    model: agentModel,
    compatMode,
    embeddingRouter: embRouter,
    kpiResolver,
  });

  // 单独构造 CatalogSearchResolver（在线兜底，createToolResolver 没包含它）
  const searchResolver = new CatalogSearchResolver({
    serverId: "mestar",
    client,
    onResolved: (toolName, semantic) => {
      cache.appendToolEntry(toolName, semantic);
    },
  });

  console.log("  ✅ 解析链就绪");

  // 6. 逐个测试候选 semantic
  console.log("\n[6/6] 测试解析链（对每个候选 semantic 跑全链路）");
  console.log("═".repeat(80));

  for (const { semantic, description } of CANDIDATE_SEMANTICS) {
    console.log(`\n▶ 测试 semantic="${semantic}"`);
    console.log(`  描述：${description}`);

    const need: SemanticNeed = { semantic, description, required: true };
    const ctx: BizContext = { intent: TEST_INTENT };

    // 走完整解析链
    const resolveStart = Date.now();
    let resolved = await resolver.resolve(need, ctx);
    const resolveMs = Date.now() - resolveStart;
    let resolverChain = "CompositeToolResolver（KpiResolver → Index → Embedding → LLM）";

    // 主链未命中 → 试 CatalogSearchResolver 在线兜底
    if (!resolved) {
      const searchStart = Date.now();
      resolved = await searchResolver.resolve(need, ctx);
      const searchMs = Date.now() - searchStart;
      resolverChain = `CatalogSearchResolver 在线兜底（${searchMs}ms）`;
    }

    if (resolved) {
      console.log(`  ✅ 命中（${resolveMs}ms，链路：${resolverChain}）`);
      console.log(`     toolName: ${resolved.toolName}`);
      console.log(`     source: ${resolved.source}`);
      console.log(`     confidence: ${resolved.confidence.toFixed(3)}`);
      if (resolved.composite) {
        console.log(`     composite.kind: ${resolved.composite.kind}`);
        console.log(`     composite.guidance: ${resolved.composite.guidance}`);
      } else {
        // 查 catalog item 详情
        const item = cache.findItem(resolved.toolName);
        if (item) {
          console.log(`     displayName: ${item.displayName ?? "(无)"}`);
          console.log(`     domain: ${item.domain ?? "(无)"} / subDomain: ${item.subDomain ?? "(无)"}`);
          console.log(`     semanticTags: ${JSON.stringify(item.semanticTags ?? [])}`);
          if (item.aliases?.length) console.log(`     aliases: ${JSON.stringify(item.aliases)}`);
          if (item.exampleQueries?.length) console.log(`     exampleQueries: ${JSON.stringify(item.exampleQueries.slice(0, 2))}`);
          if (item.inputSummary?.length) {
            console.log(`     inputSummary（${item.inputSummary.length} 个字段）:`);
            for (const f of item.inputSummary.slice(0, 5)) {
              console.log(`       - ${f.name}（${f.label}，${f.type}${f.required ? ",必填" : ""}）`);
            }
          }
        }
      }
    } else {
      console.log(`  ❌ 未命中（${resolveMs}ms，全链路均未找到匹配工具）`);
    }
  }

  // 额外：直接用 Embedding 检索 top-5，看哪些工具最相关（诊断用）
  console.log("\n" + "═".repeat(80));
  console.log("[诊断] Embedding 直接检索 top-5（query=订单完成情况）");
  console.log("═".repeat(80));
  const diagQuery = "查询订单完成情况 工单状态 完工率 production order completion";
  const candidates = await embRouter.retrieve(diagQuery, 5);
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!;
    console.log(`  ${i + 1}. [score=${c.score.toFixed(3)}] ${c.name}`);
    const item = cache.findItem(c.name);
    if (item) {
      console.log(`     displayName: ${item.displayName ?? c.title}`);
      console.log(`     domain: ${item.domain ?? "(无)"}`);
      if (item.exampleQueries?.length) {
        console.log(`     exampleQueries: ${JSON.stringify(item.exampleQueries.slice(0, 2))}`);
      }
    }
  }

  // 清理
  await client.disconnect();
  console.log("\n✅ 测试完成");
}

main().catch((e) => {
  console.error("测试失败：", e);
  process.exit(1);
});
