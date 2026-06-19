import { Hono } from "hono";
import type { TaskRegistry } from "../tasks/registry.js";
import type { ToolTier } from "../tools/base.js";

/**
 * 工具清单路由：
 *   GET /api/tools        —— 列出全部已注册工具的契约清单（forPlanner 序列化）
 *   GET /api/tools?tier=X —— 按 tier 过滤（core | domain | custom）
 *
 * 返回工具契约（name/tier/description/whenToUse/inputSchema/outputSchema/outputExample），
 * 剥离 execute。供调试、外部消费、planner LLM 注入。
 */
export function createToolsApp(registry: TaskRegistry): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const toolReg = registry.getToolRegistry();
    if (!toolReg) {
      return c.json({ status: "error", message: "tool registry not configured" }, 503);
    }
    const tierParam = c.req.query("tier");
    const tiers = tierParam ? (tierParam.split(",") as ToolTier[]) : undefined;
    // 校验 tier 参数合法性
    const validTiers: ToolTier[] = ["core", "domain", "custom"];
    if (tiers) {
      for (const t of tiers) {
        if (!validTiers.includes(t)) {
          return c.json({ status: "error", message: `invalid tier: ${t}` }, 400);
        }
      }
    }
    const tools = toolReg.forPlanner(tiers);
    return c.json({ status: "success", data: { tools, count: tools.length } });
  });

  return app;
}
