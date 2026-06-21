import { Hono } from "hono";
import type { TaskRegistry } from "../tasks/registry.js";
import { ConversationStore } from "../tasks/conversation-store.js";

/**
 * 会话相关路由（多轮追问）：
 *   GET /api/conversations          —— 会话列表（按最近活跃降序）
 *   GET /api/conversations/:id      —— 会话详情（含完整 task 链）
 *
 * 会话是 task 的逻辑视图：同一 conversationId 的多个 task（首轮 + 追问轮）
 * 聚合为一条会话。首条 task 的 intent 作为会话标题。
 */
export function createConversationsApp(registry: TaskRegistry): Hono {
  const app = new Hono();
  const conversationStore = new ConversationStore(registry.getStore());

  // GET /api/conversations —— 会话列表
  app.get("/", (c) => {
    const conversations = conversationStore.listConversations();
    return c.json({ status: "success", data: conversations });
  });

  // GET /api/conversations/:id —— 会话详情（含 task 链）
  app.get("/:id", (c) => {
    const conversationId = c.req.param("id");
    const detail = conversationStore.getConversation(conversationId);
    if (!detail) {
      return c.json({ status: "error", message: "conversation not found" }, 404);
    }
    return c.json({ status: "success", data: detail });
  });

  return app;
}
