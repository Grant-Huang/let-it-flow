/**
 * Precondition 框架（V 层机制 —— 平台提供注册/检查，应用声明业务规则）。
 *
 * 来自资料洞察："在工具层或编排层显式定义前置条件（precondition），
 * 某类任务在哪些信息被确认之前禁止进入回答阶段——这比靠模型自我感知可靠得多。"
 *
 * 平台只提供"挂钩子"：PreconditionRegistry 维护条件列表 + 提供 check 入口。
 * 应用挂什么条件由应用决定（如 NexusOps 声明"诊断前必须有 OEE 实测 + 停机原因"）。
 */
import type { Precondition, StepTrace } from "./types.js";

/**
 * 前置条件注册表。
 * harness 在 finalize 时遍历注册表检查 on_finalize 型条件；
 * 每步检查 every_step 型条件。
 */
export class PreconditionRegistry {
  private readonly items: Precondition[] = [];

  register(p: Precondition): void {
    if (this.items.some((x) => x.id === p.id)) {
      throw new Error(`precondition 已存在：${p.id}`);
    }
    this.items.push(p);
  }

  list(): Precondition[] {
    return [...this.items];
  }

  /** on_finalize 型条件（缺省）。 */
  finalizeOnes(): Precondition[] {
    return this.items.filter((p) => (p.phase ?? "on_finalize") === "on_finalize");
  }

  /** every_step 型条件。 */
  everyStepOnes(): Precondition[] {
    return this.items.filter((p) => p.phase === "every_step");
  }

  /**
   * 检查所有 on_finalize 条件。
   * @returns 全部满足返回 null；否则返回首个未满足的提示（喂给 LLM 或终止）
   */
  checkFinalize(trace: StepTrace[]): { met: true } | { met: false; precondition: Precondition; missingTool: string; prompt: string } {
    for (const p of this.finalizeOnes()) {
      const r = p.check(trace);
      if (!r.met) {
        return { met: false, precondition: p, missingTool: r.missingTool, prompt: r.prompt };
      }
    }
    return { met: true };
  }

  /**
   * 检查所有 every_step 条件（返回未满足的提示数组，由 harness 注入 prepareStep）。
   */
  checkEveryStep(trace: StepTrace[]): Array<{ precondition: Precondition; missingTool: string; prompt: string }> {
    const out: Array<{ precondition: Precondition; missingTool: string; prompt: string }> = [];
    for (const p of this.everyStepOnes()) {
      const r = p.check(trace);
      if (!r.met) out.push({ precondition: p, missingTool: r.missingTool, prompt: r.prompt });
    }
    return out;
  }
}

/**
 * helper：从 stepTrace 中提取已调用过的工具名集合。
 * 供应用写 precondition.check 时使用。
 */
export function calledToolNames(trace: StepTrace[]): Set<string> {
  const set = new Set<string>();
  for (const step of trace) {
    for (const tc of step.toolCalls) {
      if (!tc.rejected) set.add(tc.toolName);
    }
  }
  return set;
}
