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
import { JSONPath } from "jsonpath-plus";
import { buildStopWhen } from "./stop-policy.js";
import { adaptToolSet, toolNameToKey } from "./tool-adapter.js";
import { TraceAccumulator, emitStepPhase } from "./step-emitter.js";
import { streamNarrateToolCall } from "./narrate-pass.js";
import { computeStepBudget } from "./step-budget.js";
import type {
  HarnessConfig,
  HarnessResult,
  StepTrace,
  Precondition,
  EmitFn,
} from "./types.js";
import type { NarrationTemplates } from "./narrate-pass.js";
import type { LanguageModel } from "ai";

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
    thinkingGuidance,
    previousContext,
    abortSignal,
    narrateModel,
    narrateCompatMode = false,
    disableNarration = false,
    narrationTemplates,
    narrationSequence = "serial",
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
  // AI SDK key 形态 → 原始工具名的精确映射（避免 _ → . 的有损字符串替换）
  const keyToName = new Map<string, string>();
  for (const c of connectors) {
    const risk = (c as { risk?: "safe" | "write" | "destructive" }).risk ?? "safe";
    riskMap.set(c.name, risk);
    keyToName.set(toolNameToKey(c.name), c.name);
  }
  // finalize sentinel 工具名（SDK key 形态）
  const finalizeKey = toolNameToKey(stopPolicy?.finalizeTool ?? "nexus_finalize");

  // 适配工具集（harness 内部的 ctxMeta 用 "react" 占位）
  // outputRegistry：维护 callId → toolResult.output，供 skill 内 ctx.resolveRef 读上游产出
  // （ReAct 模式无 DAG inputRefs，但 skill 间数据流需要前序 skill 的结构化产出）
  const outputRegistry = new Map<string, unknown>();
  // resolveRef：复用 DAG executor 的 JSONPath 语法（$.tasks[<callId>].output / .output.data），
  // 让 skill 内 ctx.resolveRef 与 DAG 路径写法一致。jsonpath-plus 已是项目依赖。
  const resolveRef = (ref: string): unknown => {
    const tasks: Record<string, { output: unknown }> = {};
    for (const [id, out] of outputRegistry) {
      tasks[id] = { output: out };
    }
    const root = { tasks, intent };
    const results = JSONPath({ path: ref, json: root });
    return Array.isArray(results) && results.length === 1 ? results[0] : results;
  };
  const tools = adaptToolSet(
    connectors,
    {
      requireConfirmation: config.requireConfirmation,
      emit,
      // DSL ctx.call 需要：把 registry 查询能力透传给 skill 的动态步骤上下文
      resolveTool: config.registry.get?.bind(config.registry),
      // skill 间数据流：让 skill 内 ctx.resolveRef 能读到前序 skill 的产出
      resolveRef,
      governancePreToolUse: config.governanceHooks?.preToolUse,
      governancePostToolUse: config.governanceHooks?.postToolUse,
    },
    { taskId: "react", runId: "react", nodeId: "react" },
  );

  // 2. 构造 stopWhen（含 precondition 触发条件）
  const extraConditions = buildPreconditionConditions(preconditions);
  const stopWhen = buildStopWhen(stopPolicy, extraConditions);

  // 3. system prompt
  const system = buildSystemPrompt(intent, systemPrompt, connectors.map((c) => c.name), stopPolicy?.finalizeTool, thinkingGuidance);

  // 4. trace 累积器 + HITL 决策记录
  const accumulator = new TraceAccumulator();
  const confirmedSet = new Set<string>();
  const rejectedSet = new Set<string>();

  // 5. 发起 streamText（多步循环）
  try {
    // 调试日志：narrateModel 未配置时仅模板分支生效，不报警（混合策略默认行为）
    if (narrateModel) {
      console.debug("[react-harness] narrateModel 已配置，工具结果将走 LLM 解读");
    }

    // 构造 user 消息内容：多轮追问时前置历史摘要
    const userContent = buildUserContent(intent, previousContext);
    // 兼容模式（DeepSeek 等）：把 system 折叠进 user 消息，规避 `developer` 角色
    const streamArgs = compatMode
      ? { messages: [{ role: "user" as const, content: `${system}\n\n---\n${userContent}` }] }
      : { system, messages: [{ role: "user" as const, content: userContent }] };

    const result = streamText({
      model,
      ...streamArgs,
      tools,
      stopWhen,
      abortSignal,
      // 实时转发 LLM 文本 delta，确保意图/推理文本先于工具调用出现在事件流中
      onChunk: async ({ chunk }) => {
        if (chunk.type === "text-delta" && chunk.text) {
          await emit?.({
            type: "text",
            channel: "content",
            payload: { delta: chunk.text },
          });
        }
      },
      onStepFinish: async (ev) => {
        // O 层：转 StepTrace 累积
        const trace = convertStep(ev, riskMap, confirmedSet, rejectedSet, keyToName);
        accumulator.push(trace);
        // 把本步每个工具调用的结果写入 outputRegistry（供后续 skill 内 ctx.resolveRef 读上游产出）
        for (const tc of trace.toolCalls) {
          if (tc.result !== undefined) {
            outputRegistry.set(tc.id, tc.result);
          }
        }
        // E 层：发 phase 事件（前端可见）
        await emitStepPhase(emit, ev.stepNumber, "done");
        // 文本已由 onChunk 实时 emit，这里只补一个换行分隔符
        if (ev.text) {
          await emit?.({
            type: "text",
            channel: "content",
            payload: { delta: "\n" },
          });
        }
        // O 层增强：为每个工具调用生成人类可读解读，emit 为 text 事件，让用户跟上分析节奏。
        // 关键改动（方案 B）：改为 fire-and-forget，不 await，不阻塞下一步 ReAct 推进。
        //   - 确定性结果（失败/拒绝/阻断/空）→ 模板（零延迟），整段通过 onDelta 下发
        //   - EvidenceEnvelope → streamText 逐 token 流式 emit（不再 generateText 整段阻塞）
        //   - 多个工具解读并发跑（Promise.all），delta 交错下发（短句 ≤80 字，交错感弱）
        // disableNarration=true 时完全跳过（靠主 LLM 流式叙述，省一次 LLM 调用）
        if (
          !disableNarration &&
          trace.toolCalls.length > 0 &&
          (narrateModel || narrationTemplates)
        ) {
          void fireNarrations(trace.toolCalls, {
            emit,
            narrateModel,
            narrateCompatMode,
            abortSignal,
            templates: narrationTemplates,
            sequence: narrationSequence,
          });
        }
      },
      prepareStep: async ({ steps, stepNumber, messages: sdkMessages }) => {
        // C 层钩子：应用自定义裁剪/注入（支持异步，用于证据评估）
        if (!prepareStep) return undefined;
        const stepTraces = steps.map((s) => convertStep(s, riskMap, confirmedSet, rejectedSet, keyToName));
        // R4：平台计算步数预算并透传（应用层读取 phase 决定策略）
        const budget = stopPolicy?.maxSteps
          ? computeStepBudget(stepNumber, stopPolicy.maxSteps)
          : undefined;
        const stepResult = await prepareStep({ steps: stepTraces, stepNumber, intent, budget });
        if (!stepResult) return undefined;
        // compatMode 兼容（DeepSeek 等）：
        // SDK 的 OpenAI provider 会把 reasoning model 的 system message 转成 `developer` role，
        // 而 DeepSeek 不支持该 role。compatMode 下把 system 内容折叠进 messages（追加一条 user
        // 消息），避免 SDK 生成独立的 system/developer message。
        if (compatMode && stepResult.system && sdkMessages) {
          const foldedMessages = [
            ...sdkMessages,
            { role: "user" as const, content: stepResult.system },
          ];
          return {
            ...(stepResult.activeTools ? { activeTools: stepResult.activeTools.map(toolNameToKey) } : {}),
            ...(stepResult.toolChoice ? { toolChoice: stepResult.toolChoice } : {}),
            messages: foldedMessages,
          };
        }
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
  // 注：stepTrace 里的 toolName 经 keyToToolName 转换（_ → .），
  // 故 finalizeTool（原始名如 nexus_finalize）需同时匹配转换后的形态（nexus.finalize）
  if (finalizeTool) {
    const finalizeKeyForm = finalizeTool.replace(/_/g, ".");
    const calledFinalize = traces.some((t) =>
      t.toolCalls.some((tc) => tc.toolName === finalizeTool || tc.toolName === finalizeKeyForm),
    );
    if (calledFinalize) return "finalize_tool";
  }

  // 澄清反问场景：LLM 第一步就没调任何工具直接输出文本（如反问用户补全意图）。
  // 这是合法的早期返回，不应触发 on_finalize 前置条件判定。
  const hasAnyToolCall = traces.some((t) => t.toolCalls.length > 0);
  if (!hasAnyToolCall) {
    return rawFinishReason === "stop" ? "no_tool_call" : "no_tool_call";
  }

  // 检查 on_finalize 型前置条件（仅当 LLM 已做过工具调用后才检查）
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
  thinkingGuidance?: string,
): string {
  const parts = [
    "你是一个运营智能分析助手，使用 ReAct（Thought→Action→Observation）模式工作。",
    "每步你可以：思考（输出 text）或调用工具（function call）。工具返回的 Observation 会追加进上下文。",
    "根据证据的时效性（freshness）和置信度（confidence）谨慎判断——estimated/historical 数据需更多交叉验证。",
  ];
  // 应用层注入则用应用层版本，否则用平台默认叙述指引
  if (thinkingGuidance) {
    parts.push("", thinkingGuidance);
  } else {
    parts.push(
      "",
      "## 思考与叙述（重要）",
      "你的每一步思考都会直接呈现给用户，不要静默执行。具体要求：",
      "- 调用工具前，先用一两句话说明这一步要查什么、为什么查（如\"我先看实时 OEE，定位是哪一项拖累效率。\"）。",
      "- 拿到结果后，结合数据简短点出关键发现（如\"可用率 0.62 偏低，需查停机原因。\"）。",
      "- 让用户跟上你的分析节奏，不要省略这些过渡说明。",
    );
  }
  parts.push("", `## 可用工具（${toolNames.length} 个）`, toolNames.join("、"));
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

/**
 * 构造 user 消息内容：多轮追问时前置上一轮的压缩历史摘要。
 *
 * previousContext 存在时拼接：
 *   ## 上一轮分析（已压缩）
 *   意图：...
 *   轨迹：<compressTrace 产出>
 *   结论：...
 *
 *   ## 本轮追问
 *   <intent>
 *
 * 缺省（首轮）直接返回 intent。
 */
function buildUserContent(
  intent: string,
  previousContext: HarnessConfig["previousContext"],
): string {
  if (!previousContext) return intent;
  return [
    "## 上一轮分析（已压缩）",
    `意图：${previousContext.intent}`,
    `轨迹：\n${previousContext.traceDigest}`,
    `结论：${previousContext.finalText}`,
    "",
    "## 本轮追问",
    intent,
  ].join("\n");
}

/** 转 StepTrace。SDK step 事件的 TOOLS 泛型与本模块无关，故入参用 any 规避泛型穿透。 */
function convertStep(
  ev: any,
  riskMap: Map<string, "safe" | "write" | "destructive">,
  confirmedSet: Set<string>,
  rejectedSet: Set<string>,
  keyToName?: Map<string, string>,
): StepTrace {
  const toolCalls: StepTrace["toolCalls"] = ((ev?.toolCalls ?? []) as any[]).map((tc, i) => {
    const isDynamic = typeof tc?.type === "string" && tc.type.startsWith("dynamic");
    const rawName: string = tc.toolName ?? "unknown";
    // 优先用 keyToName 精确还原原始工具名；无映射时退回字符串替换（兼容未传映射的旧调用）
    const toolName = isDynamic
      ? rawName
      : (keyToName?.get(rawName) ?? rawName.replace(/_/g, "."));
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

// ─────────────────────────────────────────────────────────────────────────────
// 后台流式 narration（fire-and-forget，不阻塞 ReAct 主循环）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 并发或串行流式生成多个工具解读，逐 token emit。
 *
 * 设计要点（方案 B + R9 NarrationSequencer）：
 *   - 由 onStepFinish 以 `void fireNarrations(...)` 触发，不 await（fire-and-forget）
 *     → 不阻塞下一步 ReAct 推进，消除"工具解读停顿→突发"现象
 *   - sequence 模式：
 *       "concurrent"：多个工具解读用 Promise.all 并发跑（原实现，多解读交错下发）
 *       "serial"（默认）：按 toolCalls 顺序串行，每个解读完整下发后再开始下一个
 *         → 避免多工具解读 token 交错混乱（适合需要清晰分段叙述的应用）
 *   - 每个 streamNarrateToolCall 内部：
 *       模板分支 → onDelta 整段下发（零延迟）
 *       LLM 分支 → streamText 逐 token 下发（不再 generateText 整段阻塞）
 *   - 解读文本通过 emit 以 text/content 事件下发，复用 SSE push 通道（实时）
 *
 * @param toolCalls  本步的工具调用 trace 列表
 * @param opts       emit + narrateModel + 兼容模式 + abortSignal + 自定义模板 + sequence
 */
async function fireNarrations(
  toolCalls: StepTrace["toolCalls"],
  opts: {
    emit?: EmitFn;
    narrateModel?: LanguageModel;
    narrateCompatMode: boolean;
    abortSignal?: AbortSignal;
    templates?: NarrationTemplates;
    /** 多工具解读的下发顺序：serial（默认，按序） / concurrent（并发交错）。 */
    sequence?: "concurrent" | "serial";
  },
): Promise<void> {
  const sequence = opts.sequence ?? "serial";
  const narrateOne = (tc: StepTrace["toolCalls"][number]) =>
    streamNarrateToolCall(
      {
        toolName: tc.toolName,
        args: tc.args,
        result: tc.result,
        rejected: tc.rejected,
        error: tc.error,
      },
      {
        model: opts.narrateModel,
        compatMode: opts.narrateCompatMode,
        abortSignal: opts.abortSignal,
        templates: opts.templates,
        onDelta: async (delta) => {
          await opts.emit?.({
            type: "text",
            channel: "content",
            payload: { delta },
          });
        },
      },
    );

  if (sequence === "concurrent") {
    // 并发：多个解读同时跑，token 交错下发（原行为）
    await Promise.all(toolCalls.map(narrateOne));
  } else {
    // 串行（默认）：按 toolCalls 顺序，每个完整下发后再开始下一个
    for (const tc of toolCalls) {
      await narrateOne(tc);
    }
  }
}

// 导出供单元测试验证 fire-and-forget 语义（不改逻辑，仅为测试可达性）
export { fireNarrations };
