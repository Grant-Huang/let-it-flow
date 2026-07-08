/**
 * 改进后 resolver 命中率测试（P0~P2 改进验证）。
 *
 * 流程：
 *   1. 全量预热 MCP catalog（force=true，触发改进后的多路 entries 写入）
 *   2. 构建 EmbeddingToolRouter 向量索引
 *   3. 装配完整解析链（Kpi → Index → Embedding → LLM）
 *   4. 对每个意图，让真实 LLM 生成 12 组不同的 semantic 候选
 *      （模拟 12 轮 LLM 编排时 nexus_tool_resolver 可能传入的 semantic）
 *   5. 对每组 semantic 跑完整 resolver 链，统计 source 分布 + 命中率
 *
 * 用法：pnpm tsx scripts/test-resolver-hitrate.ts
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
import type { BizContext, SemanticNeed } from "../src/orchestrator/types.js";

// ── 测试意图 ──
const INTENTS = [
  "找到OEE最近偏低的产线，帮我诊断原因并给改善建议",
];
const ROUNDS = 12;

// ── 结果记录 ──
interface RoundResult {
  round: number;
  semantic: string;
  description: string;
  resolved: boolean;
  source: string; // index | embedding | llm | kpi | (空)
  toolName: string;
  confidence: number;
  durationMs: number;
}
type IntentReport = {
  intent: string;
  rounds: RoundResult[];
  stats: {
    total: number;
    hit: number;
    miss: number;
    bySource: Record<string, number>;
    avgConfidence: number;
    avgDurationMs: number;
  };
};

async function main() {
  console.log("═".repeat(90));
  console.log("  resolver 命中率测试（改进后：阈值0.6 + 中文 entries + Index 归一化 + LLM 兜底 catalog）");
  console.log("═".repeat(90));

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
  console.log("\n[1/5] 连接 mestar...");
  await client.connect();
  console.log("  ✅ mestar 已连接");

  // 用 data 目录（复用已有缓存结构，但会强制刷新）
  const cacheRoot = "data/mcp-catalog-cache";
  const toolIndexPath = "data/nexusops/tool-index.json";

  // 2. 强制全量预热 MCP catalog（force=true，确保改进后的多路 entries 写入）
  console.log("\n[2/5] 强制全量预热 McpCatalogCache（写入中文 entries）...");
  const cache = new McpCatalogCache({
    serverId: "mestar",
    client,
    cacheRoot,
    toolIndexPath,
  });
  const warmupStart = Date.now();
  await cache.warmup({ force: true });
  console.log(`  ✅ 预热完成（${Date.now() - warmupStart}ms）`);
  const map = cache.getModuleMap();
  console.log(`     总工具：${map?.totalTools}，可执行：${map?.totalExecutable}`);

  // 验证中文 entries 是否写入
  const fs = await import("node:fs");
  const idx = JSON.parse(fs.readFileSync(toolIndexPath, "utf8"));
  const zhEntries = (idx.entries ?? []).filter((e: { semantic: string }) =>
    /[\u4e00-\u9fa5]/.test(e.semantic),
  );
  console.log(`     tool-index.json entries：${idx.entries?.length ?? 0} 个（其中中文 key ${zhEntries.length} 个）`);

  // 3. 预热 KPI + 构建 EmbeddingToolRouter
  console.log("\n[3/5] 预热 KPI + 构建 EmbeddingToolRouter...");
  const kpiCache = new KpiCatalogCache({ serverId: "mestar", client, cacheRoot });
  await kpiCache.warmup();
  console.log(`  ✅ KPI 目录：${kpiCache.getKpis().length} 个 KPI`);

  ensureSeedConfig();
  const llm = new LlmService({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    runtimeConfig: loadConfig(),
  });
  const embedModel = llm.embeddingModel();
  const embedder = makeAiEmbedder(embedModel);
  const embRouter = new EmbeddingToolRouter({
    cacheDir: `${cacheRoot}/mestar`,
    embedder,
  });
  const buildStart = Date.now();
  const buckets = cache.getAllBuckets();
  await embRouter.buildIndex(buckets);
  console.log(`  ✅ 向量索引构建完成（${Date.now() - buildStart}ms，${embRouter.indexSize()} 个向量）`);

  // 4. 装配解析链
  console.log("\n[4/5] 装配解析链（Kpi → Index → Embedding → LLM）...");
  const kpiResolver = new KpiResolver({ client, kpiCatalog: kpiCache });
  const agentModel = llm.model("nexus_agent");
  const compatMode = llm.compatModeFor ? llm.compatModeFor("nexus_agent") : false;
  const llmClient: LlmClient = {
    async complete(prompt: string): Promise<string> {
      const callArgs = compatMode
        ? { messages: [{ role: "user" as const, content: prompt }] }
        : {
            system: "你是工具选择助手。只返回 JSON。",
            messages: [{ role: "user" as const, content: prompt }],
          };
      const { text } = await generateText({
        model: agentModel,
        ...callArgs,
        temperature: 0,
        maxOutputTokens: 300,
      });
      return text;
    },
  };

  const registry = new ToolRegistry();

  // 对比开关：DISABLE_KPI=1 时禁用 KpiResolver（测无 KPI 短路时的命中率）
  const disableKpi = process.env.DISABLE_KPI === "1";
  const resolver = createToolResolver({
    registry,
    model: agentModel,
    compatMode,
    embeddingRouter: embRouter,
    kpiResolver: disableKpi ? undefined : kpiResolver,
    catalogBucketProvider: () => cache.getAllBuckets(),
  });
  console.log(`  ✅ 解析链就绪（KpiResolver: ${disableKpi ? "❌ 禁用" : "✅ 启用"}）`);

  // 5. 对每个意图跑 12 轮
  console.log("\n[5/5] 命中率测试（每个意图 12 轮）");
  console.log("═".repeat(90));

  const reports: IntentReport[] = [];

  for (const intent of INTENTS) {
    console.log(`\n▶ 意图：${intent}`);

    // 用 LLM 一次性生成 12 组不同的 semantic 候选（模拟 12 轮 LLM 编排的多样化输入）
    const semantics = await generateSemanticsForIntent(agentModel, intent, ROUNDS, compatMode);
    console.log(`  生成 ${semantics.length} 组 semantic 候选：`);
    for (const s of semantics) {
      console.log(`    - ${s.semantic}${s.description ? `（${s.description.slice(0, 40)}）` : ""}`);
    }

    const rounds: RoundResult[] = [];
    for (let i = 0; i < semantics.length; i++) {
      const cand = semantics[i]!;
      const need: SemanticNeed = { semantic: cand.semantic, description: cand.description };
      const ctx: BizContext = { intent };

      const resolveStart = Date.now();
      let resolved;
      try {
        resolved = await resolver.resolve(need, ctx);
      } catch (e) {
        console.log(`  [轮${i + 1}] semantic="${cand.semantic}" → 异常：${e instanceof Error ? e.message : String(e)}`);
        rounds.push({
          round: i + 1,
          semantic: cand.semantic,
          description: cand.description ?? "",
          resolved: false,
          source: "",
          toolName: "",
          confidence: 0,
          durationMs: Date.now() - resolveStart,
        });
        continue;
      }
      const ms = Date.now() - resolveStart;

      if (resolved) {
        const src = resolved.source ?? "";
        const toolName = resolved.toolName ?? "";
        const conf = resolved.confidence ?? 0;
        console.log(
          `  [轮${i + 1}] semantic="${cand.semantic}" → ✅ ${src} | ${toolName.slice(0, 50)} | conf=${conf.toFixed(3)} | ${ms}ms`,
        );
        rounds.push({
          round: i + 1,
          semantic: cand.semantic,
          description: cand.description ?? "",
          resolved: true,
          source: src,
          toolName,
          confidence: conf,
          durationMs: ms,
        });
      } else {
        console.log(`  [轮${i + 1}] semantic="${cand.semantic}" → ❌ 未命中（${ms}ms）`);
        rounds.push({
          round: i + 1,
          semantic: cand.semantic,
          description: cand.description ?? "",
          resolved: false,
          source: "",
          toolName: "",
          confidence: 0,
          durationMs: ms,
        });
      }
    }

    // 统计
    const hit = rounds.filter((r) => r.resolved).length;
    const bySource: Record<string, number> = {};
    let confSum = 0;
    let msSum = 0;
    for (const r of rounds) {
      if (r.resolved) {
        bySource[r.source] = (bySource[r.source] ?? 0) + 1;
        confSum += r.confidence;
      }
      msSum += r.durationMs;
    }
    const report: IntentReport = {
      intent,
      rounds,
      stats: {
        total: rounds.length,
        hit,
        miss: rounds.length - hit,
        bySource,
        avgConfidence: hit > 0 ? confSum / hit : 0,
        avgDurationMs: msSum / rounds.length,
      },
    };
    reports.push(report);

    console.log(`  ─ 统计：命中 ${hit}/${rounds.length}（${((hit / rounds.length) * 100).toFixed(1)}%），source 分布=${JSON.stringify(bySource)}`);
  }

  // 清理
  await client.disconnect();

  // 生成报告
  console.log("\n" + "═".repeat(90));
  console.log("  最终结果报告");
  console.log("═".repeat(90));

  let totalHit = 0;
  let totalRounds = 0;
  const totalBySource: Record<string, number> = {};

  for (const report of reports) {
    console.log(`\n■ 意图：${report.intent}`);
    console.log(`  命中率：${report.stats.hit}/${report.stats.total}（${((report.stats.hit / report.stats.total) * 100).toFixed(1)}%）`);
    console.log(`  source 分布：${JSON.stringify(report.stats.bySource)}`);
    console.log(`  平均 confidence：${report.stats.avgConfidence.toFixed(3)}`);
    console.log(`  平均耗时：${report.stats.avgDurationMs.toFixed(0)}ms`);
    console.log(`  明细：`);
    for (const r of report.rounds) {
      const status = r.resolved ? "✅" : "❌";
      const src = r.source ? `[${r.source}]` : "";
      console.log(
        `    轮${String(r.round).padStart(2, "0")} ${status} ${src} semantic="${r.semantic}" → ${r.toolName.slice(0, 50) || "(未命中)"} conf=${r.confidence.toFixed(2)}`,
      );
    }

    totalHit += report.stats.hit;
    totalRounds += report.stats.total;
    for (const [k, v] of Object.entries(report.stats.bySource)) {
      totalBySource[k] = (totalBySource[k] ?? 0) + v;
    }
  }

  console.log(`\n■ 汇总`);
  console.log(`  总命中率：${totalHit}/${totalRounds}（${((totalHit / totalRounds) * 100).toFixed(1)}%）`);
  console.log(`  总 source 分布：${JSON.stringify(totalBySource)}`);

  // 写入 JSON 报告
  const reportPath = `.tmp/resolver-hitrate-report-${Date.now()}.json`;
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync(".tmp", { recursive: true });
  writeFileSync(reportPath, JSON.stringify({ generatedAt: new Date().toISOString(), reports, summary: { totalHit, totalRounds, hitRate: totalHit / totalRounds, bySource: totalBySource } }, null, 2));
  console.log(`\n✅ 报告已写入：${reportPath}`);
}

/**
 * 用 LLM 为一个意图生成 N 组不同的 semantic 候选。
 * 模拟 nexus_tool_resolver 在 12 轮编排中可能传入的多样化 semantic。
 */
