/**
 * P8.4 配置 API + 热加载测试。
 *
 * 覆盖：
 *   - EventBus 发布订阅
 *   - /api/config/models CRUD（GET/POST/PUT/DELETE）
 *   - /api/config/bindings GET/PUT
 *   - 配置变更后发 config_changed 事件
 *   - LlmService 监听 config_changed 清缓存
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EventBus } from "../../../src/core/event-bus.js";
import { createConfigModelsApp } from "../../../src/api/config-models.js";
import { createConfigBindingsApp } from "../../../src/api/config-bindings.js";
import { LlmService } from "../../../src/services/llm-service.js";

/** API 响应类型。 */
interface ApiResponse<T = unknown> {
  status: "success" | "error";
  data: T;
  message?: string;
}

let tmpRoot: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lif-p84-"));
  process.env.LIF_DATA_DIR = tmpRoot;
  process.env.OPENAI_API_KEY = "test-key";
  savedEnv = {
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
  };
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_MODEL;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// EventBus
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.4 EventBus", () => {
  it("发布事件，订阅者收到", () => {
    const bus = new EventBus();
    const received: string[] = [];
    bus.on("test_event", (data: unknown) => {
      received.push((data as { msg: string }).msg);
    });
    bus.emit("test_event", { msg: "hello" });
    expect(received).toEqual(["hello"]);
  });

  it("多个订阅者都收到", () => {
    const bus = new EventBus();
    let count = 0;
    bus.on("e", () => count++);
    bus.on("e", () => count++);
    bus.emit("e", {});
    expect(count).toBe(2);
  });

  it("off 取消订阅", () => {
    const bus = new EventBus();
    let count = 0;
    const handler = () => count++;
    bus.on("e", handler);
    bus.off("e", handler);
    bus.emit("e", {});
    expect(count).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/config/models CRUD
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.4 /api/config/models CRUD", () => {
  it("POST 新增模型，GET 列表含新模型", async () => {
    const events: string[] = [];
    const bus = new EventBus();
    bus.on("config_changed", () => events.push("config_changed"));
    const app = createConfigModelsApp(tmpRoot, bus);

    const res1 = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        alias: "test-model",
        provider: "openai",
        modelId: "gpt-4o",
        apiKeyEnv: "OPENAI_API_KEY",
        structuredSupport: "native",
        capabilities: ["chat"],
      }),
    });
    expect(res1.status).toBe(200);
    const body1 = await res1.json() as ApiResponse;
    expect(body1.status).toBe("success");

    const res2 = await app.request("/");
    const body2 = await res2.json() as ApiResponse<Array<{ alias: string }>>;
    expect(body2.status).toBe("success");
    const aliases = body2.data.map((m) => m.alias);
    expect(aliases).toContain("test-model");
    // 配置变更应发事件
    expect(events).toContain("config_changed");
  });

  it("POST 重复 alias 返回 error", async () => {
    const bus = new EventBus();
    const app = createConfigModelsApp(tmpRoot, bus);
    const payload = JSON.stringify({
      alias: "dup", provider: "openai", modelId: "x",
      apiKeyEnv: "K", structuredSupport: "native", capabilities: ["chat"],
    });
    await app.request("/", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: payload,
    });
    const res = await app.request("/", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: payload,
    });
    const body = await res.json() as ApiResponse;
    expect(body.status).toBe("error");
  });

  it("PUT 更新模型", async () => {
    const bus = new EventBus();
    const app = createConfigModelsApp(tmpRoot, bus);
    await app.request("/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        alias: "m1", provider: "openai", modelId: "old",
        apiKeyEnv: "K", structuredSupport: "native", capabilities: ["chat"],
      }),
    });
    const res = await app.request("/m1", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "new" }),
    });
    const body = await res.json() as ApiResponse;
    expect(body.status).toBe("success");
    const list = await (await app.request("/")).json() as ApiResponse<Array<{ alias: string; modelId: string }>>;
    const m = list.data.find((x) => x.alias === "m1");
    expect(m?.modelId).toBe("new");
  });

  it("DELETE 删除模型", async () => {
    const bus = new EventBus();
    const app = createConfigModelsApp(tmpRoot, bus);
    await app.request("/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        alias: "todel", provider: "openai", modelId: "x",
        apiKeyEnv: "K", structuredSupport: "native", capabilities: ["chat"],
      }),
    });
    await app.request("/todel", { method: "DELETE" });
    const list = await (await app.request("/")).json() as ApiResponse<Array<{ alias: string }>>;
    expect(list.data.find((x) => x.alias === "todel")).toBeUndefined();
  });

  it("配置写入 model_registry.json", async () => {
    const bus = new EventBus();
    const app = createConfigModelsApp(tmpRoot, bus);
    await app.request("/", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        alias: "persist-test", provider: "openai", modelId: "x",
        apiKeyEnv: "K", structuredSupport: "native", capabilities: ["chat"],
      }),
    });
    const path = join(tmpRoot, "config", "model_registry.json");
    expect(existsSync(path)).toBe(true);
    const data = JSON.parse(readFileSync(path, "utf8"));
    expect(data.some((m: { alias: string }) => m.alias === "persist-test")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/config/bindings
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.4 /api/config/bindings", () => {
  it("GET 返回全部调用点的绑定（含默认）", async () => {
    const bus = new EventBus();
    const app = createConfigBindingsApp(tmpRoot, bus);
    const res = await app.request("/");
    const body = await res.json() as ApiResponse<Array<{ callSite: string }>>;
    expect(body.status).toBe("success");
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data.length).toBe(10); // P8 基础 6 + nexus_agent/nexus_advise + nexus_review + podcast_skill_agent
    const sites = body.data.map((b) => b.callSite);
    expect(sites).toContain("planner");
    expect(sites).toContain("rewrite");
    expect(sites).toContain("nexus_review");
    expect(sites).toContain("podcast_skill_agent");
  });

  it("PUT 更新某调用点的绑定", async () => {
    const bus = new EventBus();
    const app = createConfigBindingsApp(tmpRoot, bus);
    const res = await app.request("/planner", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelAlias: "new-model", params: { temperature: 0.5 } }),
    });
    const body = await res.json() as ApiResponse;
    expect(body.status).toBe("success");
    // 再 GET 确认
    const list = await (await app.request("/")).json() as ApiResponse<Array<{ callSite: string; modelAlias: string; params: { temperature?: number } }>>;
    const planner = list.data.find((b) => b.callSite === "planner");
    expect(planner?.modelAlias).toBe("new-model");
    expect(planner?.params.temperature).toBe(0.5);
  });

  it("PUT 写入 call_site_bindings.json", async () => {
    const bus = new EventBus();
    const app = createConfigBindingsApp(tmpRoot, bus);
    await app.request("/rewrite", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelAlias: "rw-model" }),
    });
    const path = join(tmpRoot, "config", "call_site_bindings.json");
    expect(existsSync(path)).toBe(true);
    const data = JSON.parse(readFileSync(path, "utf8"));
    expect(data.some((b: { callSite: string }) => b.callSite === "rewrite")).toBe(true);
  });

  it("配置变更发 config_changed 事件", async () => {
    const events: string[] = [];
    const bus = new EventBus();
    bus.on("config_changed", () => events.push("fired"));
    const app = createConfigBindingsApp(tmpRoot, bus);
    await app.request("/planner", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelAlias: "x" }),
    });
    expect(events).toContain("fired");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LlmService 监听 config_changed
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.4 LlmService 热加载", () => {
  it("config_changed 事件触发 LlmService.clearCache", () => {
    const bus = new EventBus();
    const llm = new LlmService();
    // 触发一次 model 填充缓存
    process.env.OPENAI_MODEL = "gpt-4o";
    llm.model("planner");
    // spy clearCache
    const spy = vi.spyOn(llm, "clearCache");
    // 订阅 bus
    llm.subscribeConfigChanges(bus);
    bus.emit("config_changed", {});
    expect(spy).toHaveBeenCalled();
  });
});
