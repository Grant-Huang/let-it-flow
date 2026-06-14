import { randomUUID } from "node:crypto";
import { FileTaskStore, type TaskMeta } from "./task-store.js";
import { AsyncLatch } from "./latch.js";
import {
  makeEvent,
  channelOf,
  stagePayload,
  textPayload,
  confirmGatePayload,
  errorPayload,
  type StreamEvent,
  type StreamEventType,
  type EventTypePayloadMap,
} from "../core/stream-events.js";

/**
 * 用户在 HITL 确认门做的决策（POST /confirm 请求体）。
 * - decision: approve（采纳，继续）/ reject（拒绝，中止）/ modify（改参后继续）
 * - params: modify 时携带的修改后参数
 */
export interface ConfirmationDecision {
  decision: "approve" | "reject" | "modify";
  params?: Record<string, unknown>;
  /** 自由文本说明（可选）。 */
  note?: string;
}

/**
 * 确认门结果（释放给 executor 的值）。
 * executor 据 approved 决定继续或中止。
 */
export interface ConfirmationResult {
  gateId: string;
  approved: boolean;
  params?: Record<string, unknown>;
  note?: string;
}

/**
 * 任务注册表：进程内单例，统筹 TaskStore + AsyncLatch + 任务执行。
 *
 * 职责：
 *   - 创建任务并启动执行（runner）
 *   - 维护 taskId → AsyncLatch<ConfirmationResult> 映射（HITL 暂停点）
 *   - awaitConfirmation(taskId, gateId)：executor 在确认节点调用，挂起等待
 *   - confirm(taskId, decision)：外部 POST /confirm 调用，释放闩锁
 *   - runner 负责把事件 append 到 store（含落库）
 *
 * MVP runner 是 stub：模拟一次"检索→暂停确认→完成"流程，验证 HITL 链路。
 * P3 接入真实 executor 后替换。
 */
export class TaskRegistry {
  private readonly store: FileTaskStore;
  /** taskId → 当前活跃的确认闩锁 + 其 gateId（一次只允许一个暂停点）。 */
  private readonly latches = new Map<string, { latch: AsyncLatch<ConfirmationResult>; gateId: string }>();
  /** taskId → 运行中的 runner Promise（防止重复启动）。 */
  private readonly runners = new Map<string, Promise<void>>();

  constructor(store?: FileTaskStore) {
    this.store = store ?? new FileTaskStore();
  }

  getStore(): FileTaskStore {
    return this.store;
  }

  /** 创建并启动一个任务，返回 meta。 */
  start(intent: string, config: Record<string, unknown> = {}): TaskMeta {
    const meta = this.store.create(intent, config);
    const runner = this.runStub(meta.id, intent).catch((err) => {
      this.emitError(meta.id, err instanceof Error ? err.message : String(err));
    });
    this.runners.set(meta.id, runner);
    return meta;
  }

  /**
   * executor 在确认节点调用：发出 confirm_gate 事件，挂起等待用户决策。
   * 返回的 Promise 在 confirm() 调用后 resolve。
   * 一次只允许一个活跃闩锁；重复调用抛错。
   */
  async awaitConfirmation(
    taskId: string,
    gate: {
      nodeId: string;
      runId: string;
      prompt: string;
      options?: string[];
      detail?: Record<string, unknown>;
    },
  ): Promise<ConfirmationResult> {
    const gateId = `g_${randomUUID().slice(0, 8)}`;
    const latch = new AsyncLatch<ConfirmationResult>();
    if (this.latches.has(taskId)) {
      throw new Error(`task ${taskId} already has a pending confirmation`);
    }
    this.latches.set(taskId, { latch, gateId });
    this.store.setStatus(taskId, "pending_confirmation");
    this.emit(taskId, "extension", confirmGatePayload({
      gate_id: gateId,
      node_id: gate.nodeId,
      run_id: gate.runId,
      prompt: gate.prompt,
      options: gate.options ?? ["approve", "reject"],
      detail: gate.detail,
    }));
    try {
      return await latch.wait();
    } finally {
      this.latches.delete(taskId);
    }
  }

  /**
   * 外部确认入口：释放当前闩锁。无活跃闩锁则抛错。
   * 拒绝时把任务标记为 aborted。
   */
  async confirm(taskId: string, decision: ConfirmationDecision): Promise<void> {
    const entry = this.latches.get(taskId);
    if (!entry || !entry.latch.isPending) {
      throw new Error(`task ${taskId} has no pending confirmation`);
    }
    const result: ConfirmationResult = {
      gateId: entry.gateId,
      approved: decision.decision === "approve" || decision.decision === "modify",
      params: decision.params,
      note: decision.note,
    };
    if (!result.approved) {
      this.store.setStatus(taskId, "aborted");
    }
    entry.latch.release(result);
  }

  /** 等待任务 runner 结束（测试用）。 */
  async join(taskId: string): Promise<void> {
    const runner = this.runners.get(taskId);
    if (runner) await runner;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 事件发射 helper：append 到 store（落库）。
  // coalescer 在 SSE 出口层（api/tasks.ts）处理，registry 只负责落库。
  // ─────────────────────────────────────────────────────────────────────────
  private emit<T extends StreamEventType>(
    taskId: string,
    type: T,
    payload: EventTypePayloadMap[T],
  ): StreamEvent {
    const ev = makeEvent(taskId, type, payload, channelOf(type));
    return this.store.append(taskId, ev);
  }

  private emitError(taskId: string, message: string): void {
    const meta = this.store.get(taskId);
    if (!meta) return;
    if (meta.status !== "done" && meta.status !== "aborted") {
      this.emit(taskId, "error", errorPayload(message));
      this.store.setStatus(taskId, "error", message);
    }
  }

  /**
   * Stub runner：模拟一轮完整流程。
   *   stage(active) → text 流 → 暂停确认 → [confirm 后] stage(done) → done
   * 用于 P1 验收：SSE 推送、断线重连、HITL 暂停/恢复全链路。
   * P3 替换为真实 executor。
   */
  private async runStub(taskId: string, intent: string): Promise<void> {
    this.store.setStatus(taskId, "running");
    this.emit(taskId, "stage", stagePayload("理解意图", "active"));
    // 模拟一点 LLM 思考输出
    for (const delta of ["正在分析：", intent, " …"]) {
      this.emit(taskId, "text", textPayload(delta));
      await delay(5);
    }
    this.emit(taskId, "stage", stagePayload("理解意图", "done"));

    // HITL 暂停点：等用户确认
    const result = await this.awaitConfirmation(taskId, {
      nodeId: "review_intent",
      runId: taskId,
      prompt: "请确认是否按此意图生成？",
      options: ["approve", "reject"],
    });
    if (!result.approved) {
      // 用户拒绝：不再产出 done
      return;
    }

    this.store.setStatus(taskId, "running");
    this.emit(taskId, "stage", stagePayload("生成结果", "active"));
    await delay(5);
    this.emit(taskId, "stage", stagePayload("生成结果", "done"));
    this.emit(taskId, "done", {});
    this.store.setStatus(taskId, "done");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
