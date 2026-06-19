import type { FlowConnector, ToolTier, ToolTrigger } from "./base.js";

/**
 * 喂给 planner LLM 的纯契约清单（剥离 execute，见 04 §4.7 forPlanner）。
 * 这是控制 Context Window Stuffing 的关键——只传 metadata，不传可执行代码。
 */
export interface ToolManifest {
  /** 工具唯一标识（如 "core.web_search"）。 */
  readonly name: string;
  /** 分层。 */
  readonly tier: ToolTier;
  /** 功能描述。 */
  readonly description: string;
  /** 调用时机：何时选这个工具。 */
  readonly whenToUse: ToolTrigger;
  /** 输入参数 JSON Schema。 */
  readonly inputSchema: Record<string, unknown>;
  /** 输出 JSON Schema。 */
  readonly outputSchema: Record<string, unknown>;
  /** 输出示例。 */
  readonly outputExample: Record<string, unknown>;
}

/**
 * 分层工具注册表（见 04 §4.11）。
 *
 * MVP 仅实装粗筛：按 tier 列出工具（core/domain/custom）。
 * 向量精排（two-stage 的第二阶段）留给后续里程碑 —— 计划明确"不做向量精排"。
 *
 * 用法：
 *   const reg = new ToolRegistry();
 *   reg.register(webSearch);
 *   reg.listByTier("core"); // → [webSearch, ...]
 *   reg.get("core.web_search"); // → webSearch
 */
export class ToolRegistry {
  private readonly byName = new Map<string, FlowConnector>();

  /** 注册一个工具（重复 name 抛错）。 */
  register(tool: FlowConnector): void {
    if (this.byName.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`);
    }
    this.byName.set(tool.name, tool);
  }

  /** 按名查找。 */
  get(name: string): FlowConnector | undefined {
    return this.byName.get(name);
  }

  /** 是否已注册。 */
  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** 列出全部工具。 */
  list(): FlowConnector[] {
    return [...this.byName.values()];
  }

  /** 按 tier 粗筛（two-stage 的第一阶段）。 */
  listByTier(tier: ToolTier): FlowConnector[] {
    return this.list().filter((t) => t.tier === tier);
  }

  /** 列出多个 tier 的并集。 */
  listByTiers(tiers: ToolTier[]): FlowConnector[] {
    const set = new Set(tiers);
    return this.list().filter((t) => set.has(t.tier));
  }

  /**
   * 构造传入 planner LLM 的工具清单（仅 metadata，剥离 execute）。
   * 这是控制 Context Window Stuffing 的关键入口——只传契约，不传可执行代码。
   * planner 据 whenToUse / outputExample 决定选哪些工具、如何编排。
   *
   * @param tiers  可选分层过滤；缺省返回全部已注册工具。
   */
  forPlanner(tiers?: ToolTier[]): ToolManifest[] {
    const tools = tiers ? this.listByTiers(tiers) : this.list();
    return tools.map((t) => ({
      name: t.name,
      tier: t.tier,
      description: t.description,
      whenToUse: t.whenToUse,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema,
      outputExample: t.outputExample,
    }));
  }
}
