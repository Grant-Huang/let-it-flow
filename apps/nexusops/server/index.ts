/**
 * NexusOps HTTP 入口（应用层 —— 端口 8788）。
 *
 * 启动流程：
 *   1. bootNexusOps() 装配 harness + 工具集 + KB + 三源 + precondition/governance
 *   2. 用装配产出的 taskRuntime 构造 TaskRegistry（注入 customRunner）
 *   3. 复用平台 createApp(registry) 挂载全部 /api/* 路由（SSE/HITL/配置等）
 *   4. @hono/node-server 绑定 NEXUS_PORT（缺省 8788）
 *
 * 复用关系：HTTP 层完全复用平台内核（workflows/tasks/tools/config），
 *           应用只贡献"装配"和"运行时内容"。
 */
import { serve } from "@hono/node-server";
import { createApp } from "../../../src/api/app.js";
import { TaskRegistry } from "../../../src/tasks/registry.js";
import { getDataDir, resolveAppDataDir } from "../../../src/core/config.js";
import { NEXUS_PORT } from "../../../src/core/ports.js";
import { bootNexusOps } from "./boot.js";
import { createReportTemplatesApp } from "./api-report-templates.js";

async function main(): Promise<void> {
  // 每个 App 默认用独立 dataDir（./data/nexusops），实现 tasks/config 历史会话隔离；
  // 设了 LIF_DATA_DIR 则尊重用户配置（向后兼容全局共享 ./data 的形态）
  const runtime = await bootNexusOps({ dataDir: resolveAppDataDir("nexusops") });

  // 用装配好的 taskRuntime 构造 TaskRegistry（customRunner 接管执行）
  const registry = new TaskRegistry(undefined, runtime.taskRuntime);

  // 复用平台 createApp，挂载全部 /api/* 路由
  const app = createApp(registry);

  // 应用层路由：报表固化模板（依赖 NexusRuntime.skillRegistry）
  app.route("/api/report-templates", createReportTemplatesApp(runtime.skillRegistry));

  const port = NEXUS_PORT;
  const toolCount = runtime.toolRegistry.list().length;

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[nexusops] HTTP server on http://localhost:${info.port}`);
    console.log(`[nexusops] data dir: ${getDataDir()}`);
    console.log(`[nexusops] tools: ${toolCount}（core + domain + skill + mcp）`);
    console.log(`[nexusops] KB providers: ${runtime.knowledgeProviders.map((p) => p.id).join(", ") || "(none)"}`);
    console.log(`[nexusops] MCP servers: ${runtime.mcpRouter.listServerIds().join(", ") || "(none)"}`);
    console.log(`[nexusops] endpoints:`);
    console.log(`  GET  /health`);
    console.log(`  POST /api/workflows      （提交意图，ReAct harness 执行）`);
    console.log(`  GET  /api/tasks`);
    console.log(`  GET  /api/tasks/:id`);
    console.log(`  GET  /api/tasks/:id/stream (SSE)`);
    console.log(`  POST /api/tasks/:id/confirm  (HITL 确认门)`);
    console.log(`  POST /api/tasks/:id/clarify  (Guardrail 澄清)`);
    console.log(`  GET  /api/tools          （工具清单）`);
    console.log(`  *   /api/config/*        （模型/绑定/系统配置）`);
    console.log(`  *   /api/report-templates/* （报表固化模板 CRUD）`);
  });
}

main().catch((err) => {
  console.error("[nexusops] 启动失败：", err);
  process.exit(1);
});
