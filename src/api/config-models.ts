import { Hono } from "hono";
import { ModelRegistry, ModelEndpointSchema, type ModelEndpointInput } from "../llm/model-registry.js";
import { saveConfig, loadConfig } from "../llm/config-loader.js";
import type { EventBus } from "../core/event-bus.js";

/**
 * 模型接入 CRUD API（页面 A 后端，见 docs/13-p8-config-and-observability.md §13.6）。
 *
 * 路由：
 *   GET    /api/config/models          列出全部模型
 *   POST   /api/config/models          新增模型
 *   PUT    /api/config/models/:alias   更新模型
 *   DELETE /api/config/models/:alias   删除模型
 *
 * 写操作后发 config_changed 事件，触发 LlmService 清缓存。
 */
export function createConfigModelsApp(dataDir: string, bus: EventBus): Hono {
  const app = new Hono();

  /** 加载当前 registry + bindings，保存回磁盘。 */
  function persist(registry: ModelRegistry): void {
    const cfg = loadConfig(dataDir);
    saveConfig(dataDir, registry, Array.from(cfg.bindings.values()));
    bus.emit("config_changed", { source: "models" });
  }

  function currentRegistry(): ModelRegistry {
    return loadConfig(dataDir).registry;
  }

  // GET 列表
  app.get("/", (c) => {
    const reg = currentRegistry();
    return c.json({ status: "success", data: reg.list() });
  });

  // POST 新增
  app.post("/", async (c) => {
    const body = await c.req.json();
    const parseResult = ModelEndpointSchema.safeParse(body);
    if (!parseResult.success) {
      return c.json({ status: "error", message: parseResult.error.message }, 400);
    }
    const reg = currentRegistry();
    if (reg.get(parseResult.data.alias)) {
      return c.json({ status: "error", message: `alias "${parseResult.data.alias}" 已存在` }, 409);
    }
    reg.add(parseResult.data as ModelEndpointInput);
    persist(reg);
    return c.json({ status: "success", data: parseResult.data });
  });

  // PUT 更新
  app.put("/:alias", async (c) => {
    const alias = c.req.param("alias");
    const body = await c.req.json();
    const reg = currentRegistry();
    if (!reg.get(alias)) {
      return c.json({ status: "error", message: `alias "${alias}" 不存在` }, 404);
    }
    reg.update(alias, body as Partial<ModelEndpointInput>);
    persist(reg);
    return c.json({ status: "success", data: reg.get(alias) });
  });

  // DELETE 删除
  app.delete("/:alias", (c) => {
    const alias = c.req.param("alias");
    const reg = currentRegistry();
    if (!reg.get(alias)) {
      return c.json({ status: "error", message: `alias "${alias}" 不存在` }, 404);
    }
    reg.remove(alias);
    persist(reg);
    return c.json({ status: "success", data: { deleted: alias } });
  });

  return app;
}
