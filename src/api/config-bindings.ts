import { Hono } from "hono";
import { saveConfig, loadConfig } from "../llm/config-loader.js";
import { CALL_SITES, CallSiteBinding, type CallSite } from "../llm/call-sites.js";
import type { EventBus } from "../core/event-bus.js";

/**
 * 调用点绑定 API（页面 B 后端，见 docs/13-p8-config-and-observability.md §13.6）。
 *
 * 路由：
 *   GET /api/config/bindings           列出 6 个调用点的绑定（含默认）
 *   PUT /api/config/bindings/:callSite 更新某调用点的绑定
 *
 * 写操作后发 config_changed 事件。
 */
export function createConfigBindingsApp(dataDir: string, bus: EventBus): Hono {
  const app = new Hono();

  /** 取当前全部绑定（显式 + 默认占位）。 */
  function listBindings(): CallSiteBinding[] {
    const cfg = loadConfig(dataDir);
    return CALL_SITES.map((callSite) => {
      const explicit = cfg.bindings.get(callSite);
      if (explicit) return explicit;
      // 无显式绑定时返回占位（modelAlias 来自 resolveAlias）
      return CallSiteBinding.parse({
        callSite,
        modelAlias: cfg.resolveAlias(callSite) ?? "",
        params: {},
      });
    });
  }

  /** 持久化绑定。 */
  function persistBindings(bindings: CallSiteBinding[]): void {
    const cfg = loadConfig(dataDir);
    saveConfig(dataDir, cfg.registry, bindings);
    bus.emit("config_changed", { source: "bindings" });
  }

  // GET 列表
  app.get("/", (c) => {
    return c.json({ status: "success", data: listBindings() });
  });

  // PUT 更新某调用点
  app.put("/:callSite", async (c) => {
    const callSite = c.req.param("callSite") as CallSite;
    if (!CALL_SITES.includes(callSite)) {
      return c.json({ status: "error", message: `未知 callSite: ${callSite}` }, 400);
    }
    const body = await c.req.json();
    const parseResult = CallSiteBinding.safeParse({ ...body, callSite });
    if (!parseResult.success) {
      return c.json({ status: "error", message: parseResult.error.message }, 400);
    }
    // 合并到现有绑定列表
    const current = listBindings();
    const updated = current.map((b) =>
      b.callSite === callSite ? parseResult.data : b,
    );
    persistBindings(updated);
    return c.json({ status: "success", data: parseResult.data });
  });

  return app;
}
