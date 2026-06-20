/**
 * NexusOps mock 动作状态存储（应用层 —— T 内容）。
 *
 * 目的：让 mock 的 write/destructive 动作工具（mcp.mes.* / mcp.qms.* 等）
 * 能产生**可被后续读取工具观察到**的副作用，从而让 ReAct 链路里
 * "诊断 → 建议 → 执行动作 → 复检" 形成闭环证据。
 *
 * 设计为进程内单例 + 会话级重置（每个 e2e case / 每次 boot 可 reset）。
 * 不落盘（mock 不需要持久化），仅保存在内存。
 *
 * 记录两类状态：
 *   1. actionLog：按序记录每次动作调用（工具名 + 参数 + 时间 + 结果回执）
 *   2. overrides：按 `${scenarioId}:${line}:${field}` 累积的字段覆盖
 *      （读取工具通过 lookupOverride() 查询，命中则用覆盖值替代 mock seed）
 */
import type { ScenarioId, LineId } from "./scenarios.js";

/** 单次动作执行记录。 */
export interface ActionRecord {
  /** 动作工具全名（如 mcp.mes.schedule_work_order）。 */
  tool: string;
  /** 调用参数。 */
  args: Record<string, unknown>;
  /** 执行时间 ISO。 */
  executedAt: string;
  /** 执行回执（动作工具返回的结构化结果）。 */
  receipt: ActionReceipt;
  /** 是否经过 HITL 确认（write/destructive）。 */
  confirmed: boolean;
}

/** 动作执行回执（统一形态，便于证据引用）。 */
export interface ActionReceipt {
  /** 业务单据号 / 操作 id（mock 生成，如 WO-20260620-001）。 */
  ticketId: string;
  /** 状态：accepted（已受理）/ scheduled（已排程）/ executed（已执行）/ rejected（被拒）。 */
  status: "accepted" | "scheduled" | "executed" | "rejected";
  /** 摘要（喂给 LLM 作 observation）。 */
  summary: string;
  /** 对读取侧的副作用覆盖（key 为字段名，value 为新值）。 */
  sideEffects?: Record<string, unknown>;
}

/** 字段覆盖 key。 */
function overrideKey(scenarioId: ScenarioId, line: LineId | undefined, field: string): string {
  return `${scenarioId}:${line ?? "_"}:${field}`;
}

class MockActionStore {
  /** 按序的动作日志。 */
  private log: ActionRecord[] = [];
  /** 字段覆盖表（读取工具查询）。 */
  private overrides = new Map<string, unknown>();

  /** 重置（会话级隔离用）。 */
  reset(): void {
    this.log = [];
    this.overrides.clear();
  }

  /** 记录一次动作执行 + 应用其副作用覆盖。 */
  record(rec: ActionRecord): void {
    this.log.push(rec);
    if (rec.receipt.sideEffects) {
      const scenario = (rec.args.scenarioId as ScenarioId) ?? "anomaly";
      const line = (rec.args.line as LineId) ?? undefined;
      for (const [field, value] of Object.entries(rec.receipt.sideEffects)) {
        this.overrides.set(overrideKey(scenario, line, field), value);
      }
    }
  }

  /** 全量动作日志（只读视图）。 */
  all(): readonly ActionRecord[] {
    return this.log;
  }

  /** 查询字段覆盖（读取工具用：命中返回新值，未命中返回 undefined）。 */
  lookupOverride(scenarioId: ScenarioId, line: LineId | undefined, field: string): unknown {
    return this.overrides.get(overrideKey(scenarioId, line, field));
  }

  /** 是否有任何动作被执行过（用于"动作执行后复检"场景判定）。 */
  hasActions(): boolean {
    return this.log.length > 0;
  }

  /** 生成 mock 单据号（按工具前缀 + 序号）。 */
  nextTicket(prefix: string): string {
    const seq = String(this.log.length + 1).padStart(3, "0");
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    return `${prefix}-${date}-${seq}`;
  }
}

/** 进程内单例。 */
export const actionStore = new MockActionStore();
