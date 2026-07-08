import { Hono, type Context } from "hono";
import { z } from "zod";
import { streamSSE } from "hono/streaming";
import type { TaskRegistry } from "../tasks/registry.js";
import type { ConfirmationDecision } from "../tasks/registry.js";
import { serializeSSEData, type StreamEvent } from "../core/stream-events.js";
import { StreamCoalescer } from "../tasks/coalescer.js";
import { loadSystemSettings, type SystemSettings } from "../core/system-settings.js";
import { isTerminalStatus } from "../tasks/task-store.js";
import { globalBroadcaster } from "../core/event-broadcaster.js";

/**
 * 任务相关路由：
 *   GET  /api/tasks              —— 任务列表（按 createdAt 降序）
 *   GET  /api/tasks/:id          —— 查询任务 meta + 状态
 *   GET  /api/tasks/:id/stream   —— SSE 订阅事件流（支持 ?since=N 断线重连）
 *   POST /api/tasks/:id/confirm  —— HITL 确认（释放闩锁）
 *   POST /api/tasks/:id/clarify  —— Guardrail 澄清（补充意图，重跑 planner）
 *
 * SSE 协议信封由 @meso.ai/types 定义；serializeSSEData 把内部事件剥成信封。
 * 断线重连：客户端记录收到的最大 seq，重连时带 ?since=seq，服务端只推 seq 之后的事件，
 * 并继续推后续新增事件（长连接）。
 *
 * SSE 推送模式（sys.ssePushMode）：
 *   - "push"（默认）：内存广播（EventBroadcaster），生产者 push 后订阅者立即收到，
 *     端到端延迟个位数 ms。落盘仍同步（断线重连契约）。
 *   - "poll"（兼容旧行为）：轮询磁盘 events.jsonl，延迟受 ssePollIntervalMs 影响。
 *     出问题时可通过 system_settings.json 切回 poll 回滚。
 */
export function createTasksApp(registry: TaskRegistry): Hono {
  const app = new Hono();

  // GET /api/tasks —— 任务列表（按 createdAt 降序，轻量摘要）
  app.get("/", (c) => {
    const tasks = registry.getStore().listAll();
    return c.json({ status: "success", data: tasks });
  });

  // GET /api/tasks/:id —— meta
  app.get("/:id", (c) => {
    const meta = registry.getStore().get(c.req.param("id"));
    if (!meta) {
      return c.json({ status: "error", message: "task not found" }, 404);
    }
    return c.json({ status: "success", data: meta });
  });

  // GET /api/tasks/:id/stream —— SSE（按 ssePushMode 分流）
  app.get("/:id/stream", async (c) => {
    const taskId = c.req.param("id");
    const meta = registry.getStore().get(taskId);
    if (!meta) {
      return c.json({ status: "error", message: "task not found" }, 404);
    }
    const since = Number(c.req.query("since") ?? "0");
    const sys = loadSystemSettings();

    if (sys.ssePushMode === "poll") {
      return streamPollMode(c, registry, taskId, since, sys);
    }
    return streamPushMode(c, registry, taskId, since, sys);
  });

  // POST /api/tasks/:id/confirm —— HITL 确认
  const confirmSchema = z.object({
    decision: z.enum(["approve", "reject", "modify"]),
    params: z.record(z.string(), z.unknown()).optional(),
    note: z.string().optional(),
  });

  app.post("/:id/confirm", async (c) => {
    const taskId = c.req.param("id");
    const meta = registry.getStore().get(taskId);
    if (!meta) {
      return c.json({ status: "error", message: "task not found" }, 404);
    }
    if (meta.status !== "pending_confirmation") {
      return c.json(
        { status: "error", message: `task not awaiting confirmation (status=${meta.status})` },
        409,
      );
    }
    const parsed = confirmSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json(
        { status: "error", message: "invalid body", data: parsed.error.flatten() },
        400,
      );
    }
    try {
      await registry.confirm(taskId, parsed.data as ConfirmationDecision);
    } catch (err) {
      return c.json(
        { status: "error", message: err instanceof Error ? err.message : String(err) },
        409,
      );
    }
    return c.json({ status: "success", data: { confirmed: true } });
  });

  // POST /api/tasks/:id/clarify —— Guardrail 澄清
  app.post("/:id/clarify", async (c) => {
    const taskId = c.req.param("id");
    const meta = registry.getStore().get(taskId);
    if (!meta) {
      return c.json({ status: "error", message: "task not found" }, 404);
    }
    if (meta.status !== "pending_clarification") {
      return c.json(
        { status: "error", message: `task not awaiting clarification (status=${meta.status})` },
        409,
      );
    }
    const body = (await c.req.json().catch(() => ({}))) as { message?: string };
    if (!body.message || typeof body.message !== "string") {
      return c.json({ status: "error", message: "field 'message' (string) is required" }, 400);
    }
    try {
      await registry.submitClarification(taskId, { message: body.message });
    } catch (err) {
      return c.json(
        { status: "error", message: err instanceof Error ? err.message : String(err) },
        409,
      );
    }
    return c.json({ status: "success", data: { clarified: true } });
  });

  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// push 模式：内存广播订阅（默认，实时）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * push 模式 SSE：先回放历史 → 订阅 broadcaster → await 事件队列 → 终态发 [DONE]。
 *
 * 关键设计：
 *   - broadcaster.subscribe 回调只往队列塞 + 唤醒，不直接 await writeSSE
 *     （避免慢消费阻塞 broadcaster.push 进而拖慢生产者主循环）
 *   - 终态用 onTerminal 订阅，避免把 [DONE] 当 StreamEvent 落盘
 *   - coalescer 可选（sys.coalescerEnabled）：默认关，content 立即 flush
 *   - 超时保护（sseDeadlineMs）：防止僵尸连接
 */
