/**
 * KpiResolver 影响对比测试（启用 vs 禁用）。
 *
 * 用固定的 12 组 OEE semantic 候选（与 hitrate-test-oee 相同），
 * 分别在「启用 KpiResolver」和「禁用 KpiResolver」下跑完整 resolver 链，
 * 对比命中率与短路行为。
 *
 * 用法：pnpm tsx scripts/test-kpi-impact.ts
 */
import "dotenv/config";
import { McpRouter } from "../src/tools/mcp/mcp-router.js";
import { McpCatalogCache } from "../src/tools/mcp/mcp-catalog-cache.js";
import { KpiCatalogCache } from "../src/tools/mcp/kpi-catalog-cache.js";
import { KpiResolver } from "../src/orchestrator/kpi-resolver.js";
import { EmbeddingToolRouter, makeAiEmbedder } from "../src/orchestrator/embedding-router.js";
import { type LlmClient } from "../src/orchestrator/llm-resolver.js";
import { createToolResolver } from "../src/orchestrator/resolver-factory.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { LlmService } from "../src/services/llm-service.js";
import { loadConfig } from "../src/llm/config-loader.js";
import { ensureSeedConfig } from "../src/llm/seed.js";
import { generateText } from "ai";
import type { BizContext, SemanticNeed, ResolvedTool } from "../src/orchestrator/types.js";

// 固定 12 组 OEE semantic（来自 hitrate-test-oee 的 LLM 生成结果，保证对比公平）
const FIXED_SEMANTICS = [
  { semantic: "低OEE产线", description: "直接查找OEE指标偏低的产线" },
  { semantic: "OEE下滑产线", description: "识别近期OEE呈现下降趋势的产线" },
  { semantic: "设备综合效率偏低", description: "使用中文全称描述OEE偏低的设备群" },
  { semantic: "OEE below target lines", description: "筛选OEE未达目标值的产线" },
  { semantic: "产线效率诊断", description: "对低效产线进行问题诊断" },
  { semantic: "line OEE drop root cause", description: "查找产线OEE下降的根本原因" },
  { semantic: "产能损失分析", description: "以产能损失作为OEE低下的上位表达" },
  { semantic: "OEE performance gap", description: "定位实际OEE与目标之间差距显著的产线" },
  { semantic: "瓶颈产线OEE改善", description: "找出瓶颈产线并给出OEE改善建议" },
  { semantic: "低效产线排查", description: "对效率低下产线进行系统排查" },
  { semantic: "Overall Equipment Effectiveness degradation", description: "使用正式英文术语描述设备综合效率的退化" },
  { semantic: "OEE偏差原因与对策", description: "分析OEE偏差来源并提出改进措施" },
];

interface RoundResult {
  semantic: string;
  resolved: boolean;
  source: string;
  toolName: string;
  confidence: number;
  durationMs: number;
  kpiShortCircuited: boolean; // 是否被 KpiResolver 短路（source=kpi）
}

async function runRound(
  resolver: { resolve: (need: SemanticNeed, ctx: BizContext) => Promise<ResolvedTool | null> },
  semantic: string,
  description: string,
  intent: string,
): Promise<RoundResult> {
  const need: SemanticNeed = { semantic, description };
  const ctx: BizContext = { intent };
  const start = Date.now();
  try {
    const resolved = await resolver.resolve(need, ctx);
    const ms = Date.now() - start;
    if (resolved) {
      return {
        semantic,
        resolved: true,
        source: resolved.source ?? "",
        toolName: resolved.toolName ?? "",
        confidence: resolved.confidence ?? 0,
        durationMs: ms,
        kpiShortCircuited: resolved.source === "kpi",
      };
    }
    return {
      semantic,
      resolved: false,
      source: "",
      toolName: "",
      confidence: 0,
      durationMs: ms,
      kpiShortCircuited: false,
    };
  } catch (e) {
    return {
      semantic,
      resolved: false,
      source: "",
      toolName: "",
      confidence: 0,
      durationMs: Date.now() - start,
      kpiShortCircuited: false,
    };
  }
}

