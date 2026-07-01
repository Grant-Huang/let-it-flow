/**
 * Skill 桥接（L 层）。
 *
 * 把"已验证的 ReAct 轨迹"沉淀为 skill.<name> 工具，被主 ReAct 循环像调普通工具一样调用。
 * skill 内部封装一个迷你流程（动态 steps 函数，支持条件分支/循环/条件 HITL）。
 *
 * 设计意图：消除 react/dag 二元模式——一切都是工具。
 *   - 标准 OEE 诊断流程 → skill.oee_diagnose（内部 5 步序列）
 *   - 停机根因分析 → skill.downtime_root_cause
 *
 * SkillConnector 继承 FlowConnector，故注册进 ToolRegistry 后，
 * harness 的 tool-adapter 自动适配它给主 ReAct 循环，无需特殊处理。
 *
 * 统一动态 DSL：手写 skill 与自动沉淀产物都走 async steps(input) 写法，
 * 由 runDynamicSteps 单一执行路径消费。
 */
import { randomUUID } from "node:crypto";
import type { FlowConnector } from "../tools/base.js";
import type { ToolResult } from "../tools/base.js";
import type { ToolEvent } from "../core/stream-events.js";
import { toolCallPayload, toolResultPayload } from "../core/stream-events.js";

/**
 * 动态 DSL 的步骤执行上下文。
 *
 * 提供 step() 工厂注册步骤、ctx.call() 调注册表工具、ctx.requireConfirmation() HITL。
 * 动态 DSL 能表达条件分支、循环、条件 HITL。
 */
export interface StepCtx {
  /**
   * 调用注册表中的工具（含语义别名）。
   *
   * 别名映射（podcast skill 习惯用法）：
   *   - "thought" / "generate" → core.llm_node
   *   - "kb.search" → core.knowledge_base
   * 其他工具名直接按原名查注册表（如 "core.web_search"）。
   *
   * @returns 工具的 ToolResult.output
   */
  call: <T = unknown>(toolName: string, params: Record<string, unknown>) => Promise<T>;
  /** HITL 确认门（透传 ExecutionContext.requireConfirmation）。 */
  requireConfirmation: ExecutionContext["requireConfirmation"];
  /** 发射事件（透传 ExecutionContext.emit）。 */
  emit: ExecutionContext["emit"];
}

/**
 * 动态 DSL 的步骤工厂（async steps(input) 写法的入参）。
 *
 * input 对象同时携带 skill 输入参数（如 input.sourceText）和 step() 工厂。
 * 用法（podcast skill 示例）：
 * ```ts
 * async steps(input) {
 *   const { step } = input;
 *   // input.sourceText / input.durationMinutes 等是 skill 输入参数
 *   const list = await step("列举线索", async (ctx) => {
 *     return ctx.call("thought", { directive: input.sourceText });
 *   });
 *   ...
 * }
 * ```
 */
export interface StepsInput {
  /** skill 输入参数（外层 execute 的 params，透传到这里）。 */
  [key: string]: unknown;
  /**
   * 声明并执行一个步骤。
   * @param name 步骤名（用于 workflow_node 事件 + 日志）
   * @param fn   步骤执行函数，入参为 StepCtx
   * @returns fn 的返回值（供后续步骤引用）
   */
  step: <T = unknown>(name: string, fn: (ctx: StepCtx) => Promise<T>) => Promise<T>;
  /**
   * skill 级叙述入口（step 外可用）。
   * 直接走 ctx.emit → SSE，绕过 pendingEvents 批量队列，保证叙述实时下发。
   * 用于 skill 开始/结束/分支决策等 step 外场景的人类可读叙述。
   * 详见 docs/20-narrative-output-rules.md。
   *
   * @example
   * async steps(input) {
   *   const { step, narrate } = input;
   *   await narrate("我来写这期口播稿。");
   *   ...
   * }
   */
  narrate: (text: string) => Promise<void>;
  /**
   * skill 结束总结叙述（前置换行，便于前端分隔气泡）。
   */
  narrateSummary: (text: string) => Promise<void>;
}

