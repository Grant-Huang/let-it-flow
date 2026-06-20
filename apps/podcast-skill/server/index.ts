/**
 * Podcast-Skill HTTP 入口（应用层 —— 端口 8789）。
 */
import { serve } from "@hono/node-server";
import { createApp } from "../../../src/api/app.js";
import { TaskRegistry } from "../../../src/tasks/registry.js";
import { getDataDir } from "../../../src/core/config.js";
import { bootPodcastSkill } from "./boot.js";

async function main(): Promise<void> {
  const runtime = await bootPodcastSkill();
  const registry = new TaskRegistry(undefined, runtime.taskRuntime);
  const app = createApp(registry);

  const port = Number(process.env.PODCAST_PORT ?? process.env.PORT ?? "8789");
  const toolCount = runtime.toolRegistry.list().length;

  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`[podcast-skill] HTTP server on http://localhost:${info.port}`);
    console.log(`[podcast-skill] data dir: ${getDataDir()}`);
    console.log(`[podcast-skill] tools: ${toolCount}（core + skill + finalize）`);
    console.log(
      `[podcast-skill] KB providers: ${runtime.knowledgeProviders.map((p) => p.id).join(", ") || "(none)"}`,
    );
  });
}

main().catch((err) => {
  console.error("[podcast-skill] 启动失败：", err);
  process.exit(1);
});
