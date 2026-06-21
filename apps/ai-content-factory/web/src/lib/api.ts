// 统一 API 客户端。后端响应统一结构 { status, data, message }。
// 见 §API & Data Exchange 约定。

export interface ApiResult<T = unknown> {
  status: "success" | "error";
  data: T;
  message?: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  let body: ApiResult<T>;
  try {
    body = (await res.json()) as ApiResult<T>;
  } catch {
    throw new Error(`HTTP ${res.status}: 响应非 JSON`);
  }
  if (!res.ok || body.status === "error") {
    throw new Error(body.message ?? `HTTP ${res.status}`);
  }
  return body.data;
}

export const api = {
  get: <T>(url: string) => request<T>(url),
  post: <T>(url: string, data?: unknown) =>
    request<T>(url, { method: "POST", body: JSON.stringify(data ?? {}) }),
  put: <T>(url: string, data?: unknown) =>
    request<T>(url, { method: "PUT", body: JSON.stringify(data ?? {}) }),
  del: <T>(url: string) => request<T>(url, { method: "DELETE" }),
};

// ─────────────────────────────────────────────────────────────────────────────
// 类型化的后端端点客户端
// ─────────────────────────────────────────────────────────────────────────────

export interface TaskCreated {
  taskId: string;
  status: string;
  createdAt: string;
}

export interface TaskMeta {
  id: string;
  intent: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  lastSeq?: number;
  config?: Record<string, unknown>;
}

export interface ConfirmDecision {
  decision: "approve" | "reject" | "modify";
  params?: Record<string, unknown>;
  note?: string;
}

/** 创建并启动 podcast 任务 */
export function createWorkflow(intent: string, config?: object): Promise<TaskCreated> {
  return api.post<TaskCreated>("/api/workflows", { intent, config });
}

/** 查询单个任务 meta */
export function getTask(taskId: string): Promise<TaskMeta> {
  return api.get<TaskMeta>(`/api/tasks/${taskId}`);
}

/** 查询任务列表（按 createdAt 降序） */
export function listTasks(): Promise<TaskSummary[]> {
  return api.get<TaskSummary[]>("/api/tasks");
}

/** 任务列表摘要（GET /api/tasks 返回的轻量形态） */
export interface TaskSummary {
  id: string;
  intent: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}

/** HITL 确认门 */
export function confirmTask(taskId: string, decision: ConfirmDecision): Promise<{ confirmed: boolean }> {
  return api.post(`/api/tasks/${taskId}/confirm`, decision);
}

/** Guardrail 澄清 */
export function clarifyTask(taskId: string, message: string): Promise<{ clarified: boolean }> {
  return api.post(`/api/tasks/${taskId}/clarify`, { message });
}
