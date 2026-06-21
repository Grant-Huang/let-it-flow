import { Hono } from "hono";
import { z } from "zod";
import type { TaskRegistry } from "../tasks/registry.js";

/**
 * POST /api/workflows —— 创建并启动一个工作流任务。
 *
 * 请求体：
 *   { intent: string, config?: object }
 * 响应：
 *   201 { status: "success", data: { taskId, status, createdAt } }
 *
 * 任务立即开始执行（registry.start 启动 runner），客户端随后用 taskId
 * 订阅 SSE（GET /api/tasks/:id/stream）。
 */
export function createWorkflowsApp(registry: TaskRegistry): Hono {
  const app = new Hono();

  const bodySchema = z.object({
    intent: z.string().min(1),
    config: z.record(z.string(), z.unknown()).optional(),
    /**
     * 多轮追问：会话 id。传入时本次 task 归属该会话；缺省时 store 生成新会话。
     */
    conversationId: z.string().optional(),
    /**
     * 多轮追问：显式指定上一轮 task id（读取其产物构造压缩上下文）。
     * 缺省时由会话链自动取最近一个 done task。
     */
    parentTaskId: z.string().optional(),
  });

  app.post("/", async (c) => {
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json(
        { status: "error", message: "invalid body", data: parsed.error.flatten() },
        400,
      );
    }
    const { intent, config, conversationId, parentTaskId } = parsed.data;
    const meta = registry.start(intent, config ?? {}, { conversationId, parentTaskId });
    return c.json(
      {
        status: "success",
        data: {
          taskId: meta.id,
          status: meta.status,
          createdAt: meta.createdAt,
          conversationId: meta.conversationId,
          parentTaskId: meta.parentTaskId,
        },
      },
      201,
    );
  });

  return app;
}