function streamPushMode(
  c: Context,
  registry: TaskRegistry,
  taskId: string,
  since: number,
  sys: SystemSettings,
) {
  return streamSSE(c, async (stream) => {
    // 1) 回放 since 之后的历史事件（断线重连补偿）
    const buffered = registry.getStore().readSince(taskId, since);
    const coalescer = sys.coalescerEnabled
      ? new StreamCoalescer({
          maxBuffer: sys.coalescerMaxBuffer,
          maxDelayMs: sys.coalescerMaxDelayMs,
          emit: async (event: StreamEvent) => {
            await stream.writeSSE({ data: serializeSSEData(event) });
          },
        })
      : null;

    const writeEv = async (ev: StreamEvent): Promise<void> => {
      if (coalescer) await coalescer.push(ev);
      else await stream.writeSSE({ data: serializeSSEData(ev) });
    };
    const flushEv = async (): Promise<void> => {
      if (coalescer) await coalescer.flush();
    };

    for (const ev of buffered) {
      await writeEv(ev);
    }
    await flushEv();

    // 2) 若任务已终结，结束流
    const curMeta = registry.getStore().get(taskId);
    if (curMeta && isTerminalStatus(curMeta.status)) {
      await stream.writeSSE({ data: "[DONE]" });
      return;
    }

    // 3) 订阅 broadcaster：push 模式核心
    const queue: StreamEvent[] = [];
    let terminal = false;
    let resolveWait: (() => void) | null = null;
    const wake = (): void => {
      resolveWait?.();
      resolveWait = null;
    };

    const unsubEvents = globalBroadcaster.subscribe(taskId, (event) => {
      queue.push(event);
      wake();
    });
    const unsubTerminal = globalBroadcaster.onTerminal(taskId, () => {
      terminal = true;
      wake();
    });

    try {
      // 4) 消费循环
      while (!terminal) {
        if (queue.length === 0) {
          // 等新事件或终态（带超时保护，避免永久挂起）
          await Promise.race([
            new Promise<void>((r) => {
              resolveWait = r;
            }),
            sleep(sys.sseDeadlineMs),
          ]);
          resolveWait = null;
        }
        // flush 当前队列（保留顺序）
        while (queue.length > 0) {
          const ev = queue.shift()!;
          await writeEv(ev);
        }
        await flushEv();
      }
      // 5) 终态：flush 剩余 + [DONE]
      while (queue.length > 0) {
        const ev = queue.shift()!;
        await writeEv(ev);
      }
      await flushEv();
      await stream.writeSSE({ data: "[DONE]" });
    } finally {
      unsubEvents();
      unsubTerminal();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// poll 模式：轮询磁盘（兼容旧行为，ssePushMode=poll 时走这里）
// ─────────────────────────────────────────────────────────────────────────────

function streamPollMode(
  c: Context,
  registry: TaskRegistry,
  taskId: string,
  since: number,
  sys: SystemSettings,
) {
  return streamSSE(c, async (stream) => {
    // 1) 先回放 since 之后的历史事件（断线重连）
    const buffered = registry.getStore().readSince(taskId, since);
    // 2) 用 coalescer 控制推送节奏（content 合并、status/meta 立即）
    const coalescer = new StreamCoalescer({
      maxBuffer: sys.coalescerMaxBuffer,
      maxDelayMs: sys.coalescerMaxDelayMs,
      emit: async (event) => {
        await stream.writeSSE({ data: serializeSSEData(event) });
      },
    });
    for (const ev of buffered) {
      await coalescer.push(ev);
    }
    await coalescer.flush();

    // 3) 若任务已终结，结束流（coalescer 已 flush 完毕，error 事件先于 [DONE]）
    const meta = registry.getStore().get(taskId);
    if (meta && isTerminalStatus(meta.status)) {
      await stream.writeSSE({ data: "[DONE]" });
      return;
    }

    // 4) 轮询新增事件并推送
    let lastSent = buffered.length > 0 ? buffered[buffered.length - 1]!.seq : since;

    // 超时保护：长连接最多挂 sys.sseDeadlineMs，让客户端重连（避免僵尸连接）。
    const deadline = Date.now() + sys.sseDeadlineMs;
    while (Date.now() < deadline) {
      const cur = registry.getStore().get(taskId);
      if (!cur) break;
      const fresh = registry.getStore().readSince(taskId, lastSent);
      for (const ev of fresh) {
        await coalescer.push(ev);
        lastSent = ev.seq;
      }
      await coalescer.flush();
      if (isTerminalStatus(cur.status)) {
        await stream.writeSSE({ data: "[DONE]" });
        return;
      }
      // 等待新事件（简单轮询；间隔与 coalescer maxDelay 对齐）
      await sleep(sys.ssePollIntervalMs);
    }
    // 到达 deadline：发注释行保持连接，客户端可重连继续
    await stream.writeSSE({ data: "[DONE]" });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
