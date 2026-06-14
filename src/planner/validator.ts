import type { WorkflowDAG } from "./dag-schema.js";
import { topologicalLayers } from "./dag-schema.js";
import type { ToolRegistry } from "../tools/registry.js";

/**
 * DAG 结构校验器（见 06 §6.5）。
 * 检测 planner 产出的 DAG 是否结构合法、可执行。
 *
 * MVP 校验项：
 *   1. 非空（至少一个节点）
 *   2. 无环（拓扑分层能成功）
 *   3. 所有 toolName 在 registry 中已注册
 *   4. dependsOn 引用的节点都存在
 *   5. 节点 id 唯一
 *
 * 砍掉的：引用字段类型校验（弱校验）、Critic 语义审校。
 *
 * @returns 错误信息数组；空数组表示通过。
 */
export function validateDag(dag: WorkflowDAG, registry: ToolRegistry): string[] {
  const errors: string[] = [];

  // 1) 非空
  if (dag.nodes.length === 0) {
    errors.push("DAG 不能为空（至少需要一个节点）");
    return errors;
  }

  // 2) 节点 id 唯一
  const ids = new Set<string>();
  const dupIds: string[] = [];
  for (const n of dag.nodes) {
    if (ids.has(n.id)) dupIds.push(n.id);
    ids.add(n.id);
  }
  if (dupIds.length > 0) {
    errors.push(`节点 id 重复：${[...new Set(dupIds)].join(", ")}`);
  }

  // 3) dependsOn 引用存在
  for (const n of dag.nodes) {
    for (const dep of n.dependsOn) {
      if (!ids.has(dep)) {
        errors.push(`节点 ${n.id} 依赖不存在的节点：${dep}`);
      }
    }
  }

  // 4) 无环（拓扑分层会抛错）
  try {
    topologicalLayers(dag);
  } catch (e) {
    errors.push(`拓扑有环或依赖缺失：${e instanceof Error ? e.message : String(e)}`);
  }

  // 5) toolName 已注册
  for (const n of dag.nodes) {
    if (!registry.has(n.toolName)) {
      errors.push(`节点 ${n.id} 引用未注册的工具：${n.toolName}`);
    }
  }

  return errors;
}
