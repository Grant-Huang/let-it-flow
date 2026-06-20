import { defineConfig } from "vitest/config";

/**
 * E2E 测试专用 vitest 配置（含 tests/e2e/，默认主配置排除）。
 *
 * 用法：
 *   npx vitest run --config vitest.e2e.config.ts
 *   npx vitest run --config vitest.e2e.config.ts tests/e2e/test-v4-baseline.ts
 */
export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.ts"],
    exclude: ["node_modules/**"],
    // NexusOps e2e 单链路 ~70s（DeepSeek 多步 ReAct）+ 判官 ~15s，
    // 原 60s 不够；这里放宽到 180s，hookTimeout 给 bootNexusOps 初始化。
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
