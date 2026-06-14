import type { StreamEvent } from "../core/stream-events.js";

/**
 * LetItFlow 配置（SDK 形态，进程内）。
 * MVP 阶段为骨架占位，P1-P3 逐步填充 planner/executor/tools。
 */
export interface LetItFlowConfig {
  /** Planner / LLM 节点用的模型标识，如 "openai/gpt-4o" */
  plannerModel?: string;
  /** OpenAI API Key（缺省从环境变量读取） */
  openaiApiKey?: string;
  /** 搜索 provider，如 "tavily" / "native" */
  searchProvider?: string;
}

/**
 * Let-it-Flow SDK 主入口（进程内 async generator 形态）。
 *
 * 用法：
 *   const flow = new LetItFlow({ plannerModel: "openai/gpt-4o" });
 *   for await (const chunk of flow.execute("把某主题做成播客")) { ... }
 *
 * MVP 阶段 execute() 为占位，P3 接入真实 executor 后产出事件流。
 */
export class LetItFlow {
  readonly config: Required<LetItFlowConfig>;

  constructor(config: LetItFlowConfig = {}) {
    this.config = {
      plannerModel: config.plannerModel ?? "openai/gpt-4o",
      openaiApiKey: config.openaiApiKey ?? process.env.OPENAI_API_KEY ?? "",
      searchProvider: config.searchProvider ?? "tavily",
    };
  }

  /**
   * 执行一个意图，返回事件流（async generator）。
   * P0 占位：产出单个 done 事件。P3 接入真实 executor。
   */
  async *execute(_intent: string): AsyncGenerator<StreamEvent> {
    // 占位实现：P3 将替换为 planner -> executor 完整链路
  }
}