/** 动态 steps 函数签名。入参是 StepsInput（含 skill params + step 工厂），返回 skill 业务输出。 */
export type DynamicStepsFn<TOutput = unknown> = (input: StepsInput) => Promise<TOutput>;

/** ExecutionContext 别名（从 base.ts 引入，避免循环依赖重复定义）。 */
type ExecutionContext = Parameters<FlowConnector["execute"]>[1];

/**
 * SkillConnector：封装已验证流程的特殊 FlowConnector。
 *
 * 通过 kind="skill" 标识，harness/前端可识别它是沉淀流程。
 * 本体仍是 FlowConnector，故能注册进 ToolRegistry。
 *
 * status 字段标识 skill 成熟度：
 *   - "active"（缺省）：正式 skill，注册进 toolTiers，主循环直接采用结果
 *   - "draft"：试运行 skill，以影子模式运行（结果标记 _shadow，不直接采用，与主循环对比）
 *     连续 N 次与原方法结论一致、无反信号命中才转正（由 SkillRegistry 计数升级）
 */
export interface SkillConnector extends FlowConnector {
  readonly kind: "skill";
  /** 动态步骤函数。 */
  readonly dynamicSteps: DynamicStepsFn;
  /** 成熟度：active（正式）/ draft（试运行，影子模式）。缺省 active。 */
  readonly status?: "draft" | "active";
}

/** createSkill 的 opts。 */
export interface CreateSkillOptions {
  name: string;
  description: string;
  whenToUse: FlowConnector["whenToUse"];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  outputExample: Record<string, unknown>;
  /**
   * 动态步骤函数，支持条件/循环/条件 HITL。
   */
  steps: DynamicStepsFn;
  risk?: "safe" | "write" | "destructive";
  status?: "draft" | "active";
}

/**
 * 创建一个 skill 工具（动态 steps 函数）。
 */
export function createSkill(opts: CreateSkillOptions): SkillConnector {
  const {
    name,
    description,
    whenToUse,
    inputSchema,
    outputSchema,
    outputExample,
    steps: dynamicSteps,
    risk,
    status = "active",
  } = opts;
  const isDraft = status === "draft";

  const connector: SkillConnector = {
    kind: "skill",
    name,
    tier: "domain",
    description: isDraft
      ? `[Skill·draft] ${description}（动态流程，试运行中，结果标 _shadow）`
      : `[Skill] ${description}`,
    inputSchema,
    outputSchema,
    outputExample,
    whenToUse,
    ...(risk ? { risk } : {}),
    dynamicSteps,
    status,

    async *execute(
      params: Record<string, unknown>,
      ctx: Parameters<FlowConnector["execute"]>[1],
    ): AsyncGenerator<ToolEvent, ToolResult> {
      const callId = `c_${randomUUID().slice(0, 8)}`;
      const startedAt = Date.now();

      yield {
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name,
          args: params,
          risk: risk ?? "safe",
          groupId: ctx.nodeId,
        }),
      };

      const results: unknown[] = [];
      const errors: string[] = [];
      /** 动态 DSL 的业务输出（dynamicSteps 的 return 值，与步骤结果分开存放）。 */
      let dynamicOutput: unknown;

      // 动态 DSL 路径：for-await yield 步骤事件
      for await (const ev of runDynamicSteps(dynamicSteps, params, ctx, results, errors)) {
        yield ev;
      }
      dynamicOutput = (results as unknown[] & { _dynamicOutput?: unknown })._dynamicOutput;

      // 动态路径：skill 业务输出优先（dynamicSteps 的 return 值）；
      // 兜底：末步结果
      const lastStepResult =
        dynamicOutput ?? (results.length > 0 ? results[results.length - 1] : undefined);
      const lastIsEvidence = isEvidenceLike(lastStepResult);

      // 1) 如果末步结果是 EvidenceEnvelope，则提升为 skill 的最终输出（保留信封语义），
      //    并把 skill 执行元信息注入 data._skill。
      // 2) 否则用 skill 自己的 envelope 包一层。
      // stepResults 用干净副本（runDynamicSteps 会把 _dynamicOutput 挂到数组上作为属性，
      // 不应进入 skillMeta，避免 toEqual 误判 + 序列化噪音）
      const stepResults = [...results];
      const skillMeta = {
        skillName: name,
        completed: errors.length === 0,
        stepCount: stepResults.length,
        stepResults,
        ...(errors.length > 0 ? { errors } : {}),
      };

      let output: Record<string, unknown>;
      if (lastIsEvidence && lastStepResult && typeof lastStepResult === "object") {
        const env = lastStepResult as {
          data: Record<string, unknown>;
          freshness?: string;
          capturedAt?: string;
          confidence?: string;
          source?: { system?: string; provenance?: string };
          caveat?: string;
        };
        output = {
          ...env,
          data: { ...env.data, _skill: skillMeta },
        };
      } else {
        output = {
          data: { stepResults: results, _skill: skillMeta },
          freshness: "realtime" as const,
          capturedAt: new Date().toISOString(),
          confidence: errors.length === 0 ? "inferred" : "estimated",
          source: { system: "skill", provenance: name },
          ...(errors.length > 0 ? { caveat: errors.join("; ") } : {}),
        };
      }

      // draft 影子模式：标记 _shadow，让主循环/前端识别"这是试运行结果，不直接采用"
      if (isDraft) {
        if (output.data && typeof output.data === "object") {
          output.data = { ...(output.data as Record<string, unknown>), _shadow: true };
        }
        output._shadow = true;
      }

      yield {
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: JSON.stringify(output),
          duration_ms: Date.now() - startedAt,
        }),
      };

      return {
        output,
        summary: `skill ${name} ${errors.length === 0 ? "完成" : "部分失败"}（${results.length} 步）`,
      };
    },
  };

  return connector;
}

