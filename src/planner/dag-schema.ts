import { z } from "zod";

/**
 * WorkflowDAG Zod schema（见 03 §3.x）。
 * MVP 精简：节点用 toolName 引用已注册工具；params/inputRefs 由 executor 解析。
 *
 * 含 P3 关键字段：
 *   - requireConfirmation：HITL 暂停点（见 12）
 *   - onNodeError：节点级容错策略 abort/skip（retry 砍）
 *   - contentPipeline：数据清洗管道配置（见 07 §7.6）
 */

export const ContentPipelineConfig = z.object({
  /** 注入到本节点前的最大 token 数（粗略按 4 字符/token 估算）。默认 4000。 */
  maxTokens: z.number().int().positive().default(4000),
  /** HTML/Markdown 结构净化（剥离标签、导航噪声）。默认 true。 */
  strip: z.boolean().default(true),
  /** 滚动窗口摘要化 —— MVP 砍（永远 false）。P5+ 接小模型摘要时再启用。 */
  summarize: z.boolean().default(false),
  /** summarize 用的模型 id（summarize=true 时必填）。 */
  summarizeModel: z.string().optional(),
  /** 仅保留指定字段（对结构化对象按 key 裁剪）。 */
  fields: z.array(z.string()).optional(),
});
export type ContentPipelineConfig = z.infer<typeof ContentPipelineConfig>;

export const onNodeErrorSchema = z.enum(["abort", "skip"]);
export type OnNodeError = z.infer<typeof onNodeErrorSchema>;

export const WorkflowNode = z.object({
  /** 节点 id（DAG 内唯一）。 */
  id: z.string(),
  /** 引用已注册工具名（如 "core.web_search"）。 */
  toolName: z.string(),
  /** 直接输入参数（静态值）。 */
  params: z.record(z.string(), z.unknown()).default({}),
  /**
   * 上游输出引用：JSONPath → 目标参数键。
   * 例：{ "$.tasks.search_1.output": "context" } 把上游输出注入到 params.context。
   * executor 先 resolveRef 再经 ContentPipeline 压缩。
   */
  inputRefs: z.record(z.string(), z.string()).default({}),
  /** 上游节点 id 列表（决定拓扑顺序）。 */
  dependsOn: z.array(z.string()).default([]),
  /** HITL 暂停点：执行到此节点前等待用户确认。 */
  requireConfirmation: z.boolean().default(false),
  /** 节点级容错策略。abort=整 DAG 终止；skip=跳过本节点（output 为空）。 */
  onNodeError: onNodeErrorSchema.default("abort"),
  /** 数据清洗管道：控制上游输出注入本节点前的压缩策略。 */
  contentPipeline: ContentPipelineConfig.default({}),
});
export type WorkflowNode = z.infer<typeof WorkflowNode>;

export const WorkflowDAG = z.object({
  /** schema 版本。 */
  schemaVersion: z.literal("1.0").default("1.0"),
  /** DAG 内节点列表。 */
  nodes: z.array(WorkflowNode),
  /** DAG 级容错策略（节点未指定 onNodeError 时回退到此）。 */
  onNodeError: onNodeErrorSchema.default("abort"),
  /** 节点重试次数（MVP 砍，保留字段）。 */
  retryAttempts: z.number().int().nonnegative().default(0),
});
export type WorkflowDAG = z.infer<typeof WorkflowDAG>;

/**
 * 拓扑分层：把 DAG 节点按依赖关系分成若干层，同层可并发。
 * 层 i 的节点只依赖层 <i 的节点。存在环则抛错。
 */
export function topologicalLayers(dag: WorkflowDAG): WorkflowNode[][] {
  const nodesById = new Map(dag.nodes.map((n) => [n.id, n]));
  const resolved = new Set<string>();
  const layers: WorkflowNode[][] = [];

  const remaining = new Set(dag.nodes.map((n) => n.id));
  let guard = dag.nodes.length + 1;
  while (remaining.size > 0) {
    if (--guard < 0) {
      throw new Error(`DAG has a cycle among: ${[...remaining].join(", ")}`);
    }
    const layer: WorkflowNode[] = [];
    for (const id of [...remaining]) {
      const node = nodesById.get(id)!;
      if (node.dependsOn.every((dep) => resolved.has(dep))) {
        layer.push(node);
      }
    }
    if (layer.length === 0) {
      throw new Error(`DAG has a cycle or missing deps among: ${[...remaining].join(", ")}`);
    }
    for (const n of layer) {
      remaining.delete(n.id);
      resolved.add(n.id);
    }
    layers.push(layer);
  }
  return layers;
}
