import { randomUUID } from "node:crypto";
import { FileTaskStore, type TaskMeta } from "./task-store.js";
import { AsyncLatch } from "./latch.js";
import {
  makeEvent,
  channelOf,
  phasePayload,
  textPayload,
  confirmGatePayload,
  errorPayload,
  type StreamEvent,
  type StreamEventType,
  type EventTypePayloadMap,
} from "../core/stream-events.js";
import type { LlmService } from "../services/llm-service.js";
import type { ToolRegistry } from "../tools/registry.js";
import { plan, type PlannerConfig } from "../planner/planner.js";
import type { ConsumerTemplate } from "../planner/consumer-template.js";
import { executeDag } from "../executor/executor.js";

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

/** 用户在澄清门补充的信息（POST /clarify 请求体）。 */
export interface ClarificationSubmission {
  /** 用户补充的自由文本（合并进意图重跑 planner）。 */
  message: string;
}

/**
 * 运行时依赖：注入后任务走真实 planner + executor；缺省走 P1 stub runner。
 */
export interface TaskRuntime {
  llm: LlmService;
  toolRegistry: ToolRegistry;
  plannerRole?: "planner" | "default";
  /** 消费应用注入的兜底模板（如 podcast）；内核不内置任何业务模板。 */
  consumerTemplates?: ConsumerTemplate[];
  /**
   * 自定义 runner（应用可注入，绕过 planner+DAG 走自己的执行范式）。
   * 例：NexusOps 注入 ReAct Harness runner（runReactHarness）。
   * 注入后 start() 会优先调用它而非 runPlanned。
   *
   * @param taskId       新任务 id
   * @param intent       用户意图
   * @param hooks        事件/HITL 接口
   * @param context      多轮会话上下文（parentTaskId 存在时为追问轮）
   */
  customRunner?: (
    taskId: string,
    intent: string,
    hooks: TaskRunnerHooks,
    context?: { parentTaskId?: string; conversationId?: string },
  ) => Promise<void>;
}

/** 传给 customRunner 的 hooks（与内核 runner 对齐的事件/HITL 接口）。 */
export interface TaskRunnerHooks {
  /** 发射事件（落库 + SSE 出口）。 */
  emit: <T extends StreamEventType>(
    type: T,
    payload: EventTypePayloadMap[T],
  ) => StreamEvent;
  /** 置任务状态。 */
  setStatus: (status: TaskMeta["status"], message?: string) => void;
  /** HITL 确认门（挂起等待 POST /confirm）。 */
  awaitConfirmation: (gate: {
    nodeId: string;
    runId: string;
    prompt: string;
    options?: string[];
    detail?: Record<string, unknown>;
  }) => Promise<ConfirmationResult>;
}

/**
 * 任务注册表：进程内单例，统筹 TaskStore + AsyncLatch + 任务执行。
 *
 * 职责：
 *   - 创建任务并启动执行（runner）
 *   - 维护 taskId → AsyncLatch<ConfirmationResult> 映射（HITL 暂停点）
 *   - awaitConfirmation(taskId, gateId)：executor 在确认节点调用，挂起等待
 *   - confirm(taskId, decision)：外部 POST /confirm 调用，释放闩锁
 *   - submitClarification(taskId, msg)：外部 POST /clarify 调用，补充意图重跑
 *   - runner 负责把事件 append 到 store（含落库）
 *
 * 注入 runtime（llm + toolRegistry）后走真实 planner + executor；
 * 缺省走 stub runner（保留供 P1 兼容测试）。
 */
export class TaskRegistry {
  private readonly store: FileTaskStore;
  private readonly runtime?: TaskRuntime;
  /** taskId → 当前活跃的确认闩锁 + 其 gateId（一次只允许一个暂停点）。 */
  private readonly latches = new Map<string, { latch: AsyncLatch<ConfirmationResult>; gateId: string }>();
  /** taskId → 运行中的 runner Promise（防止重复启动）。 */
  private readonly runners = new Map<string, Promise<void>>();
  /** taskId → 当前活跃的澄清闩锁（guardrail clarify 暂停点）。 */
  private readonly clarifyLatches = new Map<string, AsyncLatch<string>>();

  constructor(store?: FileTaskStore, runtime?: TaskRuntime) {
    this.store = store ?? new FileTaskStore();
    this.runtime = runtime;
  }

  getStore(): FileTaskStore {
    return this.store;
  }

  /** 暴露工具注册表（供 /api/tools 端点查询工具清单）。 */
  getToolRegistry(): ToolRegistry | undefined {
    return this.runtime?.toolRegistry;
  }

  /**
   * 创建并启动一个任务，返回 meta。
   *
   * @param intent   用户意图
   * @param config   触发请求体（配置、模板等）
   * @param options  多轮会话参数：
   *   - conversationId：追问时传入；缺省时 store 生成新会话
   *   - parentTaskId：追问时显式指定上一轮 task id
   */
  start(
    intent: string,
    config: Record<string, unknown> = {},
    options: { conversationId?: string; parentTaskId?: string } = {},
  ): TaskMeta {
    const meta = this.store.create(intent, config, options);
    const runner = this.pickRunner(meta.id, intent, {
      parentTaskId: meta.parentTaskId,
      conversationId: meta.conversationId,
    }).catch((err) => {
      this.emitError(meta.id, err instanceof Error ? err.message : String(err));
    });
    this.runners.set(meta.id, runner);
    return meta;
  }

