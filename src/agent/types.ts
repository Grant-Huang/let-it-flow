/**
 * ReAct Harness 类型定义（ETCLOVG 七层 Harness Engineering 的 E/L/O 层）。
 *
 * 本模块是平台内核一等公民：把 AI SDK v6 的原生 Tool Use（function calling）
 * + 多步循环（streamText + stopWhen）桥接到 let-it-flow 的 SSE 协议 / 工具注册表 /
 * HITL 闩锁 / 可观测 trace。
 *
 * 设计原则（见 docs/15-react-harness-design.md）：
 *   - E（Execution）：ReAct 主循环是平台基础设施，应用不碰实现
 *   - L（Lifecycle）：TaskRegistry 调度，skill 工具桥接
 *   - O（Observability）：stepTrace + call-tracer，多步循环可观测
 *   - T/C/V/G 的"机制"在此声明类型，"内容/规则"由应用注入
 */
import type { LanguageModel } from "ai";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolTier } from "../tools/base.js";
import type { CallSite } from "../llm/call-sites.js";

/** 循环停止策略配置。 */
export interface StopPolicyConfig {
  /** 最大步数（缺省 15）。LLM 最多调用工具 N 轮。 */
  maxSteps?: number;
  /** 成本上限（累计 token）。超限终止。 */
  costCap?: { maxInputTokens?: number; maxOutputTokens?: number };
  /** finalize sentinel 工具名（缺省 "nexus_finalize"）。命中即终止。 */
  finalizeTool?: string;
}

/** 单步 trace：记录 LLM 每步的 Thought（text）+ Action（tool_call）+ Observation（tool_result）。 */
export interface StepTrace {
  /** 零基步序号。 */
  stepNumber: number;
  /** LLM 本步的文本推理（Thought）。 */
  thought?: string;
  /** 本步的推理内容（reasoning models 如 o1/claude thinking）。 */
  reasoning?: string;
  /** 本步发起的工具调用（Action）+ 返回结果（Observation）。 */
  toolCalls: Array<{
    /** 工具调用 id（SDK 生成）。 */
    id: string;
    toolName: string;
    args: Record<string, unknown>;
    /** 工具返回结果。 */
    result: unknown;
    /** 工具风险评级（决定是否走 HITL）。 */
    risk?: "safe" | "write" | "destructive";
    /** 是否经过 HITL 确认门。 */
    confirmed?: boolean;
    /** 用户拒绝则 true。 */
    rejected?: boolean;
    /** 工具执行耗时 ms。 */
    durationMs: number;
    /** 工具错误信息（出错时）。 */
    error?: string;
  }>;
  /** 本步 finishReason（stop / tool-calls / length / ...）。 */
  finishReason: string;
  /** 本步 token 用量。 */
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  /** 本步耗时 ms。 */
  durationMs: number;
}

/** V 层：应用声明的业务前置条件（"答前必须有 X"）。 */
export interface Precondition {
  id: string;
  /** 人类可读描述，喂给 LLM 作为提示（"诊断前必须有 OEE 实测 + 停机原因"）。 */
  description: string;
  /**
   * 检查函数：扫描当前 stepTrace，判定前置条件是否满足。
   * @returns met=true 满足；met=false 时给出缺失工具名 + 提示文案（harness 注入给 LLM）
   */
  check: (
    trace: StepTrace[],
  ) =>
    | { met: true }
    | { met: false; missingTool: string; prompt: string };
  /** 触发时机：finalize 时检查（缺省）/ 每步检查。 */
  phase?: "on_finalize" | "every_step";
}

/** G 层：应用挂的阻断规则（PreToolUse 钩子）。 */
export interface GovernanceHooks {
  /**
   * 工具执行前调用。返回 allow=false 则阻断（不发请求）。
   * @param toolName  工具名（dot-namespacing，如 "mcp.mes.update_schedule"）
   * @param args      工具入参（已按 inputSchema 解析）
   * @param risk      工具风险评级（safe/write/destructive，来自 connector.risk，缺省 safe）
   */
  preToolUse?: (
    toolName: string,
    args: unknown,
    risk?: "safe" | "write" | "destructive",
  ) => { allow: true } | { allow: false; reason: string };

  /**
   * 工具执行后、结果返回给 LLM 前调用（过程侧一致性校验）。
   *
   * 与 preToolUse 的区别：preToolUse 拿不到工具结果，只能按入参阻断；
   * postToolUse 能看到 EvidenceEnvelope，检测证据冲突、置信度兜底等。
   *
   * @returns
   *   - { pass: true }：放行，结果原样返回
   *   - { pass: false, severity: "warn", reason }：放行但往 result 注入 _warnings（LLM 可见）
   *   - { pass: false, severity: "block", reason }：把 result 替换为 { blocked: true, reason }，
   *     让 LLM 看到"这个证据不可用，需重取"
   */
  postToolUse?: (
    toolName: string,
    args: unknown,
    result: unknown,
  ) =>
    | { pass: true }
    | { pass: false; reason: string; severity?: "warn" | "block" };
}

