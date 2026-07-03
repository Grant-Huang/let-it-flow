import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import type { EmbeddingModel } from "ai";
import type { LanguageModel } from "ai";
import { RUNTIME, SERVICE_URLS } from "../core/config.js";
import type { CallSite } from "../llm/call-sites.js";
import { CALL_SITES } from "../llm/call-sites.js";
import { loadConfig, type RuntimeConfig } from "../llm/config-loader.js";
import type { ModelEndpoint } from "../llm/model-registry.js";

/**
 * LLM 服务：按调用点注入模型（见 docs/13-p8-config-and-observability.md §13.3）。
 *
 * P8.5：支持多 provider 并存（openai/openai-compatible/anthropic/azure/ollama）。
 * 每个 ModelEndpoint 携带 provider/apiKeyEnv/baseURL/modelId 五元组，
 * 运行时从 registry 解析并按 provider 构造对应 SDK 实例。
 *
 * 旧 model(role) 重载与 legacyModel() 兜底保留向后兼容（registry 为空 / alias
 * 未在 registry 中找到时走旧 role 体系）。
 */
export type LlmRole = "planner" | "writer" | "summarizer" | "default";

export interface LlmServiceOptions {
  apiKey?: string;
  /** OpenAI 兼容 API 的 baseURL（如 DeepSeek）。缺省走 OpenAI 官方。 */
  baseURL?: string;
  /** 角色 → 模型 id 映射；未指定的角色回退到 default / RUNTIME.defaultModel。 */
  models?: Partial<Record<LlmRole, string>>;
  /** P8.1：注入运行时配置（缺省从 loadConfig() 加载）。测试可注入 mock。 */
  runtimeConfig?: RuntimeConfig;
}

/**
 * 角色 → 默认模型的环境变量映射。
 * 优先级链：角色专用 env → RUNTIME.defaultModel → 兜底占位。
 * 这样非 OpenAI provider（DeepSeek/Ollama）只需设 LIF_MODEL 即可统一覆盖全部角色，
 * 也可按角色精细化配置（如 LIF_PLANNER_MODEL 区分强/弱任务）。
 */
const ROLE_ENV: Record<LlmRole, string> = {
  planner: "LIF_PLANNER_MODEL",
  writer: "LIF_WRITER_MODEL",
  summarizer: "LIF_SUMMARIZER_MODEL",
  default: "LIF_MODEL",
};

/**
 * 解析角色默认模型（惰性读取环境变量，便于运行时切换 + 测试隔离）。
 * 缺省 fallback 到 RUNTIME.defaultModel（全局默认模型）。
 */
function resolveRoleModel(role: LlmRole): string {
  const envVal = process.env[ROLE_ENV[role]];
  if (envVal) return envVal;
  if (role === "default") return RUNTIME.defaultModel;
  // 非 default 角色回退到 default 角色，避免硬编码特定模型 id
  const defaultEnv = process.env.LIF_MODEL;
  if (defaultEnv) return defaultEnv;
  return RUNTIME.defaultModel;
}

/** 兜底占位（仅在 env 与 RUNTIME 均无配置时使用，不绑定特定 provider）。 */
const DEFAULT_MODEL_PLACEHOLDER = "default";

/** 构造角色 → 模型映射（惰性，每次构造 LlmService 时按当前 env 解析）。 */
function buildDefaultModels(): Record<LlmRole, string> {
  return {
    planner: resolveRoleModel("planner"),
    writer: resolveRoleModel("writer"),
    summarizer: resolveRoleModel("summarizer"),
    default: resolveRoleModel("default") || DEFAULT_MODEL_PLACEHOLDER,
  };
}

/** callSite → LlmRole 映射（向后兼容旧 role 体系）。 */
const CALLSITE_TO_ROLE: Record<CallSite, LlmRole> = {
  planner: "planner",
  rewrite: "writer",
  translate: "writer",
  seam_repair: "writer",
  terminology: "writer",
  image_prompts: "writer",
  nexus_agent: "planner",
  nexus_advise: "planner",
  nexus_review: "planner",
  nexus_narrate: "summarizer",
  podcast_skill_agent: "planner",
};

/** per-callSite Chat Completions 兼容标志的判定 provider 集合。 */
const PROVIDERS_NEEDING_CHAT_ENDPOINT = new Set([
  "openai-compatible",
  "ollama",
]);

export class LlmService {
  private readonly openai: ReturnType<typeof createOpenAI>;
  private readonly models: Record<LlmRole, string>;
  private readonly useChat: boolean;
  /** per-endpoint LanguageModel 缓存（含 provider 实例选择）。 */
  private readonly cache = new Map<string, LanguageModel>();
  /** provider 工厂实例缓存，key = "provider:baseURL"。 */
  private readonly providerCache = new Map<string, unknown>();
  private readonly runtimeConfig: RuntimeConfig | null;

