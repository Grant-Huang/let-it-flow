import { randomUUID } from "node:crypto";
import type { WorkflowNode, WorkflowDAG } from "../planner/dag-schema.js";
import type { FlowConnector, ToolResult } from "../tools/base.js";
import type { ExecutionContext } from "./context.js";
import { workflowNodePayload, toolCallPayload, toolResultPayload } from "../core/stream-events.js";
import { createDefaultToolRegistry } from "./default-tools.js";

/**
 * 单节点执行（见 07 §7.x）：
 *   1. 若 requireConfirmation，先 emit workflow_node(active) 并走 HITL 门
 *   2. resolveRef(inputRefs) + 合并静态 params
 *   3. 调 tool.execute(params, ctx)，消费其事件流，取最终 ToolResult
 *   4. recordOutput(node.id, result.output)
 *
 * 错误：按 onNodeError 决定 abort（抛错给 executor）或 skip（返回空 output）。
 */
export interface NodeRunnerOptions {
  /** 工具注册表（按 toolName 解析节点对应工具）。 */
  registry: ReturnType<typeof createDefaultToolRegistry>;
}

export interface RunNodeResult {
  output: unknown;
  skipped: boolean;
  /** 节点耗时 ms（含 HITL 等待）。 */
  durationMs: number;
}

export async function runNode(
  node: WorkflowNode,
  dag: WorkflowDAG,
  ctx: ExecutionContext,
  opts: NodeRunnerOptions,
): Promise<RunNodeResult> {
  const tool = opts.registry.get(node.toolName);
  const startedAt = Date.now();
  ctx.bindNode(node);

  // workflow_node(active)
  await ctx.emit({
    type: "workflow_node",
    channel: "status",
    payload: workflowNodePayload({
      run_id: ctx.runId,
      node_id: node.id,
      name: node.toolName,
      state: "active",
      started_at: startedAt,
    }),
  });

  // HITL 门
  if (node.requireConfirmation) {
    const decision = await ctx.requireConfirmation({
      prompt: `节点 ${node.id}（${node.toolName}）需要确认是否执行。`,
      options: ["approve", "reject"],
      detail: { params: node.params },
    });
    if (!decision.approved) {
      // 用户拒绝：该节点跳过（HITL 拒绝不触发 onNodeError，见 P3 测试约定）
      await emitNodeDone(ctx, node, startedAt, "skipped");
      return { output: undefined, skipped: true, durationMs: Date.now() - startedAt };
    }
  }

  if (!tool) {
    return handleError(new Error(`tool not found: ${node.toolName}`), node, dag, ctx, startedAt);
  }

  // 解析 inputRefs 并合并到 params（引用值经 contentPipeline 压缩）
  const params: Record<string, unknown> = { ...node.params };
  for (const [ref, targetKey] of Object.entries(node.inputRefs)) {
    params[targetKey] = ctx.resolveRef(ref);
  }

  try {
    // selfEmitEvents=false 的工具（如 MCP 桥接工具）不自行 emit tool_call/tool_result，
    // 由 node-runner 统一补 emit（selfEmitEvents=true 的内置工具/skill 自己 emit，外层跳过避免重复）。
    const selfEmit = (tool as FlowConnector & { selfEmitEvents?: boolean }).selfEmitEvents === true;
    const callId = `c_${randomUUID().slice(0, 8)}`;
    const startedToolAt = Date.now();
    if (!selfEmit) {
      await ctx.emit({
        type: "tool_call",
        channel: "status",
        payload: toolCallPayload({
          id: callId,
          name: node.toolName,
          args: params,
          risk: (tool as FlowConnector & { risk?: "safe" | "write" | "destructive" }).risk ?? "safe",
          groupId: node.id,
        }),
      });
    }

    const gen = tool.execute(params, ctx);
    let final: ToolResult | undefined;
    while (true) {
      const r = await gen.next();
      if (r.done) {
        final = r.value;
        break;
      }
      // 工具产出的事件直接 emit（工具自己已构造好 type/payload/channel）
      await ctx.emit(r.value);
    }
    const output = final?.output;
    ctx.recordOutput(node.id, output);

    if (!selfEmit) {
      await ctx.emit({
        type: "tool_result",
        channel: "status",
        payload: toolResultPayload({
          tool_call_id: callId,
          output: typeof output === "string" ? output : JSON.stringify(output),
          duration_ms: Date.now() - startedToolAt,
        }),
      });
    }

    await emitNodeDone(ctx, node, startedAt, "done");
    return { output, skipped: false, durationMs: Date.now() - startedAt };
  } catch (e) {
    return handleError(e instanceof Error ? e : new Error(String(e)), node, dag, ctx, startedAt);
  }
}

async function handleError(
  err: Error,
  node: WorkflowNode,
  dag: WorkflowDAG,
  ctx: ExecutionContext,
  startedAt: number,
): Promise<RunNodeResult> {
  const policy = node.onNodeError ?? dag.onNodeError;
  if (policy === "skip") {
    // 记录空 output，标记节点 error，继续后续节点
    ctx.recordOutput(node.id, undefined);
    await emitNodeDone(ctx, node, startedAt, "error", { error: err.message });
    return { output: undefined, skipped: true, durationMs: Date.now() - startedAt };
  }
  // abort：标记节点 error 后向上抛
  await emitNodeDone(ctx, node, startedAt, "error", { error: err.message });
  throw err;
}

async function emitNodeDone(
  ctx: ExecutionContext,
  node: WorkflowNode,
  startedAt: number,
  state: "done" | "error" | "skipped",
  extra?: Record<string, unknown>,
): Promise<void> {
  await ctx.emit({
    type: "workflow_node",
    channel: "status",
    payload: workflowNodePayload({
      run_id: ctx.runId,
      node_id: node.id,
      name: node.toolName,
      state,
      started_at: startedAt,
      duration_ms: Date.now() - startedAt,
      metadata: extra,
    }),
  });
}
