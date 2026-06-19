import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// podcast-generator 消费应用前端（见 docs/14-podcast-generator-frontend.md）。
// dev 模式下 Vite 代理 /api 到 Hono 后端（默认 :8787）。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
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
