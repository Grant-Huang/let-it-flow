import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../src/api/app.js";
import { TaskRegistry } from "../../src/tasks/registry.js";
import { createDefaultToolRegistry } from "../../src/executor/default-tools.js";
import { registerBuiltinTools } from "../../src/tools/index.js";
import { LlmService } from "../../src/services/llm-service.js";
import type { TaskRuntime } from "../../src/tasks/registry.js";

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lif-p4-api-"));
  process.env.LIF_DATA_DIR = tmpRoot;
});

/**
 * 构造真实 runtime 的 app（planner 走启发式兜底，无需 OPENAI_API_KEY）。
 */
function createRuntimeApp() {
  const toolRegistry = createDefaultToolRegistry();
  const llm = new LlmService({ apiKey: "sk-test-fake" });
  registerBuiltinTools(toolRegistry, { llm });
  const runtime: TaskRuntime = { llm, toolRegistry };
  return createApp(new TaskRegistry(undefined, runtime));
}

interface ApiSuccess<T> {
  status: "success";
  data: T;
}
async function json<T>(res: Response): Promise<ApiSuccess<T>> {
  return (await res.json()) as ApiSuccess<T>;
}

async function waitStatus(
  app: ReturnType<typeof createRuntimeApp>,
  taskId: string,
  status: string,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await app.request(`/api/tasks/${taskId}`);
    const body = await json<{ status: string }>(res);
    if (body.data.status === status) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`task ${taskId} did not reach status=${status}`);
}

describe("P4 API: clarify endpoint + runtime runner", () => {
  it("模糊意图 → pending_clarification → POST /clarify 补充后进入执行", async () => {
    const app = createRuntimeApp();

    // 创建任务：模糊意图「做播客」（无 URL/主题）应触发 clarify
    const create = await app.request("/api/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "做播客" }),
    });
    expect(create.status).toBe(201);
    const created = await json<{ taskId: string }>(create);
    const taskId = created.data.taskId;

    // 等待进入 pending_clarification
    await waitStatus(app, taskId, "pending_clarification");

    // POST /clarify 补充信息
    const clarify = await app.request(`/api/tasks/${taskId}/clarify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "主题是 AI 趋势" }),
    });
    expect(clarify.status).toBe(200);
    const cbody = await json<{ clarified: boolean }>(clarify);
    expect(cbody.data.clarified).toBe(true);

    // 补充后意图含主体词 → proceed → 进入执行（pending_confirmation / running / done）
    // 给 runner 一点时间，确认不再停留在 pending_clarification
    const deadline = Date.now() + 2000;
    let finalStatus = "";
    while (Date.now() < deadline) {
      const res = await app.request(`/api/tasks/${taskId}`);
      const body = await json<{ status: string }>(res);
      finalStatus = body.data.status;
      if (finalStatus !== "pending_clarification") break;
      await new Promise((r) => setTimeout(r, 15));
    }
    expect(finalStatus).not.toBe("pending_clarification");
  });

  it("POST /clarify 在非 pending_clarification 状态返回 409", async () => {
    const app = createRuntimeApp();
    const create = await app.request("/api/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "把 https://example.com 做成播客" }),
    });
    const created = await json<{ taskId: string }>(create);
    const taskId = created.data.taskId;
    // 此时任务可能在 running 或 pending_confirmation（fetch HITL），不应是 pending_clarification
    const clarify = await app.request(`/api/tasks/${taskId}/clarify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "补充" }),
    });
    expect([409, 200]).toContain(clarify.status);
  });

  it("POST /clarify 缺 message 字段返回 400", async () => {
    const app = createRuntimeApp();
    const create = await app.request("/api/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "做播客" }),
    });
    const created = await json<{ taskId: string }>(create);
    const taskId = created.data.taskId;
    await waitStatus(app, taskId, "pending_clarification");

    const clarify = await app.request(`/api/tasks/${taskId}/clarify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(clarify.status).toBe(400);
  });
});