  constructor(opts: LlmServiceOptions = {}) {
    const apiKey = opts.apiKey ?? RUNTIME.openaiApiKey;
    if (!apiKey) {
      // 不在构造期抛错（允许无 key 启动服务做编排骨架测试）；
      // 真正调用 generateText 时 SDK 会报鉴权错。
    }
    // 支持 OpenAI 兼容 API（DeepSeek 等）：显式 baseURL 透传给 createOpenAI
    const baseURL = opts.baseURL ?? (RUNTIME.openaiBaseUrl || undefined);
    // 兼容 DeepSeek 等 OpenAI 兼容 API：强制 system role，
    // 避免 SDK 默认把 system 转成 developer role（OpenAI o 系列专用）导致 400 错误
    this.openai = createOpenAI({
      apiKey: apiKey || "missing",
      systemMessageMode: "system",
      ...(baseURL ? { baseURL } : {}),
    });
    // 非 OpenAI 官方 API（如 DeepSeek）不支持 Responses API，强制走 Chat Completions
    this.useChat = !!baseURL;
    // 配置了自定义 baseURL/model 时（如 DeepSeek），所有角色统一用该 model
    const customModel = RUNTIME.openaiBaseUrl ? RUNTIME.defaultModel : undefined;
    const base: Record<LlmRole, string> = customModel
      ? { planner: customModel, writer: customModel, summarizer: customModel, default: customModel }
      : buildDefaultModels();
    this.models = { ...base, ...opts.models };
    // P8.1：尝试加载运行时配置（配置文件不存在时降级，不抛错）
    // 延迟加载：仅当调用 model(callSite) 时才解析
    this.runtimeConfig = opts.runtimeConfig ?? null;
  }

  /**
   * 兼容模式标记（全局兜底）：非 OpenAI 官方 API（如 DeepSeek）时为 true。
   *
   * 优先使用 per-callSite 的 compatModeFor(callSite)；本 getter 仅供未提供
   * callSite 的旧调用路径兜底（如 planner 的 config.llm.compatMode）。
   */
  get compatMode(): boolean {
    return this.useChat;
  }

  /**
   * P8.5：per-callSite 兼容模式查询。
   * 走 registry 完整路径时，按 endpoint.provider 判定是否需走 Chat Completions；
   * 未命中 registry 时回退全局 useChat（向后兼容）。
   */
  compatModeFor(callSite: CallSite): boolean {
    const ep = this.cfg.resolveEndpoint(callSite);
    if (!ep) return this.useChat;
    return PROVIDERS_NEEDING_CHAT_ENDPOINT.has(ep.provider);
  }

  /**
   * P8.5：取某调用点的完整 ModelEndpoint（业务调用方读 provider/pricing/modelId 用）。
   * 未命中 registry 返回 undefined。
   */
  resolveEndpoint(callSite: CallSite): ModelEndpoint | undefined {
    return this.cfg.resolveEndpoint(callSite);
  }

  /** P8.1：惰性加载运行时配置（避免构造期读 env 快照过期）。 */
  private get cfg(): RuntimeConfig {
    return this.runtimeConfig ?? loadConfig();
  }

  /**
   * P8.5：按 endpoint 构造/取缓存 LanguageModel（走 registry 完整路径）。
   * provider 实例按 "provider:baseURL" 缓存；model 取自 endpoint.modelId。
   */
  private getProvider(ep: ModelEndpoint): LanguageModel {
    const cacheKey = `${ep.provider}:${ep.baseURL ?? ""}`;
    let instance = this.providerCache.get(cacheKey);
    if (!instance) {
      instance = this.buildProvider(ep);
      this.providerCache.set(cacheKey, instance);
    }
    const useChat = PROVIDERS_NEEDING_CHAT_ENDPOINT.has(ep.provider);
    if (useChat) {
      // openai-compatible / ollama：用 .chat() 走 Chat Completions
      const chatFn = (instance as { chat: (id: string) => LanguageModel }).chat.bind(instance);
      return chatFn(ep.modelId);
    }
    // openai(官方 responses) / anthropic / azure：实例本身可作为可调用工厂
    const callable = instance as (id: string) => LanguageModel;
    return callable(ep.modelId);
  }

  /** 按 ep.provider 分发构造对应 SDK provider 工厂实例。 */
  private buildProvider(ep: ModelEndpoint): unknown {
    const apiKey =
      ep.provider === "ollama"
        ? "ollama" // ollama 本地无需 key
        : process.env[ep.apiKeyEnv] ?? "missing";
    switch (ep.provider) {
      case "anthropic":
        return createAnthropic({ apiKey });
      case "azure":
        // Azure 用 resourceName（或 baseURL）；apiVersion 透传
        return createAzure({
          apiKey,
          resourceName: ep.azureResourceName,
          apiVersion: ep.azureApiVersion,
        });
      case "ollama":
        return createOpenAI({
          apiKey,
          baseURL: ep.baseURL ?? SERVICE_URLS.ollama,
          systemMessageMode: "system",
        });
      case "openai-compatible":
        return createOpenAI({ apiKey, baseURL: ep.baseURL!, systemMessageMode: "system" });
      case "openai":
      default:
        return createOpenAI({ apiKey, systemMessageMode: "system" });
    }
  }

