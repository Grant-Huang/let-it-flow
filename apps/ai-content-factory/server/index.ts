/**
 * AI Content Factory HTTP 入口（应用层 —— 端口 8789）。
 *
 * 启动流程（对齐 apps/nexusops/server/index.ts 范式）：
 *   1. bootAiContentFactory() 装配 harness + 工具集 + KB + precondition/governance
 *   2. 用装配产出的 taskRuntime 构造 TaskRegistry（注入 customRunner）
 *   3. 复用平台 createApp(registry) 挂载全部 /api/* 路由（SSE/HITL/配置等）
 *   4. @hono/node-server 绑定 AICF_PORT（缺省 8789）
 *
 * 复用关系：HTTP 层完全复用平台内核（workflows/tasks/tools/config），
 *           应用只贡献"装配"和"运行时内容"。
 */
import { serve } from "@hono/node-server";
import { createApp } from "../../../src/api/app.js";
import { TaskRegistry } from "../../../src/tasks/registry.js";
import { getDataDir } from "../../../src/core/config.js";
import { bootAiContentFactory } from "./boot.js";

async function main(): Promise<void> {
  const runtime = await bootAiContentFactory();

  // 用装配好的 taskRuntime 构造 TaskRegistry（customRunner 接管执行）
  const registry = new TaskRegistry(undefined, runtime.taskRuntime);

  // 复用平台 createApp，挂载全部 /api/* 路由
  const app = createApp(registry);

  const port = Number(process.env.AICF_PORT ?? process.env.PORT ?? "8789");
  const toolCount = runtime.toolRegistry.list().length;

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[ai-content-factory] HTTP server on http://localhost:${info.port}`);
    console.log(`[ai-content-factory] data dir: ${getDataDir()}`);
    console.log(`[ai-content-factory] tools: ${toolCount}（core + skill）`);
    console.log(
      `[ai-content-factory] KB providers: ${runtime.knowledgeProviders.map((p) => p.id).join(", ") || "(none)"}`,
    );
    console.log(`[ai-content-factory] endpoints:`);
    console.log(`  GET  /health`);
    console.log(`  POST /api/workflows      （提交意图，ReAct harness 执行）`);
    console.log(`  GET  /api/tasks`);
    console.log(`  GET  /api/tasks/:id`);
    console.log(`  GET  /api/tasks/:id/stream (SSE)`);
    console.log(`  POST /api/tasks/:id/confirm  (HITL 确认门)`);
    console.log(`  POST /api/tasks/:id/clarify  (Guardrail 澄清)`);
    console.log(`  GET  /api/tools          （工具清单）`);
    console.log(`  *   /api/config/*        （模型/绑定/系统配置）`);
  });
}

main().catch((err) => {
  console.error("[ai-content-factory] 启动失败：", err);
  process.exit(1);
});