  /** 选择 runner：注入 customRunner 优先；否则 runtime → runPlanned；缺省 stub。 */
  private pickRunner(
    taskId: string,
    intent: string,
    context?: { parentTaskId?: string; conversationId?: string },
  ): Promise<void> {
    const rt = this.runtime;
    if (rt?.customRunner) {
      const hooks: TaskRunnerHooks = {
        emit: (type, payload) => this.emit(taskId, type, payload),
        setStatus: (status, message) => this.store.setStatus(taskId, status, message),
        awaitConfirmation: (gate) =>
          this.awaitConfirmation(taskId, {
            nodeId: gate.nodeId,
            runId: gate.runId,
            prompt: gate.prompt,
            options: gate.options,
            detail: gate.detail,
          }),
      };
      return rt.customRunner(taskId, intent, hooks, context);
    }
    if (rt) return this.runPlanned(taskId, intent);
    return this.runStub(taskId, intent);
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

  /**
   * 外部澄清入口：guardrail 触发 pending_clarification 后，用户补充信息。
   * 把 message 释放给挂起的 planner，合并进意图重跑。
   * 无活跃澄清闩锁则抛错。
   */
  async submitClarification(taskId: string, submission: ClarificationSubmission): Promise<void> {
    const latch = this.clarifyLatches.get(taskId);
    if (!latch || !latch.isPending) {
      throw new Error(`task ${taskId} has no pending clarification`);
    }
    latch.release(submission.message);
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

  // ─────────────────────────────────────────────────────────────────────────
  // 真实 runner：planner（guardrail + LLM 填参）→ executor。
  // ─────────────────────────────────────────────────────────────────────────
  /**
   * 规划执行 runner：意图 → guardrail → LLM 填参 → DAG → executor → done。
   * guardrail clarify 时挂起等 POST /clarify；reject 时置 failed。
   */
  private async runPlanned(taskId: string, intent: string): Promise<void> {
    const rt = this.runtime;
    if (!rt) throw new Error("runtime not configured");
    const plannerCfg: PlannerConfig = {
      llm: rt.llm,
      registry: rt.toolRegistry,
      role: rt.plannerRole ?? "planner",
      consumerTemplates: rt.consumerTemplates,
    };

    let currentIntent = intent;

    // planner 带澄清循环（用户多次补充直到 proceed/reject）
    while (true) {
      this.store.setStatus(taskId, "running");
      const outcome = await plan(currentIntent, plannerCfg);

      if (outcome.kind === "reject") {
        // 越界：置 failed，发 extension(rejected)
        this.emit(taskId, "extension", {
          name: "rejected",
          version: "1.0",
          data: { reason: outcome.reason, suggest_retry: outcome.suggestRetry },
        });
        this.store.setStatus(taskId, "failed", outcome.reason);
        return;
      }

      if (outcome.kind === "clarify") {
        // 模糊：挂起等 POST /clarify，合并意图后重跑
        const latch = new AsyncLatch<string>();
        this.clarifyLatches.set(taskId, latch);
        this.store.setStatus(taskId, "pending_clarification");
        this.emit(taskId, "extension", {
          name: "clarification_required",
          version: "1.0",
          data: { questions: outcome.questions },
        });
        try {
          const supplement = await latch.wait();
          currentIntent = mergeIntent(currentIntent, supplement);
        } finally {
          this.clarifyLatches.delete(taskId);
        }
        // 重跑 planner（continue 循环）
        continue;
      }

      // proceed：执行 DAG
      const { dag } = outcome;
      this.emit(taskId, "phase", phasePayload("execute", "执行工作流", "running"));
      const result = await executeDag(dag, {
        taskId,
        runId: taskId,
        intent: currentIntent,
        registry: rt.toolRegistry,
        hooks: {
          emit: async (ev) => this.store.append(taskId, makeEvent(taskId, ev.type, ev.payload, ev.channel)),
          requireConfirmation: (gate) =>
            this.awaitConfirmation(taskId, {
              nodeId: gate.detail?.node_id as string ?? "",
              runId: taskId,
              prompt: gate.prompt,
              options: gate.options,
              detail: gate.detail,
            }),
        },
      });
      this.emit(taskId, "phase", phasePayload("execute", "执行工作流", "done"));

      if (!result.ok) {
        // abort/skip：executor 已发 error 事件，这里只置终态
        this.store.setStatus(taskId, "error", result.error ?? "执行失败");
        return;
      }
      this.emit(taskId, "done", {});
      this.store.setStatus(taskId, "done");
      return;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Stub runner：模拟一轮完整流程。
  //   stage(active) → text 流 → 暂停确认 → [confirm 后] stage(done) → done
  // 用于 P1 验收：SSE 推送、断线重连、HITL 暂停/恢复全链路。
  // P3 替换为真实 executor。
  private async runStub(taskId: string, intent: string): Promise<void> {
    this.store.setStatus(taskId, "running");
    this.emit(taskId, "phase", phasePayload("understand", "理解意图", "running"));
    // 模拟一点 LLM 思考输出
    for (const delta of ["正在分析：", intent, " …"]) {
      this.emit(taskId, "text", textPayload(delta));
      await delay(5);
    }
    this.emit(taskId, "phase", phasePayload("understand", "理解意图", "done"));

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
    this.emit(taskId, "phase", phasePayload("generate", "生成结果", "running"));
    await delay(5);
    this.emit(taskId, "phase", phasePayload("generate", "生成结果", "done"));
    this.emit(taskId, "done", {});
    this.store.setStatus(taskId, "done");
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 合并原始意图与用户补充信息（后置合并，见 06 §6.7）。 */
function mergeIntent(original: string, supplement: string): string {
  return `${original}\n（补充：${supplement}）`;
}