  /**
   * 取某调用点的 LanguageModel（P8.1 新增，P8.5 增强为走 registry 完整路径）。
   *
   * 优先级：resolveEndpoint 命中且 enabled → getProvider(endpoint)；
   * 否则走 legacyModel()（旧 role 体系，向后兼容）。
   */
  model(callSite: CallSite): LanguageModel;
  /** 旧重载：取某角色的 LanguageModel（向后兼容）。 */
  model(role: LlmRole): LanguageModel;
  model(callSiteOrRole: CallSite | LlmRole): LanguageModel {
    // 判断是 CallSite 还是旧 LlmRole（直接用权威枚举，避免字面量散落）
    const isCallSite = (CALL_SITES as readonly string[]).includes(callSiteOrRole as string);
    if (isCallSite) {
      const cs = callSiteOrRole as CallSite;
      // P8.5：先尝试 registry 完整路径
      const ep = this.cfg.resolveEndpoint(cs);
      if (ep && ep.enabled) {
        const key = `ep:${ep.alias}:${ep.modelId}`;
        let m = this.cache.get(key);
        if (!m) {
          m = this.getProvider(ep);
          this.cache.set(key, m);
        }
        return m;
      }
      // 兜底：旧 role 体系
      return this.legacyModel(cs);
    }
    return this.legacyModel(callSiteOrRole as LlmRole);
  }

  /**
   * 取 Embedding 模型（07-mestar-integration-spec.md §6 EmbeddingToolRouter 用）。
   *
   * provider 解析优先级：
   *   1. 配置了独立 embedding baseURL（LIF_EMBEDDING_BASE_URL，如 Ollama/Jina）→
   *      创建独立 provider 实例（与 chat provider 解耦）
   *   2. 否则复用 chat provider 实例（向后兼容）
   *
   * 注意：直接读 process.env 而非 RUNTIME 静态字段——避免 dotenv 加载顺序
   * 导致 RUNTIME 顶层求值时拿到空 env（config.ts 可能先于 dotenv/config 被 import）
   *
   * @param modelId 模型 id（缺省取 LIF_EMBEDDING_MODEL，再缺省 text-embedding-3-small）
   */
  embeddingModel(
    modelId: string = process.env.LIF_EMBEDDING_MODEL ?? "text-embedding-3-small",
  ): EmbeddingModel {
    const embedBaseURL = process.env.LIF_EMBEDDING_BASE_URL ?? "";
    // 独立 embedding provider（Ollama/Jina 等 OpenAI 兼容服务）
    if (embedBaseURL) {
      const embedProvider = createOpenAI({
        apiKey: process.env.LIF_EMBEDDING_API_KEY ?? process.env.OPENAI_API_KEY ?? "missing",
        baseURL: embedBaseURL,
        // 兼容第三方 embedding 服务：强制 system role，避免 SDK 默认 developer
        systemMessageMode: "system",
      });
      return embedProvider.embedding(modelId);
    }
    // 回退：复用 chat provider 实例（如 OpenAI 官方一站式）
    return this.openai.embedding(modelId);
  }

  /** 旧 role 体系兜底：alias 作 modelId 直接给单 openai 实例（向后兼容）。 */
  private legacyModel(callSiteOrRole: CallSite | LlmRole): LanguageModel {
    let modelId: string;
    const isCallSite = (CALL_SITES as readonly string[]).includes(callSiteOrRole as string);
    if (isCallSite) {
      const cs = callSiteOrRole as CallSite;
      const alias = this.cfg.resolveAlias(cs);
      if (alias && !alias.startsWith("default-")) {
        modelId = alias;
      } else {
        const role = CALLSITE_TO_ROLE[cs];
        modelId = this.models[role] ?? this.models.default;
      }
    } else {
      const role = callSiteOrRole as LlmRole;
      modelId = this.models[role] ?? this.models.default;
    }
    const key = `legacy:${callSiteOrRole}:${modelId}`;
    let m = this.cache.get(key);
    if (!m) {
      // 兼容服务（DeepSeek）用 .chat() 走 Chat Completions；OpenAI 官方走默认 Responses
      m = this.useChat ? this.openai.chat(modelId) : this.openai(modelId);
      this.cache.set(key, m);
    }
    return m;
  }

  /** 直接按模型 id 取（绕过角色映射，调试/特殊场景用）。 */
  modelById(modelId: string): LanguageModel {
    let m = this.cache.get(`id:${modelId}`);
    if (!m) {
      m = this.useChat ? this.openai.chat(modelId) : this.openai(modelId);
      this.cache.set(`id:${modelId}`, m);
    }
    return m;
  }

  /** P8.1：配置变更时清缓存（前端热加载用）。 */
  clearCache(): void {
    this.cache.clear();
    this.providerCache.clear();
  }

  /** P8.4：订阅 EventBus 的 config_changed 事件，自动清缓存。 */
  subscribeConfigChanges(bus: { on: (event: string, handler: (data: unknown) => void) => void }): void {
    bus.on("config_changed", () => {
      this.clearCache();
    });
  }
}