// ─────────────────────────────────────────────────────────────────────────────
// 动态 DSL 执行引擎
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 运行动态 steps 函数（AsyncGenerator 版）。
 *
 * 构造 StepsInput（提供 step() 工厂），执行 dynamicSteps。
 * 每个 step() 调用：执行 fn → 结果入 results → 产出 workflow_node 事件（yield）。
 * ctx.call 内部工具的事件也一并 yield（透传到 skill execute 主流）。
 * fn 抛错则记入 errors 并中断（与原有错误语义一致）。
 *
 * 产出顺序：每个 step 完成后 yield 一个 workflow_node 事件；
 *           ctx.call 期间工具的事件在 step 内部 yield。
 */
async function* runDynamicSteps(
  dynamicSteps: DynamicStepsFn,
  params: Record<string, unknown>,
  ctx: ExecutionContext,
  results: unknown[],
  errors: string[],
): AsyncGenerator<ToolEvent, void> {
  const startedAt = Date.now();

  const stepCtx: StepCtx = {
    call: async <T = unknown>(toolName: string, callParams: Record<string, unknown>): Promise<T> => {
      const resolved = resolveToolAlias(toolName);
      const tool = ctx.resolveTool?.(resolved);
      if (!tool) {
        throw new Error(`ctx.call: 工具 "${toolName}"${resolved !== toolName ? `（别名解析为 ${resolved}）` : ""} 未在注册表中找到`);
      }
      // 别名参数标准化：语义别名（thought/generate）的入参名（directive/userPrompt）
      // 映射到底层工具（core.llm_node）的真实字段（prompt），让 skill 作者用自然语义即可。
      const normalized = normalizeAliasParams(toolName, resolved, callParams);
      // 消费工具的 async generator；每个事件实时 emit（而非入队），保证域工具事件与叙述文本正确穿插
      const gen = tool.execute(normalized, ctx);
      let final: ToolResult | undefined;
      while (true) {
        const r = await gen.next();
        if (r.done) {
          final = r.value;
          break;
        }
        await ctx.emit(r.value as never);
      }
      return (final?.output ?? {}) as T;
    },
    requireConfirmation: ctx.requireConfirmation,
    emit: ctx.emit,
  };

  let stepCallCount = 0;

  // 把 skill 输入参数合并进 stepsInput（让 dynamicSteps 能直接访问 input.xxx）
  const stepsInput: StepsInput = {
    ...params,
    narrate: (text: string): Promise<void> =>
      ctx.emit({ type: "text", channel: "content", payload: { delta: text } }).then(() => undefined),
    narrateSummary: (text: string): Promise<void> =>
      ctx.emit({ type: "text", channel: "content", payload: { delta: `\n${text}` } }).then(() => undefined),
    step: async <T = unknown>(stepName: string, fn: (c: StepCtx) => Promise<T>): Promise<T> => {
      const idx = ++stepCallCount;
      try {
        const r = await fn(stepCtx);
        results.push(r);
        await ctx.emit({
          type: "workflow_node",
          channel: "status",
          payload: {
            run_id: ctx.runId,
            node_id: `dynamic#step${idx}`,
            name: stepName,
            state: "done",
            started_at: startedAt,
            duration_ms: Date.now() - startedAt,
          },
        } as never);
        return r;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(`动态步骤 ${idx}（${stepName}）失败：${msg}`);
        throw e;
      }
    },
  };

  // dynamicSteps 的业务输出（与步骤结果分开存放，避免计数混淆）
  let dynamicOutput: unknown;
  try {
    dynamicOutput = await dynamicSteps(stepsInput);
  } catch (e) {
    if (errors.length === 0) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`动态流程执行失败：${msg}`);
    }
  }

  // 把 dynamicOutput 挂到 results 的属性位（供 execute 读取，不污染 results.length 与枚举）
  // 用不可枚举属性，避免 toEqual/JSON 序列化把它误当成 step 结果
  if (dynamicOutput !== undefined) {
    Object.defineProperty(results, "_dynamicOutput", {
      value: dynamicOutput,
      enumerable: false,
      configurable: true,
      writable: true,
    });
  }

}

