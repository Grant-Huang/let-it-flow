import http from "node:http";
import { bootPodcastSkill } from "./boot.js";

/**
 * 启动 podcast-skill HTTP 服务。
 * 监听 port 8789（仿 nexusops 的 8788）。
 */
async function startServer() {
  const port = process.env.PORT ? parseInt(process.env.PORT) : 8789;

  const { customRunner } = await bootPodcastSkill();

  const server = http.createServer(async (req, res) => {
    // CORS 头
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "podcast-skill" }));
      return;
    }

    if (req.url === "/run" && req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });

      req.on("end", async () => {
        try {
          const { intent } = JSON.parse(body);

          // 简单实现：收集输出流并返回
          const outputs: any[] = [];
          const emitter = (event: string, data: any) => {
            outputs.push({ event, data });
          };

          const result = await customRunner(intent);
          outputs.push({ event: "finish", data: result });

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true, outputs }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: false, error: String(err) }));
        }
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(port, () => {
    console.log(`Podcast-skill server listening on port ${port}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start podcast-skill server:", err);
  process.exit(1);
});
