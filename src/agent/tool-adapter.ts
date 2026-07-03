/**
 * 工具适配器（T 层框架）。
 *
 * 把 let-it-flow 的 FlowConnector（平台工具契约）适配成 AI SDK v6 的 tool()
 * 工厂产出物。这样平台已有的全部工具（core.* + 应用注册的 domain.* / custom.*）
 * 都能被 ReAct 主循环复用，无需重复实现工具协议。
 *
 * 适配职责：
 *   1. description：拼入 whenToUse（triggers/notFor），让 LLM 选对工具
 *   2. inputSchema：FlowConnector.inputSchema（JSON Schema 形态）用 jsonSchema() 包装
 *   3. execute：
 *      - 若 risk=write/destructive，先走 HITL 确认门
 *      - 调 FlowConnector.execute（async generator），消费 ToolEvent 流
 *      - ToolEvent 经 emit 桥接到 SSE
 *      - 返回最终 ToolResult.output 给 SDK 作为 Observation
 */
import { tool, jsonSchema } from "ai";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import zodToJsonSchema from "zod-to-json-schema";
import type { FlowConnector, ToolResult } from "../tools/base.js";
import type { ToolEvent } from "../core/stream-events.js";
import type { HitlGateFn, EmitFn } from "./types.js";
import { toolCallPayload, toolStatusPayload, toolResultPayload } from "../core/stream-events.js";

/** tool-adapter 依赖的外部能力（由 harness 注入）。 */
export interface ToolAdapterDeps {
  /** HITL 决策门（write/destructive 工具触发）。 */
  requireConfirmation?: HitlGateFn;
  /** 事件发射器（→ SSE）。 */
  emit?: EmitFn;
  /**
   * 按名查注册表工具（DSL ctx.call 用）。
   * skill 的动态 DSL 用 ctx.call("thought", params) 调已注册工具，
   * 此函数把别名解析后查 ToolRegistry 返回 FlowConnector。
   * 缺省 undefined（非 DSL 场景不需要）。
   */
  resolveTool?: (name: string) => FlowConnector | undefined;
  /**
   * Governance preToolUse 钩子（G 层阻断规则）。
   * 工具执行前调用；返回 allow=false 则拒绝执行（不发请求）。
   * 注意：与 HITL 不同，governance 是确定性阻断（不询问用户）。
   */
  governancePreToolUse?: (
    toolName: string,
    args: unknown,
    risk: "safe" | "write" | "destructive",
  ) => { allow: true } | { allow: false; reason: string };

  /**
   * Governance postToolUse 钩子（G 层过程侧一致性校验）。
   * 工具执行后、结果返回 LLM 前调用；可 warn（注入 _warnings）或 block（替换结果）。
   */
  governancePostToolUse?: (
    toolName: string,
    args: unknown,
    result: unknown,
  ) =>
    | { pass: true }
    | { pass: false; reason: string; severity?: "warn" | "block" };
}

/**
 * 把单个 FlowConnector 适配成 AI SDK v6 的 tool。
 *
 * @param connector  平台工具契约
 * @param deps       HITL + emit 依赖
 * @param ctxMeta    透传到 FlowConnector.execute 的 ExecutionContext 字段（taskId/runId/nodeId）
 */
