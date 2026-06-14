import { describe, it, expect, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../../src/api/app.js";
import { TaskRegistry } from "../../src/tasks/registry.js";
import { serializeSSEData } from "../../src/core/stream-events.js";
import { parseSSELine } from "@meso.ai/types";

// 用临时目录隔离
let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lif-p1-api-"));
  process.env.LIF_DATA_DIR = tmpRoot;
});

/**
 * 构造使用 stub runner 的 app（无 runtime 注入）。
 * P1 API 测试验证 stub runner 的 HITL/SSE 协议，故显式用 stub registry。
 */
function createStubApp() {
  return createApp(new TaskRegistry());
}

/**
 * 从 Response body 解析 SSE data 行，返回所有 parseSSELine 解析成功的事件。
 * Hono 的 streamSSE 每条写 "data: <payload>\n\n" 或 "data: [DONE]\n\n"。
 */
async function collectSSEEvents(response: Response): Promise<{ type: string }[]> {
  const events: { type: string }[] = [];
  const reader = response.body?.getReader();
  if (!reader) return events;
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      for (const line of block.split("\n")) {
        const m = line.match(/^data:\s?(.*)$/);
        if (!m) continue;
        const parsed = parseSSELine(line);
        if (parsed) events.push(parsed as { type: string });
      }
    }
  }
  return events;
}

interface ApiSuccess<T> {
  status: "success";
  data: T;
}

interface TaskCreatedData {
  taskId: string;
  status: string;
  createdAt: number;
}
interface TaskMetaApiData {
  id: string;
  intent: string;
  status: string;
  [k: string]: unknown;
}

async function json<T>(res: Response): Promise<ApiSuccess<T>> {
  return (await res.json()) as ApiSuccess<T>;
}

describe("API end-to-end (Hono app)", () => {
  it("POST /api/workflows creates a task and returns taskId", async () => {
    const app = createStubApp();
    const res = await app.request("/api/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "做一期关于 AI 的播客", config: { style: "dialogue" } }),
    });
    expect(res.status).toBe(201);
    const body = await json<TaskCreatedData>(res);
    expect(body.status).toBe("success");
    expect(body.data.taskId).toMatch(/^t_/);
    expect(body.data.status).toBe("pending");
  });

  it("POST /api/workflows validates body (400 on empty)", async () => {
    const app = createStubApp();
    const res = await app.request("/api/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("GET /api/tasks/:id returns meta", async () => {
    const app = createStubApp();
    const createRes = await app.request("/api/workflows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent: "x" }),
    });
    const create = await json<TaskCreatedData>(createRes);
    const res = await app.request(`/api/tasks/${create.data.taskId}`);
    expect(res.status).toBe(200);
    const body = await json<TaskMetaApiData>(res);
    expect(body.data.id).toBe(create.data.taskId);
    expect(body.data.intent).toBe("x");
  });

  it("GET /api/tasks/:id 404 for unknown", async () => {
    const app = createStubApp();
    const res = await app.request("/api/tasks/unknown");
    expect(res.status).toBe(404);
  });

  it("full flow: create → SSE streams events → confirm → done", async () => {
    const app = createStubApp();
    // 1) 创建
    const create = await json<TaskCreatedData>(
      await app.request("/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "完整流程测试" }),
      }),
    );
    const taskId = create.data.taskId;

    // 2) 等 stub 进入 pending_confirmation（事件已落库）
    await waitStatus(app, taskId, "pending_confirmation");

    // 3) 先订阅 SSE（捕获 confirm_gate），随后 approve
    const ssePromise = app.request(`/api/tasks/${taskId}/stream`);
    // 给 SSE 一点时间连上并回放历史
    await new Promise((r) => setTimeout(r, 50));
    await app.request(`/api/tasks/${taskId}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });

    const res = await ssePromise;
    const events = await collectSSEEvents(res);
    const types = events.map((e) => e.type);
    expect(types).toContain("stage");
    expect(types).toContain("text");
    expect(types).toContain("extension"); // confirm_gate
    expect(types).toContain("done");
  });

  it("reject leads to aborted, no done event", async () => {
    const app = createStubApp();
    const create = await json<TaskCreatedData>(
      await app.request("/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "拒绝测试" }),
      }),
    );
    const taskId = create.data.taskId;
    await waitStatus(app, taskId, "pending_confirmation");
    const res = await app.request(`/api/tasks/${taskId}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "reject" }),
    });
    expect(res.status).toBe(200);
    const meta = await json<TaskMetaApiData>(
      await app.request(`/api/tasks/${taskId}`),
    );
    expect(meta.data.status).toBe("aborted");
  });

  it("confirm 409 when not awaiting", async () => {
    const app = createStubApp();
    const create = await json<TaskCreatedData>(
      await app.request("/api/workflows", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "y" }),
      }),
    );
    const taskId = create.data.taskId;
    // 任务刚创建（pending/running），尚未到确认点
    const res = await app.request(`/api/tasks/${taskId}/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(res.status).toBe(409);
  });

  it("serializeSSEData produces @meso.ai/types-parsable lines", () => {
    expect(typeof serializeSSEData).toBe("function");
  });
});

async function waitStatus(app: ReturnType<typeof createApp>, taskId: string, status: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 1500) {
    const meta = await json<TaskMetaApiData>(
      await app.request(`/api/tasks/${taskId}`),
    );
    if (meta.data.status === status) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`task ${taskId} did not reach status=${status}`);
}
