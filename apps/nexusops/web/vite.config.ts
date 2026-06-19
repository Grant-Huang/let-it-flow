import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// NexusOps 消费应用前端（运营智能分析）。
// dev 模式下 Vite 代理 /api 到 NexusOps Hono 后端（默认 :8788）。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      "/api": {
        target: process.env.NEXUS_BACKEND_URL ?? "http://localhost:8788",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