async function buildStack(opts: {
  enableKpi: boolean;
  client: ReturnType<McpRouter["getClient"]>;
  cache: McpCatalogCache;
  cacheRoot: string;
  llm: LlmService;
}) {
  const { enableKpi, client, cache, cacheRoot, llm } = opts;

  // KPI 缓存
  const kpiCache = new KpiCatalogCache({ serverId: "mestar", client, cacheRoot });
  await kpiCache.warmup();

  // Embedding
  const embedModel = llm.embeddingModel();
  const embedder = makeAiEmbedder(embedModel);
  const embRouter = new EmbeddingToolRouter({ cacheDir: `${cacheRoot}/mestar`, embedder });
  const buckets = cache.getAllBuckets();
  await embRouter.buildIndex(buckets);

  // resolver 链
  const kpiResolver = enableKpi ? new KpiResolver({ client, kpiCatalog: kpiCache }) : undefined;
  const agentModel = llm.model("nexus_agent");
  const compatMode = llm.compatModeFor ? llm.compatModeFor("nexus_agent") : false;
  const registry = new ToolRegistry();
  const resolver = createToolResolver({
    registry,
    model: agentModel,
    compatMode,
    embeddingRouter: embRouter,
    kpiResolver,
    catalogBucketProvider: () => cache.getAllBuckets(),
  });
  return { resolver, embRouter };
}

