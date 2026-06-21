import type { WorkflowDAG, WorkflowNode } from "../planner/dag-schema.js";
import { topologicalLayers } from "../planner/dag-schema.js";
import { ExecutionContext } from "./context.js";
import { runNode } from "./node-runner.js";
import type { ToolRegistry } from "../tools/registry.js";
import { phasePayload, errorPayload } from "../core/stream-events.js";
import type { StreamEvent } from "../core/stream-events.js";

/**
 * DAG 执行器（见 07 §7.x）：
 *   1. 拓扑分层（topologicalLayers）
 *   2. 逐层执行，同层节点 Promise.all 并发
 *   3. 每节点经 node-runner（HITL 门 + inputRefs 解析 + 工具调用 + 错误策略）
 *   4. abort 策略：某节点抛错则整 DAG 终止，emit error
 *
 * 执行器只负责编排；工具/registry 由外部注入（见 app 工厂）。
 */
export interface ExecutorHooks {
  /** emit 实现（→ TaskStore.append + SSE）。 */
  emit: (event: Omit<StreamEvent, "seq" | "taskId" | "ts">) => Promise<StreamEvent>;
  /** requireConfirmation 实现（→ registry.awaitConfirmation）。 */
  requireConfirmation: (gate: {
    prompt: string;
    options?: string[];
    detail?: Record<string, unknown>;
  }) => Promise<{ approved: boolean; params?: Record<string, unknown> }>;
}

export interface ExecuteDagResult {
  /** 是否所有节点都成功（无 skip 无 abort）。 */
  ok: boolean;
  /** 终止原因（abort 时有）。 */
  error?: string;
}

/**
 * 执行一个 DAG。
 * @param dag       已校验的 WorkflowDAG
 * @param args      taskId / runId / intent / hooks / registry
 */
export async function executeDag(
  dag: WorkflowDAG,
  args: {
    taskId: string;
    runId: string;
    intent: string;
    hooks: ExecutorHooks;
    registry: ToolRegistry;
  },
): Promise<ExecuteDagResult> {
  // #region agent log
  fetch('http://127.0.0.1:7845/ingest/b379246d-e95c-44b9-8a2e-1ef8ddffc36c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'594ab9'},body:JSON.stringify({sessionId:'594ab9',location:'executor.ts:execute-entry',message:'executeDag 入口',data:{taskId:args.taskId,nodes:dag.nodes.map(n=>({id:n.id,tool:n.toolName,confirm:n.requireConfirmation}))},timestamp:Date.now(),hypothesisId:'H4'})}).catch(()=>{});
  // #endregion
  const ctx = new ExecutionContext({
    taskId: args.taskId,
    runId: args.runId,
    nodeId: "",
    emit: args.hooks.emit,
    requireConfirmation: args.hooks.requireConfirmation,
  });
  ctx.setIntent(args.intent);

  const layers = topologicalLayers(dag);

  for (const layer of layers) {
    // 同层并发；任一 abort 抛错则 Promise.all reject → 整体终止
    // #region agent log
    fetch('http://127.0.0.1:7845/ingest/b379246d-e95c-44b9-8a2e-1ef8ddffc36c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'594ab9'},body:JSON.stringify({sessionId:'594ab9',location:'executor.ts:layer-start',message:'执行 layer',data:{taskId:args.taskId,nodes:layer.map(n=>n.id)},timestamp:Date.now(),hypothesisId:'H4'})}).catch(()=>{});
    // #endregion
    try {
      await Promise.all(layer.map((node) => runLayerNode(node, dag, ctx, args.registry)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // #region agent log
      fetch('http://127.0.0.1:7845/ingest/b379246d-e95c-44b9-8a2e-1ef8ddffc36c',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'594ab9'},body:JSON.stringify({sessionId:'594ab9',location:'executor.ts:layer-error',message:'layer 异常',data:{taskId:args.taskId,msg},timestamp:Date.now(),hypothesisId:'H4'})}).catch(()=>{});
      // #endregion
      await ctx.emit({
        type: "error",
        channel: "meta",
        payload: errorPayload(msg, "NODE_ABORTED"),
      });
      return { ok: false, error: msg };
    }
  }

  // 完成 phase（可选：让前端显示整体完成）
  await ctx.emit({ type: "phase", channel: "status", payload: phasePayload("workflow", "工作流执行", "done") });
  return { ok: true };
}

async function runLayerNode(
  node: WorkflowNode,
  dag: WorkflowDAG,
  ctx: ExecutionContext,
  registry: ToolRegistry,
): Promise<void> {
  // 节点开始 phase（粗粒度进度，v2.0：phase 替代 stage）
  await ctx.emit({
    type: "phase",
    channel: "status",
    payload: phasePayload(node.id, node.id, "running"),
  });
  const res = await runNode(node, dag, ctx, { registry });
  await ctx.emit({
    type: "phase",
    channel: "status",
    payload: phasePayload(node.id, node.id, res.skipped ? "error" : "done"),
  });
}
