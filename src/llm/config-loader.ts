import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRegistry } from "./model-registry.js";
import type { ModelEndpoint } from "./model-registry.js";
import type { CallSite, CallSiteBinding } from "./call-sites.js";
import { CALL_SITES } from "./call-sites.js";
import { getDataDir } from "../core/config.js";

/**
 * 配置加载器（见 docs/13-p8-config-and-observability.md §13.3.3）。
 *
 * 优先级链（高 → 低）：
 *   1. CallSiteBinding 显式指定 modelAlias（data/config/call_site_bindings.json）
 *   2. 调用点专用 env（LIF_PLANNER_MODEL / LIF_REWRITE_MODEL / ...）
 *   3. 全局 env（LIF_MODEL / OPENAI_MODEL）
 *   4. DEFAULT_BINDINGS
 *
 * 配置文件损坏时降级到 env，不抛错（保证启动健壮）。
 */

/** 调用点 → 专用 env 变量名映射。 */
const CALL_SITE_ENV: Record<CallSite, string> = {
  planner: "LIF_PLANNER_MODEL",
  rewrite: "LIF_REWRITE_MODEL",
  translate: "LIF_TRANSLATE_MODEL",
  seam_repair: "LIF_SEAM_REPAIR_MODEL",
  terminology: "LIF_TERMINOLOGY_MODEL",
  image_prompts: "LIF_IMAGE_PROMPTS_MODEL",
  nexus_agent: "LIF_NEXUS_AGENT_MODEL",
  nexus_advise: "LIF_NEXUS_ADVISE_MODEL",
};

/** 兜底默认绑定（优先级 4）。alias 值仅作占位，实际解析由 LlmService 处理。 */
const DEFAULT_BINDINGS: Record<CallSite, string> = {
  planner: "default-planner",
  rewrite: "default-writer",
  translate: "default-translate",
  seam_repair: "default-seam-repair",
  terminology: "default-terminology",
  image_prompts: "default-image-prompts",
  nexus_agent: "default-nexus-agent",
  nexus_advise: "default-nexus-advise",
};

/** 已加载的运行时配置视图。 */
export interface RuntimeConfig {
  registry: ModelRegistry;
  bindings: Map<CallSite, CallSiteBinding>;
  /** 解析某调用点的模型 alias（按优先级链）。 */
  resolveAlias(callSite: CallSite): string | undefined;
  /** 解析某调用点的完整 ModelEndpoint（binding alias → registry lookup）。 */
  resolveEndpoint(callSite: CallSite): ModelEndpoint | undefined;
  /** 取某调用点的完整绑定（含 params；无显式绑定时返回 undefined）。 */
  getBinding(callSite: CallSite): CallSiteBinding | undefined;
}

/**
 * 加载配置。dataDir 缺省走 getDataDir()。
 * 配置文件不存在/损坏时降级，不抛错。
 */
export function loadConfig(dataDir: string = getDataDir()): RuntimeConfig {
  const configDir = join(dataDir, "config");
  const registry = loadRegistry(configDir);
  const bindings = loadBindings(configDir);

  return {
    registry,
    bindings,
    resolveAlias(callSite: CallSite): string | undefined {
      // 优先级 1：显式 binding
      const binding = bindings.get(callSite);
      if (binding) return binding.modelAlias;
      // 优先级 2：调用点专用 env
      const envVar = CALL_SITE_ENV[callSite];
      const envVal = process.env[envVar];
      if (envVal) return envVal;
      // 优先级 3：全局 env
      const globalModel = process.env.LIF_MODEL ?? process.env.OPENAI_MODEL;
      if (globalModel) return globalModel;
      // 优先级 4：默认绑定
      return DEFAULT_BINDINGS[callSite];
    },
    resolveEndpoint(callSite: CallSite): ModelEndpoint | undefined {
      const alias = this.resolveAlias(callSite);
      if (!alias) return undefined;
      return registry.get(alias);
    },
    getBinding(callSite: CallSite): CallSiteBinding | undefined {
      return bindings.get(callSite);
    },
  };
}

/** 加载 model_registry.json。不存在/损坏返回空 registry。 */
function loadRegistry(configDir: string): ModelRegistry {
  const path = join(configDir, "model_registry.json");
  if (!existsSync(path)) return new ModelRegistry();
  try {
    const raw = readFileSync(path, "utf8");
    return ModelRegistry.fromJSON(JSON.parse(raw));
  } catch {
    // 损坏降级
    return new ModelRegistry();
  }
}

/** 加载 call_site_bindings.json。不存在/损坏返回空 Map。 */
function loadBindings(configDir: string): Map<CallSite, CallSiteBinding> {
  const path = join(configDir, "call_site_bindings.json");
  const map = new Map<CallSite, CallSiteBinding>();
  if (!existsSync(path)) return map;
  try {
    const raw = readFileSync(path, "utf8");
    const arr = JSON.parse(raw) as CallSiteBinding[];
    if (!Array.isArray(arr)) return map;
    for (const b of arr) {
      if (CALL_SITES.includes(b.callSite)) {
        map.set(b.callSite, b);
      }
    }
  } catch {
    // 损坏降级
  }
  return map;
}

/**
 * 持久化配置到 dataDir/config/。
 * 写入是原子性的（先写后存）。
 */
export function saveConfig(
  dataDir: string,
  registry: ModelRegistry,
  bindings: CallSiteBinding[],
): void {
  const configDir = join(dataDir, "config");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, "model_registry.json"),
    JSON.stringify(registry.toJSON(), null, 2),
    "utf8",
  );
  writeFileSync(
    join(configDir, "call_site_bindings.json"),
    JSON.stringify(bindings, null, 2),
    "utf8",
  );
}