/** harness 每步前的上下文（给 prepareStep 钩子）。 */
export interface PrepareStepContext {
  /** 已执行的 step 列表。 */
  steps: StepTrace[];
  /** 当前步序号。 */
  stepNumber: number;
  /** 用户原始意图。 */
  intent: string;
}

/** prepareStep 返回（透传给 AI SDK v6 的 PrepareStepResult）。 */
export interface PrepareStepResult {
  /** 本步可用的工具子集（按名过滤；缺省全部）。 */
  activeTools?: string[];
  /** 本步覆盖的 system prompt。 */
  system?: string;
  /** 本步强制工具选择。 */
  toolChoice?: "auto" | "required" | "none";
}

/** HITL 决策门签名（与 ExecutionContext.requireConfirmation 对齐）。 */
export interface HitlGateFn {
  (gate: {
    prompt: string;
    options?: string[];
    detail?: Record<string, unknown>;
  }): Promise<{ approved: boolean; params?: Record<string, unknown> }>;
}

/** 事件发射签名（payload 用宽松类型，兼容各种 SSE payload 形态）。 */
export interface EmitFn {
  (event: { type: string; channel?: string; payload: unknown }): Promise<unknown> | unknown;
}

/** Harness 配置。 */
export interface HarnessConfig {
  /** LLM 调用点（决定用哪个模型）。 */
  callSite: CallSite;
  /** LanguageModel 实例（由 LlmService.model(callSite) 解析）。 */
  model: LanguageModel;
  /** 工具注册表（harness 自动适配全部工具给 SDK）。 */
  registry: ToolRegistry;
  /** 工具分层过滤（缺省 core+domain+custom 全给）。 */
  toolTiers?: ToolTier[];
  /** 循环停止策略。 */
  stopPolicy?: StopPolicyConfig;
  /** 每步前动态裁剪工具 / 注入上下文。 */
  prepareStep?: (ctx: PrepareStepContext) => PrepareStepResult | undefined;
  /** 应用声明的前置条件（V 层）。 */
  preconditions?: Precondition[];
  /** 应用挂的阻断规则（G 层）。 */
  governanceHooks?: GovernanceHooks;
  /** HITL 决策门（write/destructive 工具触发）。 */
  requireConfirmation?: HitlGateFn;
  /** 事件发射器（step → SSE 桥接）。 */
  emit?: EmitFn;
  /** 追加到默认 agent 提示的 system 文本。 */
  systemPrompt?: string;
  /**
   * 多轮追问：上一轮的压缩上下文（由 customRunner 注入）。
   *
   * 存在时 harness 把它作为 user 消息的前置段落注入，让 LLM 感知上一轮的
   * 取证轨迹与结论，从而基于"上轮分析 + 本轮追问"继续深挖。
   *
   * 设计约束：
   *   - 纯文本注入（非 messages 数组累积），token 成本可控
   *   - 仅传最近 1 轮压缩上下文；更早轮次靠 finalText 间接传递
   *   - compressTrace 已截断 thought 到 200 字，单轮典型 1-2K token
   */
  previousContext?: {
    /** 上一轮用户意图。 */
    intent: string;
    /** 上一轮压缩轨迹（compressTrace 产出）。 */
    traceDigest: string;
    /** 上一轮最终结论。 */
    finalText: string;
  };
  /**
   * 兼容模式（DeepSeek 等非 OpenAI 官方 API）：开启后把 system 折叠进 user 消息，
   * 规避 SDK 把 system 映射成这些服务不支持的 `developer` 角色。
   */
  compatMode?: boolean;
  /** AbortSignal（外部中止）。 */
  abortSignal?: AbortSignal;
}

/** Harness 执行结果。 */
export interface HarnessResult {
  /** 每步完整轨迹（Thought/Action/Observation），O 层核心产物。 */
  stepTrace: StepTrace[];
  /** 最终文本输出。 */
  finalText: string;
  /** 累计 token 用量。 */
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd?: number;
  };
  /** 停止原因。 */
  finishReason:
    | "step_count" // 触发 stepCountIs
    | "finalize_tool" // 触发 hasToolCall(finalize)
    | "cost_cap" // 触发成本上限
    | "no_tool_call" // LLM 自然停止（无工具调用）
    | "precondition_unmet" // 前置条件未满足且兜底终止
    | "aborted" // 外部中止
    | "error"; // 异常
  /** 错误信息（finishReason=error 时）。 */
  error?: string;
}