export function adaptTool(
  connector: FlowConnector,
  deps: ToolAdapterDeps,
  ctxMeta: { taskId: string; runId: string; nodeId: string },
) {
  // 拼 description：核心描述 + triggers/notFor
  const triggers = connector.whenToUse.triggers.join("、");
  const notFor = connector.whenToUse.notFor.join("、");
  const risk = (connector as FlowConnector & { risk?: "safe" | "write" | "destructive" }).risk ?? "safe";
  const description = [
    connector.description,
    `适用场景：${triggers}`,
    notFor ? `不适用：${notFor}` : "",
    risk !== "safe" ? `风险等级：${risk}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return tool<Record<string, unknown>, Record<string, unknown>>({
    description,
    // FlowConnector.inputSchema 是 JSON Schema 对象形态；用 jsonSchema() 包装成 FlexibleSchema
    // 部分内置工具用 zod .shape 形态（无顶层 type），function calling 要求顶层 type:object，这里兜底补上。
    inputSchema: jsonSchema(withObjectType(connector.inputSchema)),
    execute: async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {      const startedAt = Date.now();
      const callId = `c_${randomUUID().slice(0, 8)}`;

      // G 层 governance 钩子：确定性阻断（先于 HITL，不询问用户）
      if (deps.governancePreToolUse) {
        const decision = deps.governancePreToolUse(connector.name, args, risk);
        if (!decision.allow) {
          const output = { skipped: true, reason: decision.reason, governance_blocked: true };
          await safeEmit(deps.emit, {
            type: "tool_call",
            channel: "status",
            payload: toolCallPayload({
              id: callId,
              name: connector.name,
              args,
              risk,
              groupId: ctxMeta.nodeId,
            }),
          });
          await safeEmit(deps.emit, {
            type: "tool_result",
            channel: "status",
            payload: toolResultPayload({
              tool_call_id: callId,
              output: JSON.stringify(output),
              duration_ms: Date.now() - startedAt,
            }),
          });
          return output;
        }
      }

      // skill connector 自己的 execute() 会 emit tool_call/tool_result，
      // 不再从外层再 emit 一次，避免同一 skill 在 eventLog 中出现两次。
      const isSkill = (connector as { kind?: string }).kind === "skill";

      // 发 tool_call 事件（SSE 可见）
      if (!isSkill) {
        await safeEmit(deps.emit, {
          type: "tool_call",
          channel: "status",
          payload: toolCallPayload({
            id: callId,
            name: connector.name,
            args,
            risk,
            groupId: ctxMeta.nodeId,
            metadata: { custom: { description: connector.uiLabel ?? connector.description } },
          }),
        });
      }

      let confirmed: boolean | undefined;
      let rejected = false;

      // HITL 门：write/destructive 工具需用户确认
      if ((risk === "write" || risk === "destructive") && deps.requireConfirmation) {
        await safeEmit(deps.emit, {
          type: "tool_status",
          channel: "status",
          payload: toolStatusPayload({
            id: callId,
            status: "awaiting_confirm",
          }),
        });
        const decision = await deps.requireConfirmation({
          prompt: `工具 ${connector.name}（风险：${risk}）需要确认是否执行。`,
          options: ["approve", "reject"],
          detail: { tool: connector.name, args, risk },
        });
        confirmed = decision.approved;
        if (!decision.approved) {
          rejected = true;
          const output = { skipped: true, reason: "用户拒绝", rejected: true };
          await safeEmit(deps.emit, {
            type: "tool_result",
            channel: "status",
            payload: toolResultPayload({
              tool_call_id: callId,
              output: JSON.stringify(output),
              duration_ms: Date.now() - startedAt,
            }),
          });
          return output;
        }
      }

      // 构造最小 ExecutionContext（FlowConnector.execute 需要的子集）
      const ctx = buildAdapterContext(ctxMeta, deps, { callId }) as unknown as Parameters<
        FlowConnector["execute"]
      >[1];

      try {
        // 调 FlowConnector.execute（async generator），消费事件流
        const gen = connector.execute(args, ctx);
        let final: ToolResult | undefined;
        while (true) {
          const r = await gen.next();
          if (r.done) {
            final = r.value;
            break;
          }
          // 工具产出的 ToolEvent 经 emit 桥接到 SSE
          await safeEmit(deps.emit, r.value as unknown as { type: string; channel?: string; payload: Record<string, unknown> });
        }

        const rawOutput = final?.output;
        const narration = final?.narration;

        // G 层 postToolUse 钩子：过程侧一致性校验（warn 注入 _warnings / block 替换结果）
        let output: unknown = rawOutput;
        if (deps.governancePostToolUse) {
          const verdict = deps.governancePostToolUse(connector.name, args, rawOutput);
          if (!verdict.pass) {
            const severity = verdict.severity ?? "warn";
            if (severity === "block") {
              // 替换结果：让 LLM 看到"这个证据不可用，需重取"
              output = { blocked: true, reason: verdict.reason };
            } else {
              // warn：保留原结果，注入 _warnings（LLM 可见，据此交叉验证）
              if (output && typeof output === "object") {
                output = {
                  ...(output as Record<string, unknown>),
                  _warnings: [
                    ...((output as Record<string, unknown>)._warnings as string[] ?? []),
                    verdict.reason,
                  ],
                };
              }
            }
          }
        }

        if (!isSkill) {
          await safeEmit(deps.emit, {
            type: "tool_result",
            channel: "status",
            payload: toolResultPayload({
              tool_call_id: callId,
              output: typeof output === "string" ? output : JSON.stringify(output),
              duration_ms: Date.now() - startedAt,
            }),
          });
        }

        // 激活工具 return 的 narration 字段：作为实时 text 事件下发，
        // 让工具未显式调 narrate() 的结束摘要也能进对话流（如 deliver/llm_node）。
        if (narration) {
          await safeEmit(deps.emit, {
            type: "text",
            channel: "content",
            payload: { delta: narration },
          });
        }

        return typeof output === "object" && output !== null
          ? (output as Record<string, unknown>)
          : { value: output };
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        await safeEmit(deps.emit, {
          type: "tool_result",
          channel: "status",
          payload: toolResultPayload({
            tool_call_id: callId,
            output: JSON.stringify({ error: errMsg }),
            duration_ms: Date.now() - startedAt,
          }),
        });
        throw e;
      }
    },
  });
}

/**
 * 批量适配：把 ToolRegistry 的全部工具（按 tier 过滤）转成 AI SDK 的 ToolSet。
 * 工具名中的点号（如 "core.web_search"）转成下划线（"core_web_search"），
 * 因为部分 provider 不支持点号工具名。
 */
export function adaptToolSet(
  connectors: FlowConnector[],
  deps: ToolAdapterDeps,
  ctxMeta: { taskId: string; runId: string; nodeId: string },
): Record<string, ReturnType<typeof adaptTool>> {
  const set: Record<string, ReturnType<typeof adaptTool>> = {};
  for (const c of connectors) {
    const key = toolNameToKey(c.name);
    set[key] = adaptTool(c, deps, ctxMeta);
  }
  return set;
}

/** "core.web_search" → "core_web_search"（SDK 工具名安全化）。 */
export function toolNameToKey(name: string): string {
  return name.replace(/[.-]/g, "_");
}

/** "core_web_search" → "core.web_search"（逆向，step trace 还原）。 */
export function keyToToolName(key: string): string {
  return key.replace(/_/g, ".");
}

/** 构造 FlowConnector.execute 所需的最小 ExecutionContext 子集。 */
function buildAdapterContext(
  ctxMeta: { taskId: string; runId: string; nodeId: string },
  deps: ToolAdapterDeps,
  extra?: { callId?: string },
) {
  return {
    taskId: ctxMeta.taskId,
    runId: ctxMeta.runId,
    nodeId: ctxMeta.nodeId,
    intent: "",
    ...(extra?.callId ? { callId: extra.callId } : {}),
    emit: async (event: ToolEvent) => {
      await safeEmit(deps.emit, event as unknown as { type: string; channel?: string; payload: Record<string, unknown> });
    },
    requireConfirmation: async (gate: Parameters<HitlGateFn>[0]) => {
      if (!deps.requireConfirmation) return { approved: true };
      return deps.requireConfirmation(gate);
    },
    resolveRef: (_ref: string) => undefined, // ReAct 模式无 DAG inputRefs
    resolveTool: deps.resolveTool, // DSL ctx.call 用（查注册表调其他工具）
    recordOutput: () => {},
    getOutput: () => undefined,
    bindNode: () => ({}),
    setIntent: () => {},
  };
}

/** 安全 emit：emit 未配置时静默跳过。 */
async function safeEmit(
  emit: EmitFn | undefined,
  event: { type: string; channel?: string; payload: unknown },
): Promise<void> {
  if (!emit) return;
  try {
    await emit(event);
  } catch {
    // emit 失败不阻塞工具执行（SSE 出口故障不应影响 ReAct 主循环）
  }
}

/**
 * 兜底保证 inputSchema 是合法的 JSON Schema（顶层 type:"object"）。
 *
 * function calling（OpenAI/DeepSeek）要求工具参数 schema 必须是合法 JSON Schema 对象。
 * 但部分内置工具（web_search/deliver/llm_node/web_fetch/text-steps）把 zod schema 的
 * .shape（一个 {key: ZodType} 映射，属性值仍是 Zod 内部结构）当 inputSchema，
 * 在旧 DAG planner 里只作上下文喂 LLM 没问题，但 function calling 严格校验会 400。
 *
 * 此 helper 处理三种形态：
 *   1) 整体是 zod schema（含 _def）→ 直接 zod-to-json-schema 转换
 *   2) 是 .shape 映射（属性值含 Zod 标记）→ 包成 z.object 再转换
 *   3) 已是 JSON Schema 但缺顶层 type → 补 type:"object"
 */
function withObjectType(schema: Record<string, unknown>): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };

  // 形态 1：整体 zod schema
  if (isZodSchema(schema)) {
    return convertZod(schema as never) ?? { type: "object", properties: {} };
  }

  // 形态 2：.shape 映射（属性值是 zod）
  if (hasZodProperties(schema)) {
    try {
      const wrapped = z.object(schema as never);
      return convertZod(wrapped as never) ?? toFallbackObject(schema);
    } catch {
      return toFallbackObject(schema);
    }
  }

  // 形态 3：已是 JSON Schema
  if (schema.type) return schema;
  return { type: "object", ...schema };
}

/** zod schema → JSON Schema（draft-07，失败返回 undefined）。 */
function convertZod(s: never): Record<string, unknown> | undefined {
  try {
    // 用默认 draft-07（openApi3 target 会把 exclusiveMinimum 等产出成布尔，DeepSeek/OpenAI 不接受）
    const converted = zodToJsonSchema(s) as Record<string, unknown>;
    if (converted && typeof converted === "object") {
      // 剥掉 $schema / additionalProperties:false（部分 provider 对全字段严格校验不友好）
      const { $schema, additionalProperties, ...rest } = converted;
      void $schema;
      void additionalProperties;
      return rest;
    }
  } catch {
    // 转换失败降级
  }
  return undefined;
}

/** 对象的任一属性值是 zod schema → 视为 .shape 映射。 */
function hasZodProperties(o: Record<string, unknown>): boolean {
  for (const v of Object.values(o)) {
    if (isZodSchema(v)) return true;
  }
  return false;
}

/** 降级：剥掉 zod 属性，保留可安全序列化的描述字段，补 type:object。 */
function toFallbackObject(o: Record<string, unknown>): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (!isZodSchema(v)) properties[k] = v;
  }
  return { type: "object", properties };
}

/** 检测对象是否是 zod schema 实例（含 _def / typeName / ~standard 标记）。 */
function isZodSchema(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  return "_def" in o || "typeName" in o || "~standard" in o;
}
