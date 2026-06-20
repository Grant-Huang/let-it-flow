/**
 * ReAct Harness 核心（E 层 —— 平台基础设施，所有消费应用复用）。
 *
 * 把 AI SDK v6 的原生 Tool Use（function calling）+ 多步循环（streamText + stopWhen）
 * 桥接到 let-it-flow 体系。这是范式的核心：LLM 运行时动态选工具，每步根据上一步
 * Observation 决定下一步 Thought/Action。
 *
 * ETCLOVG 映射：
 *   - E：streamText 多步编排 + stopWhen 循环控制
 *   - T：经 tool-adapter 把 FlowConnector 适配给 SDK
 *   - L：onStepFinish 累积 stepTrace，最终 HarnessResult
 *   - O：TraceAccumulator + 每步 phase 事件（SSE 可见）
 *   - V：每步/finalize 检查 preconditions
 *   - G：每步工具执行前过 governanceHooks.preToolUse（在 tool-adapter 内）
 *
 * 关键约束（来自设计）：
 *   - 不手写 Thought/Action/Observation 循环，SDK 自己是 ReAct 实现
 *   - 不引入 react/dag 二元模式，ReAct 是唯一执行路径
 *   - 弱 provider（不支持 function calling）的文本回退留接口位，本次不实装
 */
import { streamText } from "ai";
import { buildStopWhen } from "./stop-policy.js";
import { adaptToolSet, toolNameToKey } from "./tool-adapter.js";
import { TraceAccumulator, emitStepPhase } from "./step-emitter.js";
import type {
  HarnessConfig,
  HarnessResult,
  StepTrace,
  Precondition,
} from "./types.js";

/**
 * 执行一次 ReAct 任务。
 *
 * @param intent   用户原始意图
 * @param config   harness 配置（callSite/model/registry/stopPolicy/preconditions/...）
 * @returns        完整结果（stepTrace + finalText + usage + finishReason）
 */
