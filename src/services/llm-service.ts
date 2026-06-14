import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { RUNTIME } from "../core/config.js";

/**
 * LLM 服务：按角色注入模型（见 02 §2.8 多模型平替）。
 *
 * MVP 走云端 API（OpenAI），不依赖 Ollama（计划"LLM 走云端 API"）。
 * 后续可通过 config 切换 provider（结构化输出鲁棒性见 07 §7.x RobustOutputGuard，
 * P4 planner 落地）。
 *
 * 角色（role）映射到具体模型，便于不同环节用不同规格：
 *   planner   — 规划 DAG（需强推理，gpt-4o）
 *   writer    — rewrite/translate 生成（gpt-4o-mini，量大需快）
 *   summarizer— 摘要（gpt-4o-mini）
 *   default   — 兜底
 */
export type LlmRole = "planner" | "writer" | "summarizer" | "default";

export interface LlmServiceOptions {
  apiKey?: string;
  /** 角色 → 模型 id 映射；未指定的角色回退到 default / RUNTIME.defaultModel。 */
  models?: Partial<Record<LlmRole, string>>;
}

const DEFAULT_MODELS: Record<LlmRole, string> = {
  planner: "gpt-4o",
  writer: "gpt-4o-mini",
  summarizer: "gpt-4o-mini",
  default: "gpt-4o",
};

export class LlmService {
  private readonly openai: ReturnType<typeof createOpenAI>;
  private readonly models: Record<LlmRole, string>;
  private readonly cache = new Map<string, LanguageModel>();

  constructor(opts: LlmServiceOptions = {}) {
    const apiKey = opts.apiKey ?? RUNTIME.openaiApiKey;
    if (!apiKey) {
      // 不在构造期抛错（允许无 key 启动服务做编排骨架测试）；
      // 真正调用 generateText 时 SDK 会报鉴权错。
    }
    this.openai = createOpenAI({ apiKey: apiKey || "missing" });
    this.models = { ...DEFAULT_MODELS, ...opts.models };
  }

  /** 取某角色的 LanguageModel（带缓存，避免重复实例化）。 */
  model(role: LlmRole = "default"): LanguageModel {
    const modelId = this.models[role] ?? this.models.default;
    const key = `${role}:${modelId}`;
    let m = this.cache.get(key);
    if (!m) {
      m = this.openai(modelId);
      this.cache.set(key, m);
    }
    return m;
  }

  /** 直接按模型 id 取（绕过角色映射，调试/特殊场景用）。 */
  modelById(modelId: string): LanguageModel {
    let m = this.cache.get(`id:${modelId}`);
    if (!m) {
      m = this.openai(modelId);
      this.cache.set(`id:${modelId}`, m);
    }
    return m;
  }
}
