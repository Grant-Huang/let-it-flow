/**
 * KpiResolver 短路诊断脚本。
 *
 * 测试 semantic="oee"（精确命中 KPI）时 KpiResolver 的实际行为：
 *   - 是否命中 KPI 目录
 *   - assess 返回 calculable=true 还是 false
 *   - 是否短路（返回 kpi.unavailable.oee）还是放行（返回 null）
 */
import "dotenv/config";
import { McpRouter } from "../src/tools/mcp/mcp-router.js";
import { KpiCatalogCache } from "../src/tools/mcp/kpi-catalog-cache.js";
import { KpiResolver } from "../src/orchestrator/kpi-resolver.js";
import type { BizContext, SemanticNeed } from "../src/orchestrator/types.js";

const TEST_SEMANTICS = [
  "oee",
  "设备综合效率",
  "设备效率",
  "throughput",
  "产出效率",
  "planAchievement",
  "计划达成率",
  "downtime",
  "停机统计",
];

async function main() {
  const raw = process.env.NEXUS_MCP_SERVERS;
  if (!raw) {
    console.error("❌ NEXUS_MCP_SERVERS 未配置");
    process.exit(1);
  }
  const configs = JSON.parse(raw);
  const router = new McpRouter(configs);
  const client = router.getClient("mestar")!;

  console.log("连接 mestar...");
  await client.connect();

  const kpiCache = new KpiCatalogCache({
    serverId: "mestar",
    client,
    cacheRoot: "data/mcp-catalog-cache",
  });
  await kpiCache.warmup();
  console.log(`KPI 目录：${kpiCache.getKpis().length} 个`);
  console.log("");

  const kpiResolver = new KpiResolver({ client, kpiCatalog: kpiCache });

  console.log("═".repeat(90));
  console.log("  KpiResolver 短路诊断（看每个 semantic 命中 KPI 后的行为）");
  console.log("═".repeat(90));

  for (const semantic of TEST_SEMANTICS) {
    // 先看 findBySemantic 命中哪个 KPI
    const kpi = kpiCache.findBySemantic(semantic);
    if (!kpi) {
      console.log(`\n▶ semantic="${semantic}"`);
      console.log(`  findBySemantic: 未命中 KPI 目录（放行给后续 resolver）`);
      continue;
    }

    console.log(`\n▶ semantic="${semantic}"`);
    console.log(`  findBySemantic: 命中 KPI id=${kpi.id}, label=${kpi.label ?? "(无)"}`);

    // 实际走 resolve（修复后会真实调 assess/guide）
    const need: SemanticNeed = { semantic };
    const ctx: BizContext = {};
    const resolveStart = Date.now();
    try {
      const resolved = await kpiResolver.resolve(need, ctx);
      const ms = Date.now() - resolveStart;
      if (resolved) {
        console.log(`  resolve 结果: ⛔ 短路（${ms}ms）`);
        console.log(`    toolName: ${resolved.toolName}`);
        console.log(`    source: ${resolved.source}`);
        console.log(`    confidence: ${resolved.confidence}`);
        if (resolved.composite) {
          console.log(`    composite.kind: ${resolved.composite.kind}`);
          console.log(`    composite.guidance: ${resolved.composite.guidance?.slice(0, 200)}`);
          if (resolved.composite.gaps?.length) console.log(`    composite.gaps: ${JSON.stringify(resolved.composite.gaps).slice(0, 200)}`);
          if (resolved.composite.warnings?.length) console.log(`    composite.warnings: ${JSON.stringify(resolved.composite.warnings).slice(0, 150)}`);
          console.log(`    composite.readinessStatus: ${resolved.composite.readinessStatus}`);
          console.log(`    composite.mcpToolCount: ${resolved.composite.mcpToolCount}`);
          console.log(`    composite.javaEvidenceCount: ${resolved.composite.javaEvidenceCount}`);
        }
      } else {
        console.log(`  resolve 结果: ✅ 放行（${ms}ms，返回 null，让后续 resolver 找工具）`);
      }
    } catch (e) {
      console.log(`  resolve 结果: ❌ 异常（${e instanceof Error ? e.message : String(e)}）`);
    }
  }

  await client.disconnect();
  console.log("\n✅ 诊断完成");
}

main().catch((e) => {
  console.error("诊断失败：", e);
  process.exit(1);
});
