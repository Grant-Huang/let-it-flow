import { z } from "zod";

/**
 * 模型端点定义（见 docs/13-p8-config-and-observability.md §13.3.1）。
 *
 * 一个 alias 对应一条可调用的模型通道。registry 管理全部可用模型。
 * API key 不存明文，只存环境变量名（apiKeyEnv），运行时从 process.env 读。
 */
export const ModelEndpointSchema = z.object({
  /** 逻辑别名，全局唯一，小写连字符。如 "deepseek-v4-pro" */
  alias: z.string().regex(/^[a-z0-9-]+$/, "alias 必须为小写字母/数字/连字符"),
  /** provider 类型，决定如何构造 LanguageModel */
  provider: z.enum(["openai", "ollama", "azure", "anthropic", "openai-compatible"]),
  /** provider 内部的模型 id。如 "deepseek-chat"、"qwen2.5:35b" */
  modelId: z.string().min(1, "modelId 必填"),
  /** OpenAI 兼容 API 的 baseURL（provider=openai/openai-compatible 时必填） */
  baseURL: z.string().url().optional(),
  /** API Key 的环境变量名（运行时从 process.env 读取，不存明文） */
  apiKeyEnv: z.string().default("OPENAI_API_KEY"),
  /** Azure 资源名（provider=azure 时必填，如 "my-azure-resource"） */
  azureResourceName: z.string().optional(),
  /** Azure API 版本（provider=azure 时用） */
  azureApiVersion: z.string().default("2024-10-21"),
  /** 结构化输出能力，决定走 RobustOutputGuard 哪条路径（见 02 §2.8） */
  structuredSupport: z.enum(["native", "weak"]).default("native"),
  /** 能力标签，调用点绑定时用于过滤可选模型 */
  capabilities: z
    .array(z.enum(["chat", "structured", "streaming", "reasoning"]))
    .default(["chat"]),
  /** 单价（美元 / 1K token），用于成本统计。可选 */
  pricing: z
    .object({
      inputPer1K: z.number().nonnegative(),
      outputPer1K: z.number().nonnegative(),
    })
    .optional(),
  /** 备注（前端展示用） */
  note: z.string().optional(),
  /** 是否启用（禁用后不可被调用点选中） */
  enabled: z.boolean().default(true),
});
/** 解析后的完整类型（含默认值）。 */
export type ModelEndpoint = z.infer<typeof ModelEndpointSchema>;
/** 输入类型（构造时可省略带默认值的字段）。 */
export type ModelEndpointInput = z.input<typeof ModelEndpointSchema>;

// 向后兼容：导出旧别名
export const ModelEndpoint = ModelEndpointSchema;

/**
 * 模型注册表。管理全部 ModelEndpoint，支持 CRUD + 序列化。
 *
 * 用法：
 *   const reg = new ModelRegistry();
 *   reg.add({ alias: "gpt-4o", ... });
 *   reg.get("gpt-4o");
 *   reg.listEnabled();
 */
export class ModelRegistry {
  private readonly endpoints = new Map<string, ModelEndpoint>();

  /** 添加端点。alias 重复抛错。 */
  add(ep: ModelEndpointInput): void {
    const parsed = ModelEndpointSchema.parse(ep);
    if (this.endpoints.has(parsed.alias)) {
      throw new Error(`模型 alias "${parsed.alias}" 已存在`);
    }
    this.endpoints.set(parsed.alias, parsed);
  }

  /** 获取端点。不存在返回 undefined。 */
  get(alias: string): ModelEndpoint | undefined {
    return this.endpoints.get(alias);
  }

  /** 更新端点（覆盖）。不存在抛错。 */
  update(alias: string, patch: Partial<ModelEndpointInput>): void {
    const existing = this.endpoints.get(alias);
    if (!existing) throw new Error(`模型 alias "${alias}" 不存在`);
    const updated = { ...existing, ...patch, alias };
    this.endpoints.set(alias, ModelEndpointSchema.parse(updated));
  }

  /** 删除端点。不存在静默忽略。 */
  remove(alias: string): void {
    this.endpoints.delete(alias);
  }

  /** 列出全部端点（含禁用）。 */
  list(): ModelEndpoint[] {
    return Array.from(this.endpoints.values());
  }

  /** 仅列出 enabled=true 的端点（供调用点绑定下拉用）。 */
  listEnabled(): ModelEndpoint[] {
    return this.list().filter((e) => e.enabled);
  }

  /** 序列化为 JSON 数组（写盘用）。 */
  toJSON(): ModelEndpoint[] {
    return this.list();
  }

  /** 从 JSON 数组反序列化（读盘用）。覆盖现有内容。 */
  static fromJSON(data: unknown): ModelRegistry {
    const reg = new ModelRegistry();
    const arr = z.array(ModelEndpointSchema).parse(data);
    for (const ep of arr) reg.add(ep);
    return reg;
  }

  /**
   * 校验所有 enabled endpoint 的 apiKeyEnv 是否已设环境变量。
   * 返回缺失清单（ollama 无 key 不校验）。启动时打印警告用。
   */
  validateEnvKeys(): { alias: string; missingEnv: string }[] {
    return this.listEnabled()
      .filter((ep) => ep.provider !== "ollama")
      .map((ep) => ({
        alias: ep.alias,
        envName: ep.apiKeyEnv,
        hasKey: !!process.env[ep.apiKeyEnv],
      }))
      .filter((x) => !x.hasKey)
      .map((x) => ({ alias: x.alias, missingEnv: x.envName }));
  }
}
