import type { StreamEvent, ToolEvent } from "../core/stream-events.js";

// 重新导出 ToolEvent（定义在 stream-events.js 作为单一来源）
export type { ToolEvent } from "../core/stream-events.js";

/**
 * 工具分层（见 04 §4.11 两阶段动态工具检索）。
 * MVP 仅做粗筛 listByTier；向量精排留给后续里程碑。
 *   core   — 平台核心工具（web_search、web_fetch、llm-node、deliver）
 *   domain — 领域工具（podcast 模板的 TTS/生图/视频，P5）
 *   custom — 用户自定义 / 第三方 MCP
 */
export type ToolTier = "core" | "domain" | "custom";

/**
 * 结构化调用时机（见 04 §4.6 工具契约）：面向 planner LLM 的"工具手册"，
 * 决定 planner 能否选对工具、避免乱猜。
 */
export interface ToolTrigger {
  /** 触发关键词/场景：意图涉及这些时优先选此工具。 */
  triggers: string[];
  /** 不适用场景：意图属于这些时不要选此工具。 */
  notFor: string[];
}

/**
 * 工具执行上下文：执行器在调用工具时注入的能力。
 *   - emit：发射事件（落库 + 流式）。工具产出 stage/tool_call/tool_result/text 等。
 *   - requireConfirmation：HITL 暂停点（requireConfirmation 节点用）。
 *   - resolveRef：解析上游节点输出引用（$.tasks[id].output），由 executor 提供。
 *   - taskId / runId / nodeId：用于事件归属。
 */
export interface ExecutionContext {
  taskId: string;
  runId: string;
  nodeId: string;
  /** 发射一个事件（append 到 store + 走 SSE）。返回带 seq 的完整事件。 */
  emit: (event: Omit<StreamEvent, "seq" | "taskId" | "ts">) => Promise<StreamEvent>;
  /** HITL 确认门：挂起等待用户决策。approved=true 继续，false 中止本节点。 */
  requireConfirmation: (gate: {
    prompt: string;
    options?: string[];
    detail?: Record<string, unknown>;
  }) => Promise<{ approved: boolean; params?: Record<string, unknown> }>;
  /** 解析 JSONPath 引用到上游节点输出（由 executor 的 context 提供）。 */
  resolveRef: (ref: string) => unknown;
}

/** 工具执行结果：最终结构化输出（供下游节点 $.tasks[id].output 引用）。 */
export interface ToolResult<T = unknown> {
  /** 结构化输出。executor 记录到 ExecutionContext 供下游引用。 */
  output: T;
  /** 可选的额外摘要（用于事件 payload / 调试）。 */
  summary?: string;
}

/**
 * FlowConnector —— 所有工具（内置 / 域 / 自定义）的统一接口（见 04 §4.4）。
 *
 * execute() 是 async generator：可边执行边产出事件（流式 LLM、检索进度），
 * 最终返回一个 ToolResult（结构化输出）。executor 收 generator 产出的事件
 * 立即 emit，结束后把 output 记录到 context。
 *
 * 约定（见 04 §4.5）：
 *   - execute 应先 emit 一个 tool_call 事件（声明本次调用），结束时 emit tool_result
 *   - 期间可 emit text（流式正文）/ workflow_node（细粒度进度）
 *   - 错误：抛异常，由 executor 按 onNodeError 处理；不要静默吞错
 */
export interface FlowConnector<TOutput = unknown> {
  /** 工具唯一标识（dot-namespacing，如 "core.web_search"）。 */
  readonly name: string;
  /** 分层。 */
  readonly tier: ToolTier;
  /** 人/LLM 可读描述（喂给 planner 选工具）。 */
  readonly description: string;
  /** 输入参数 JSON Schema（Zod 或原生 schema）。MVP 用 Zod schema 对象描述。 */
  readonly inputSchema: Record<string, unknown>;

  // ── 面向 planner LLM 的工具手册（Tool Contract，见 04 §4.6）──

  /**
   * 调用时机（必填）。结构化 Trigger：何时调用此工具。
   * 让 planner 明确在什么意图下选这个工具，避免乱猜。
   */
  readonly whenToUse: ToolTrigger;
  /**
   * 输出 JSON Schema（Zod schema 转），描述 ToolResult.output 的结构，
   * 字段含 description。让 planner 知道"产出长什么样"。
   */
  readonly outputSchema: Record<string, unknown>;
  /**
   * 输出示例（必填）。给 planner 看的真实输出样例，让它知道
   * "下一步能引用哪些字段"。
   */
  readonly outputExample: Record<string, unknown>;

  /** @deprecated 改用 outputSchema（JSON Schema，结构更完整）。保留向后兼容。 */
  readonly outputShape?: string;

  /**
   * 执行工具。
   * @param params   已校验的输入参数（executor 按 inputSchema 解析自节点 params/inputRefs）
   * @param ctx      执行上下文（emit / requireConfirmation / resolveRef）
   * @returns        async generator，yield 事件流；return 一个 ToolResult
   */
  execute(
    params: Record<string, unknown>,
    ctx: ExecutionContext,
  ): AsyncGenerator<ToolEvent, ToolResult<TOutput>>;

  /**
   * 工具风险评级（可选，T 层 HITL 门用）。
   *   safe         — 只读/无副作用，直接执行（缺省）
   *   write        — 有副作用（写 MES/改排产），ReAct harness 默认走 HITL 确认门
   *   destructive  — 不可逆（删数据/停线），必须 HITL 确认 + governance 链放行
   *
   * 向后兼容：老工具不带此字段时按 "safe" 处理。
   */
  readonly risk?: "safe" | "write" | "destructive";
}