async function main() {
  console.log("═".repeat(90));
  console.log("  KpiResolver 影响对比测试（启用 vs 禁用）");
  console.log("  意图：找到OEE最近偏低的产线，帮我诊断原因并给改善建议");
  console.log("═".repeat(90));

  const raw = process.env.NEXUS_MCP_SERVERS;
  if (!raw) {
    console.error("❌ NEXUS_MCP_SERVERS 未配置");
    process.exit(1);
  }
  const configs = JSON.parse(raw);
  const router = new McpRouter(configs);
  const client = router.getClient("mestar")!;
  await client.connect();
  console.log("✅ mestar 已连接\n");

  const cacheRoot = "data/mcp-catalog-cache";
  const cache = new McpCatalogCache({
    serverId: "mestar",
    client,
    cacheRoot,
    toolIndexPath: "data/nexusops/tool-index.json",
  });
  await cache.warmup({ force: true });
  console.log(`✅ catalog 预热：${cache.getModuleMap()?.totalTools} 工具\n`);

  ensureSeedConfig();
  const llm = new LlmService({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    runtimeConfig: loadConfig(),
  });

  const intent = "找到OEE最近偏低的产线，帮我诊断原因并给改善建议";

  // ── 场景 A：启用 KpiResolver ──
  console.log("▶ 场景 A：启用 KpiResolver（当前默认）");
  const stackA = await buildStack({ enableKpi: true, client, cache, cacheRoot, llm });
  const resultsA: RoundResult[] = [];
  for (const { semantic, description } of FIXED_SEMANTICS) {
    const r = await runRound(stackA.resolver, semantic, description, intent);
    const tag = r.resolved ? `✅ ${r.source}` : "❌";
    const short = r.kpiShortCircuited ? " [KPI短路]" : "";
    console.log(`  ${tag}${short} semantic="${semantic}" → ${r.toolName.slice(0, 50) || "(未命中)"} | ${r.durationMs}ms`);
    resultsA.push(r);
  }
  await stackA.embRouter["dispose" as never]?.();

  // ── 场景 B：禁用 KpiResolver ──
  console.log("\n▶ 场景 B：禁用 KpiResolver（纯 Index/Embedding/LLM）");
  const stackB = await buildStack({ enableKpi: false, client, cache, cacheRoot, llm });
  const resultsB: RoundResult[] = [];
  for (const { semantic, description } of FIXED_SEMANTICS) {
    const r = await runRound(stackB.resolver, semantic, description, intent);
    const tag = r.resolved ? `✅ ${r.source}` : "❌";
    console.log(`  ${tag} semantic="${semantic}" → ${r.toolName.slice(0, 50) || "(未命中)"} | ${r.durationMs}ms`);
    resultsB.push(r);
  }

  await client.disconnect();

  // ── 对比报告 ──
  console.log("\n" + "═".repeat(90));
  console.log("  对比结果");
  console.log("═".repeat(90));

  const hitA = resultsA.filter((r) => r.resolved).length;
  const hitB = resultsB.filter((r) => r.resolved).length;
  const shortA = resultsA.filter((r) => r.kpiShortCircuited).length;
  const bySourceA: Record<string, number> = {};
  const bySourceB: Record<string, number> = {};
  for (const r of resultsA) if (r.resolved) bySourceA[r.source] = (bySourceA[r.source] ?? 0) + 1;
  for (const r of resultsB) if (r.resolved) bySourceB[r.source] = (bySourceB[r.source] ?? 0) + 1;

  console.log(`\n┌────────────────────┬──────────────────┬──────────────────┐`);
  console.log(`│ 指标               │ A: 启用 Kpi      │ B: 禁用 Kpi      │`);
  console.log(`├────────────────────┼──────────────────┼──────────────────┤`);
  console.log(`│ 命中数             │ ${String(hitA).padStart(6)} / 12      │ ${String(hitB).padStart(6)} / 12      │`);
  console.log(`│ 命中率             │ ${((hitA / 12) * 100).toFixed(1).padStart(5)}%        │ ${((hitB / 12) * 100).toFixed(1).padStart(5)}%        │`);
  console.log(`│ KPI 短路次数       │ ${String(shortA).padStart(6)}          │ ${String(0).padStart(6)}          │`);
  console.log(`│ source 分布        │ ${JSON.stringify(bySourceA).padEnd(14)} │ ${JSON.stringify(bySourceB).padEnd(14)} │`);
  console.log(`└────────────────────┴──────────────────┴──────────────────┘`);

  console.log("\n明细对比（逐轮）：");
  console.log("┌────┬──────────────────────────────────────────────┬────────────────────────┬────────────────────────┐");
  console.log("│ 轮 │ semantic                                     │ A(启用Kpi)             │ B(禁用Kpi)             │");
  console.log("├────┼──────────────────────────────────────────────┼────────────────────────┼────────────────────────┤");
  for (let i = 0; i < FIXED_SEMANTICS.length; i++) {
    const a = resultsA[i]!;
    const b = resultsB[i]!;
    const sem = FIXED_SEMANTICS[i]!.semantic.padEnd(44);
    const aStr = (a.resolved ? `✅${a.source}` : "❌").padEnd(22);
    const bStr = (b.resolved ? `✅${b.source}` : "❌").padEnd(22);
    console.log(`│ ${String(i + 1).padStart(2)} │ ${sem} │ ${aStr} │ ${bStr} │`);
  }
  console.log("└────┴──────────────────────────────────────────────┴────────────────────────┴────────────────────────┘");

  // 写报告
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(".tmp", { recursive: true });
  const reportPath = `.tmp/kpi-impact-compare-${Date.now()}.json`;
  writeFileSync(
    reportPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        intent,
        enableKpi: { hit: hitA, total: 12, hitRate: hitA / 12, bySource: bySourceA, kpiShortCircuited: shortA, rounds: resultsA },
        disableKpi: { hit: hitB, total: 12, hitRate: hitB / 12, bySource: bySourceB, rounds: resultsB },
      },
      null,
      2,
    ),
  );
  console.log(`\n✅ 报告已写入：${reportPath}`);
}

main().catch((e) => {
  console.error("测试失败：", e);
  process.exit(1);
});
