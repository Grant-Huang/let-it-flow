import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 前端配置页面（见 docs/13-p8-config-and-observability.md §13.6）。
// dev 模式下 Vite 代理 /api 到 Hono 后端（默认 :8787）。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: process.env.LIF_BACKEND_URL ?? "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
