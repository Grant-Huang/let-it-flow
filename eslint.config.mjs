import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "reference/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // 允许 return-only 的 async generator（合法的"无事件工具"模式：
      // 工具可能只产出最终 ToolResult 而不流式 yield 事件，如 web_fetch 的简化形态）
      "require-yield": "off",
    },
  },
);