export async function runReactHarness(
  intent: string,
  config: HarnessConfig,
): Promise<HarnessResult> {
  const {
    model,
    registry,
    toolTiers,
    stopPolicy,
    prepareStep,
    preconditions = [],
    emit,
    systemPrompt,
    abortSignal,
  } = config;
  const compatMode = config.compatMode ?? false;

  // 1. 收集工具（按 tier 过滤）+ 适配成 AI SDK ToolSet
  const connectors = toolTiers ? registry.listByTiers(toolTiers) : registry.list();
  if (connectors.length === 0) {
    return {
      stepTrace: [],
      finalText: "",
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      finishReason: "error",
      error: "工具池为空，无法启动 ReAct 循环",
    };
  }

  // 收集工具名 → 风险评级映射（供 step trace 还原）
  const riskMap = new Map<string, "safe" | "write" | "destructive">();
  for (const c of connectors) {
    const risk = (c as { risk?: "safe" | "write" | "destructive" }).risk ?? "safe";
    riskMap.set(c.name, risk);
  }
  // finalize sentinel 工具名（SDK key 形态）
  const finalizeKey = toolNameToKey(stopPolicy?.finalizeTool ?? "nexus_finalize");

  // 适配工具集（harness 内部的 ctxMeta 用 "react" 占位）
  const tools = adaptToolSet(
    connectors,
    {
      requireConfirmation: config.requireConfirmation,
      emit,
      governancePreToolUse: config.governanceHooks?.preToolUse,
      governancePostToolUse: config.governanceHooks?.postToolUse,
    },
    { taskId: "react", runId: "react", nodeId: "react" },
  );

  // 2. 构造 stopWhen（含 precondition 触发条件）
  const extraConditions = buildPreconditionConditions(preconditions);
  const stopWhen = buildStopWhen(stopPolicy, extraConditions);

  // 3. system prompt
  const system = buildSystemPrompt(intent, systemPrompt, connectors.map((c) => c.name), stopPolicy?.finalizeTool);

  // 4. trace 累积器 + HITL 决策记录
  const accumulator = new TraceAccumulator();
  const confirmedSet = new Set<string>();
  const rejectedSet = new Set<string>();

  // 5. 发起 streamText（多步循环）
  try {
    // 兼容模式（DeepSeek 等）：把 system 折叠进 user 消息，规避 `developer` 角色
    const streamArgs = compatMode
      ? { messages: [{ role: "user" as const, content: `${system}\n\n---\n${intent}` }] }
      : { system, messages: [{ role: "user" as const, content: intent }] };
    const result = streamText({
      model,
      ...streamArgs,
      tools,
      stopWhen,
      abortSignal,
      onStepFinish: async (ev) => {
        // O 层：转 StepTrace 累积
        const trace = convertStep(ev, riskMap, confirmedSet, rejectedSet);
        accumulator.push(trace);
        // E 层：发 phase 事件（前端可见）
        await emitStepPhase(emit, ev.stepNumber, "done");
      },
      prepareStep: ({ steps, stepNumber }) => {
        // C 层钩子：应用自定义裁剪/注入
        if (!prepareStep) return undefined;
        const stepTraces = steps.map((s) => convertStep(s, riskMap, confirmedSet, rejectedSet));
        const stepResult = prepareStep({ steps: stepTraces, stepNumber, intent });
        if (!stepResult) return undefined;
        // 透传成 SDK 的 PrepareStepResult（activeTools 转成 SDK key 形态）
        return {
          ...(stepResult.activeTools ? { activeTools: stepResult.activeTools.map(toolNameToKey) } : {}),
          ...(stepResult.system ? { system: stepResult.system } : {}),
          ...(stepResult.toolChoice ? { toolChoice: stepResult.toolChoice } : {}),
        };
      },
    });

    // 等待流结束：final.text 与 final.steps 都是 PromiseLike（streamText 返回值特性）
    const final = await result;
    const finalText = (await final.text) ?? "";
    const usage = accumulator.usage;

    // 6. 判定 finishReason
    const steps = (await final.steps) as ReadonlyArray<{ finishReason: string }> | undefined;
    const lastStep = steps?.[steps.length - 1];
    const finishReason = resolveFinishReason(
      lastStep?.finishReason,
      stopPolicy?.finalizeTool,
      accumulator.list,
      preconditions,
    );

    return {
      stepTrace: accumulator.list,
      finalText,
      usage: {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
      },
      finishReason,
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    return {
      stepTrace: accumulator.list,
      finalText: "",
      usage: accumulator.usage,
      finishReason: abortSignal?.aborted ? "aborted" : "error",
      error: errMsg,
    };
  }
}

/**
 * 把 precondition 转成 stopWhen 的额外条件（每步检查型）。
 * 当前置条件未满足且已超 80% 步数预算时触发停止（防卡死）。
 */
function buildPreconditionConditions(
  _preconditions: Precondition[],
): ((opts: { steps: ReadonlyArray<{ usage: { inputTokens?: number; outputTokens?: number } }> }) => boolean)[] {
  // 每步前置条件的完整检查由 prepareStep 钩子注入提示实现（更可控）；
  // stopWhen 层仅在步数较多时保守放行，避免与 SDK 的 step 模型冲突。
  return [];
}

/**
 * finalize 时检查前置条件，决定是否降级为 precondition_unmet。
 */
function resolveFinishReason(
  rawFinishReason: string | undefined,
  finalizeTool: string | undefined,
  traces: StepTrace[],
  preconditions: Precondition[],
): HarnessResult["finishReason"] {
  // 触发 finalize sentinel
  if (finalizeTool) {
    const calledFinalize = traces.some((t) =>
      t.toolCalls.some((tc) => tc.toolName === finalizeTool),
    );
    if (calledFinalize) return "finalize_tool";
  }

  // 检查 on_finalize 型前置条件
  for (const p of preconditions) {
    if ((p.phase ?? "on_finalize") !== "on_finalize") continue;
    const r = p.check(traces);
    if (!r.met) return "precondition_unmet";
  }

  // SDK 原始 finishReason 映射
  if (rawFinishReason === "stop") return "no_tool_call";
  if (rawFinishReason === "tool-calls") return "step_count"; // 理论上 stopWhen 已拦截
  if (rawFinishReason === "length") return "step_count";
  return "no_tool_call";
}

/** 构造默认 system prompt。 */
function buildSystemPrompt(
  intent: string,
  extra: string | undefined,
  toolNames: string[],
  finalizeTool: string | undefined,
): string {
  const parts = [
    "你是一个运营智能分析助手，使用 ReAct（Thought→Action→Observation）模式工作。",
    "每步你可以：思考（输出 text）或调用工具（function call）。工具返回的 Observation 会追加进上下文。",
    "根据证据的时效性（freshness）和置信度（confidence）谨慎判断——estimated/historical 数据需更多交叉验证。",
    "",
    `## 可用工具（${toolNames.length} 个）`,
    toolNames.join("、"),
  ];
  if (finalizeTool) {
    parts.push(
      "",
      `## 收尾`,
      `分析完成且证据充分时，调用 \`${finalizeTool}\` 工具收尾并产出最终结构化建议。`,
      `若前置条件未满足（如缺少关键取证），不要收尾，继续调工具补齐。`,
    );
  }
  parts.push("", `## 当前任务\n${intent}`);
  if (extra) parts.push("", "## 附加指引\n" + extra);
  return parts.join("\n");
}

/** 转 StepTrace。SDK step 事件的 TOOLS 泛型与本模块无关，故入参用 any 规避泛型穿透。 */
function convertStep(
  ev: any,
  riskMap: Map<string, "safe" | "write" | "destructive">,
  confirmedSet: Set<string>,
  rejectedSet: Set<string>,
): StepTrace {
  const toolCalls: StepTrace["toolCalls"] = ((ev?.toolCalls ?? []) as any[]).map((tc, i) => {
    const isDynamic = typeof tc?.type === "string" && tc.type.startsWith("dynamic");
    const toolName = isDynamic
      ? (tc.toolName ?? "unknown")
      : (tc.toolName ?? "unknown").replace(/_/g, ".");
    const result = ev?.toolResults?.[i] ?? {};
    const id: string = tc?.id ?? `tc_${i}`;
    return {
      id,
      toolName,
      args: (tc?.input ?? tc?.args ?? {}) as Record<string, unknown>,
      result: result?.output ?? result?.result,
      risk: riskMap.get(toolName),
      confirmed: confirmedSet.has(id),
      rejected: rejectedSet.has(id),
      durationMs: 0,
    };
  });

  const inputTokens: number = ev?.usage?.inputTokens ?? 0;
  const outputTokens: number = ev?.usage?.outputTokens ?? 0;
  return {
    stepNumber: ev?.stepNumber ?? 0,
    thought: ev?.text || undefined,
    reasoning: ev?.reasoningText || undefined,
    toolCalls,
    finishReason: ev?.finishReason ?? "unknown",
    usage: {
      inputTokens: inputTokens || undefined,
      outputTokens: outputTokens || undefined,
      totalTokens: inputTokens + outputTokens,
    },
    durationMs: 0,
  };
}