/**
 * 解析 ctx.call 的语义别名到真实工具名。
 *
 * podcast skill 的习惯用法（不是新引擎，而是查注册表调已有工具）：
 *   - "thought" / "generate" → core.llm_node（LLM 生成节点）
 *   - "kb.search" → core.knowledge_base（知识库查询）
 *
 * 其他工具名（如 "core.web_search"）原样返回。
 */
function resolveToolAlias(alias: string): string {
  switch (alias) {
    case "thought":
    case "generate":
      return "core.llm_node";
    case "kb.search":
      return "core.knowledge_base";
    default:
      return alias;
  }
}

/**
 * 别名参数标准化。
 *
 * 语义别名让 skill 作者用自然字段名（directive/userPrompt），
 * 这里把它们映射到底层工具的真实入参（core.llm_node 的 prompt）。
 * 已是目标字段（prompt）的不动；只补齐缺失的 prompt。
 *
 * 映射规则（core.llm_node）：
 *   - thought 别名：directive → prompt
 *   - generate 别名：userPrompt → prompt（systemPrompt 字段名一致，不动）
 *   - kb.search：query 已与 core.knowledge_base 一致，不动
 */
function normalizeAliasParams(
  alias: string,
  resolved: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (resolved !== "core.llm_node") return params;
  // 仅当未显式提供 prompt 时才从别名字段补齐，避免覆盖
  if (params.prompt !== undefined) return params;
  if (alias === "thought" && params.directive !== undefined) {
    const { directive, ...rest } = params;
    return { ...rest, prompt: directive };
  }
  if (alias === "generate" && params.userPrompt !== undefined) {
    const { userPrompt, ...rest } = params;
    return { ...rest, prompt: userPrompt };
  }
  return params;
}

/** 末步结果是否形如 EvidenceEnvelope（duck-typing）。 */
function isEvidenceLike(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return (
    "data" in o &&
    "freshness" in o &&
    "capturedAt" in o &&
    "confidence" in o &&
    "source" in o
  );
}
