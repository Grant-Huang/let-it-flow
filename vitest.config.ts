import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.ts"],
    exclude: ["tests/e2e/**", "node_modules/**"],
    testTimeout: 10_000,
  },
});
