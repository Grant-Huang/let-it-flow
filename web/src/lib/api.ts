// 统一 API 客户端。后端响应统一结构 { status, data, message }。
// 见 §API & Data Exchange 约定。

export interface ApiResult<T = unknown> {
  status: "success" | "error";
  data: T;
  message?: string;
}

async function request<T>(
  url: string,
  init?: RequestInit,
): Promise<T> {
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
