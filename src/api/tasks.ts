import { Hono } from "hono";
import { z } from "zod";
import { streamSSE } from "hono/streaming";
import type { TaskRegistry } from "../tasks/registry.js";
import type { ConfirmationDecision } from "../tasks/registry.js";
import { serializeSSEData } from "../core/stream-events.js";
import { StreamCoalescer } from "../tasks/coalescer.js";

/**
 * 任务相关路由：
 *   GET  /api/tasks/:id          —— 查询任务 meta + 状态
 *   GET  /api/tasks/:id/stream   —— SSE 订阅事件流（支持 ?since=N 断线重连）
 *   POST /api/tasks/:id/confirm  —— HITL 确认（释放闩锁）
 *   POST /api/tasks/:id/clarify  —— Guardrail 澄清（补充意图，重跑 planner）
 *
 * SSE 协议信封由 @meso.ai/types 定义；serializeSSEData 把内部事件剥成信封。
 * 断线重连：客户端记录收到的最大 seq，重连时带 ?since=seq，服务端只推 seq 之后的事件，
 * 并继续推后续新增事件（长连接）。
 */
export function createTasksApp(registry: TaskRegistry): Hono {
  const app = new Hono();

  // GET /api/tasks/:id —— meta
  app.get("/:id", (c) => {
    const meta = registry.getStore().get(c.req.param("id"));
    if (!meta) {
      return c.json({ status: "error", message: "task not found" }, 404);
    }
    return c.json({ status: "success", data: meta });
  });

  // GET /api/tasks/:id/stream —— SSE
  app.get("/:id/stream", async (c) => {
    const taskId = c.req.param("id");
    const meta = registry.getStore().get(taskId);
    if (!meta) {
      return c.json({ status: "error", message: "task not found" }, 404);
    }
    const since = Number(c.req.query("since") ?? "0");

    return streamSSE(c, async (stream) => {
      // 1) 先回放 since 之后的历史事件（断线重连）
      const buffered = registry.getStore().readSince(taskId, since);
      // 2) 用 coalescer 控制推送节奏（content 合并、status/meta 立即）
      const coalescer = new StreamCoalescer({
        emit: (event) => {
          // 写 SSE data 行：data: {信封}\n\n 由 stream.sendSSE 处理 id/event/data
          // 这里用 data 字段携带序列化信封
          void stream.writeSSE({ data: serializeSSEData(event) });
        },
      });
      for (const ev of buffered) {
        coalescer.push(ev);
      }
      coalescer.flush();

      // 3) 若任务已终结，结束流
      if (isTerminal(meta.status)) {
        await stream.writeSSE({ data: "[DONE]" });
        return;
      }

      // 4) 轮询新增事件并推送（MVP 简单实现；P2+ 可换为 pub/sub）。
      //    lastSent 从回放后的最大 seq 起算。
      let lastSent = buffered.length > 0 ? buffered[buffered.length - 1]!.seq : since;

      // 超时保护：长连接最多挂 5 分钟，让客户端重连（避免僵尸连接）。
      const deadline = Date.now() + 5 * 60 * 1000;
      while (Date.now() < deadline) {
        const cur = registry.getStore().get(taskId);
        if (!cur) break;
        const fresh = registry.getStore().readSince(taskId, lastSent);
        for (const ev of fresh) {
          coalescer.push(ev);
          lastSent = ev.seq;
        }
        coalescer.flush();
        if (isTerminal(cur.status)) {
          await stream.writeSSE({ data: "[DONE]" });
          return;
        }
        // 等待新事件（简单轮询；间隔 50ms 与 coalescer maxDelay 对齐）
        await sleep(50);
      }
      // 到达 deadline：发注释行保持连接，客户端可重连继续
      await stream.writeSSE({ data: "[DONE]" });
    });
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

function isTerminal(status: string): boolean {
  return status === "done" || status === "error" || status === "aborted" || status === "failed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
