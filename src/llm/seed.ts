import { loadConfig, saveConfig } from "./config-loader.js";
import { CALL_SITES, type CallSite } from "./call-sites.js";
import { getDataDir } from "../core/config.js";

/**
 * 首次启动 seed（见 docs/13-p8-config-and-observability.md §13.10 P8.5）。
 *
 * 当 registry 为空（未配置任何模型）时，从当前 .env 派生一个默认 endpoint，
 * 并把全部 6 个调用点绑定到该 endpoint。这样旧的 .env 单 key 部署迁移后
 * 无需手动配置即可继续运行；用户之后可到 /models 页面调整。
 *
 * 已有 registry 内容时跳过（不覆盖用户配置）。
 *
 * @returns true 表示本次生成了 seed；false 表示已有配置，跳过。
 */
export function ensureSeedConfig(dataDir: string = getDataDir()): boolean {
  const cfg = loadConfig(dataDir);
  if (cfg.registry.list().length > 0) {
    return false;
  }

  const baseURL = process.env.OPENAI_BASE_URL;
  const provider = baseURL ? "openai-compatible" : "openai";
  const alias = baseURL ? "default-openai-compatible" : "default-openai";
  const modelId =
    process.env.OPENAI_MODEL?.replace(/^openai\//, "") ?? "gpt-4o";

  cfg.registry.add({
    alias,
    provider,
    modelId,
    ...(baseURL ? { baseURL } : {}),
    apiKeyEnv: "OPENAI_API_KEY",
    capabilities: ["chat", "structured"],
    enabled: true,
  });

  // 6 个调用点默认绑定到该 endpoint
  for (const cs of CALL_SITES) {
    cfg.bindings.set(cs, {
      callSite: cs as CallSite,
      modelAlias: alias,
      params: {},
      robustGuard: false,
    });
  }

  saveConfig(dataDir, cfg.registry, Array.from(cfg.bindings.values()));
  console.log(
    `[let-it-flow] 已生成 seed 配置（provider=${provider}, alias=${alias}），` +
      `请到 /models 页面调整 apiKeyEnv/provider 等字段`,
  );
  return true;
}