async function generateSemanticsForIntent(
  model: Parameters<Parameters<typeof generateText>[0] extends { model: infer M } ? M extends unknown ? (m: M) => void : never : never>[0] extends never ? never : never,
  intent: string,
  n: number,
  compatMode: boolean,
): Promise<Array<{ semantic: string; description?: string }>> {
  const prompt = `你是 nexus_tool_resolver 工具调用模拟器。

业务意图：${intent}

请生成 ${n} 组**不同**的 semantic 候选（模拟 12 轮 LLM 编排时可能传入的多样化 semantic）。
要求：
1. 每组 semantic 都是简短的业务术语（1-6 个词）
2. 混合使用中文和英文（约 60% 中文，40% 英文）
3. 每组 semantic 要有不同的表达方式（同义词、上位词、下位词、英文翻译等）
4. 必须真实反映"LLM 在不同上下文/不同轮次会怎么描述这个语义需求"

输出严格的 JSON 数组格式：
[{"semantic":"...","description":"..."}, ...]

不要输出其他任何内容。只输出 JSON。`;

  // DeepSeek 等不支持 developer role 的 provider，把 system 合并到 user
  const callArgs = compatMode
    ? { messages: [{ role: "user" as const, content: prompt }] }
    : {
        system: "你是工具调用模拟器，只返回 JSON。",
        messages: [{ role: "user" as const, content: prompt }],
      };
  const { text } = await generateText({
    model: model as never,
    ...callArgs,
    temperature: 0.7,
    maxOutputTokens: 800,
  });

  // 解析 JSON（容错：可能有多余文本）
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    console.warn("⚠️ LLM 未返回 JSON 数组，降级用默认 semantic");
    return [{ semantic: intent }, { semantic: "default_query" }];
  }
  try {
    const arr = JSON.parse(jsonMatch[0]) as Array<{ semantic: string; description?: string }>;
    return arr.filter((x) => x.semantic).slice(0, n);
  } catch {
    console.warn("⚠️ JSON 解析失败，降级用默认 semantic");
    return [{ semantic: intent }];
  }
}

main().catch((e) => {
  console.error("测试失败：", e);
  process.exit(1);
});
