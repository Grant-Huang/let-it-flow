import { JSONPath } from "jsonpath-plus";
import type { ContentPipelineConfig, WorkflowNode } from "../planner/dag-schema.js";
import { applyContentPipeline } from "./content-pipeline.js";
import type { StreamEvent } from "../core/stream-events.js";

/**
 * 执行上下文（见 07 §7.x）：每个节点执行时由 executor 注入。
 *
 *   - recordOutput / resolveRef：JSONPath 解析上游输出，经 ContentPipeline 压缩
 *   - emit：发射事件（→ TaskStore.append + SSE）
 *   - requireConfirmation：HITL 门（→ registry.awaitConfirmation）
 *
 * 引用语法（见 03 §3.x）：
 *   $.tasks.{nodeId}.output          — 整个节点输出
 *   $.tasks.{nodeId}.output.field    — 输出某字段
 *   $.intent                         — 用户原始意图
 */
export interface EmitFn {
  (event: Omit<StreamEvent, "seq" | "taskId" | "ts">): Promise<StreamEvent>;
}
export interface RequireConfirmationFn {
  (gate: {
    prompt: string;
    options?: string[];
    detail?: Record<string, unknown>;
  }): Promise<{ approved: boolean; params?: Record<string, unknown> }>;
}

export class ExecutionContext {
  readonly taskId: string;
  readonly runId: string;
  /** 当前节点 id（executor 在执行该节点前绑定）。 */
  nodeId: string;
  /** 用户原始意图。 */
  intent = "";
  /** contentPipeline 配置（当前节点）。 */
  private contentPipeline: ContentPipelineConfig = { maxTokens: 4000, strip: true, summarize: false };
  /** nodeId → 节点 output。 */
  private readonly outputs = new Map<string, unknown>();

  constructor(args: {
    taskId: string;
    runId: string;
    nodeId: string;
    emit: EmitFn;
    requireConfirmation: RequireConfirmationFn;
  }) {
    this.taskId = args.taskId;
    this.runId = args.runId;
    this.nodeId = args.nodeId;
    this.emit = args.emit;
    this.requireConfirmation = args.requireConfirmation;
  }

  /** 绑定当前节点（executor 在 runNode 前调用）。 */
  bindNode(node: WorkflowNode): this {
    this.nodeId = node.id;
    this.contentPipeline = node.contentPipeline;
    return this;
  }

  /** 记录节点 output（供下游引用）。 */
  recordOutput(nodeId: string, output: unknown): void {
    this.outputs.set(nodeId, output);
  }

  /** 取某节点 output。 */
  getOutput(nodeId: string): unknown {
    return this.outputs.get(nodeId);
  }

  /** 注入用户意图。 */
  setIntent(intent: string): void {
    this.intent = intent;
  }

  /**
   * 解析引用（JSONPath）到具体值，并按当前节点 contentPipeline 压缩。
   * 用于把 inputRefs 的引用解析成可注入 params 的值。
   */
  resolveRef(ref: string): unknown {
    // 引用语法 $.tasks.{nodeId}.output —— 把每个节点输出包到 { output } 下
    const tasks: Record<string, { output: unknown }> = {};
    for (const [id, out] of this.outputs) {
      tasks[id] = { output: out };
    }
    const root = { tasks, intent: this.intent };
    const results = JSONPath({ path: ref, json: root });
    const value = Array.isArray(results) && results.length === 1 ? results[0] : results;
    return applyContentPipeline(value, this.contentPipeline);
  }

  /** 发射事件。 */
  emit: EmitFn;

  /** HITL 确认门。 */
  requireConfirmation: RequireConfirmationFn;
}
