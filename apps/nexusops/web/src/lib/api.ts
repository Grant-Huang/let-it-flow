// 统一 API 客户端。后端响应统一结构 { status, data, message }。
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
  /** 多轮追问：本次 task 归属的会话 id。 */
  conversationId?: string;
  /** 多轮追问：上一轮 task id（追问轮）。 */
  parentTaskId?: string;
}

export interface TaskMeta {
  id: string;
  intent: string;
  status: string;
  createdAt: string;
  updatedAt?: string;
  lastSeq?: number;
  config?: Record<string, unknown>;
  conversationId?: string;
  parentTaskId?: string;
}

export interface ConfirmDecision {
  decision: "approve" | "reject" | "modify";
  params?: Record<string, unknown>;
  note?: string;
}

/** 创建并启动 NexusOps 分析任务（支持多轮追问） */
export function createWorkflow(
  intent: string,
  options?: {
    config?: object;
    /** 追问时传入：归属已有会话。 */
    conversationId?: string;
    /** 追问时传入：显式指定上一轮 task。 */
    parentTaskId?: string;
  },
): Promise<TaskCreated> {
  const { config, conversationId, parentTaskId } = options ?? {};
  return api.post<TaskCreated>("/api/workflows", { intent, config, conversationId, parentTaskId });
}

/** 查询单个任务 meta */
export function getTask(taskId: string): Promise<TaskMeta> {
  return api.get<TaskMeta>(`/api/tasks/${taskId}`);
}

/** 查询任务列表（按 createdAt 降序） */
export function listTasks(): Promise<TaskSummary[]> {
  return api.get<TaskSummary[]>("/api/tasks");
}

export interface TaskSummary {
  id: string;
  intent: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  conversationId?: string;
  parentTaskId?: string;
}

/** 会话摘要（GET /api/conversations 返回） */
export interface ConversationSummary {
  conversationId: string;
  title: string;
  taskCount: number;
  createdAt: number;
  lastActiveAt: number;
  lastStatus: string;
}

/** 会话详情（GET /api/conversations/:id 返回，含完整 task 链） */
export interface ConversationDetail extends ConversationSummary {
  /** 会话内全部 task（升序：首轮在前，追问轮在后）。 */
  tasks: TaskSummary[];
}

/** 查询会话列表（按最近活跃降序） */
export function listConversations(): Promise<ConversationSummary[]> {
  return api.get<ConversationSummary[]>("/api/conversations");
}

/** 查询会话详情（含完整 task 链，点击历史会话时用） */
export function getConversation(conversationId: string): Promise<ConversationDetail> {
  return api.get<ConversationDetail>(`/api/conversations/${conversationId}`);
}

/** HITL 确认门 */
export function confirmTask(taskId: string, decision: ConfirmDecision): Promise<{ confirmed: boolean }> {
  return api.post(`/api/tasks/${taskId}/confirm`, decision);
}

/** Guardrail 澄清 */
export function clarifyTask(taskId: string, message: string): Promise<{ clarified: boolean }> {
  return api.post(`/api/tasks/${taskId}/clarify`, { message });
}

// ─────────────────────────────────────────────────────────────────────────────
// 报表固化模板（Phase 2）
// ─────────────────────────────────────────────────────────────────────────────

export interface ReportTemplateRecord {
  reportType: string;
  title: string;
  layout: ComponentLayout;
  status: "draft" | "active";
  source: "manual" | "mined";
  createdAt: string;
  updatedAt: string;
}

/** ComponentLayout（与后端 report-types.ts 对齐，前端独立定义避免引入后端构建）。 */
export interface ComponentLayout {
  reportType: string;
  title: string;
  meta?: { line?: string; scenarioId?: string; generatedAt?: string };
  components: Array<{
    name: string;
    data: Record<string, unknown>;
    wrapper?: { type: "section"; title?: string };
  }>;
}

/** 登记固化报表模板 */
export function saveReportTemplate(input: {
  reportType: string;
  title: string;
  layout: ComponentLayout;
  status?: "draft" | "active";
  source?: "manual" | "mined";
}): Promise<{ template: ReportTemplateRecord }> {
  return api.post("/api/report-templates", input);
}

/** 查询单个 active 模板（报表生成时用） */
export function getReportTemplate(reportType: string): Promise<{ template: ReportTemplateRecord }> {
  return api.get(`/api/report-templates/${reportType}`);
}

/** 列出全部模板（含 draft） */
export function listReportTemplates(): Promise<{ templates: ReportTemplateRecord[]; count: number }> {
  return api.get("/api/report-templates");
}

/** 删除模板 */
export function deleteReportTemplate(reportType: string): Promise<{ deleted: string }> {
  return api.del(`/api/report-templates/${reportType}`);
}
