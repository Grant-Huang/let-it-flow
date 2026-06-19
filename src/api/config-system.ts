import { Hono } from "hono";
import {
  loadSystemSettings,
  patchSystemSettings,
  type SystemSettings,
  type SystemSettingsPatch,
} from "../core/system-settings.js";
import { getDataDir } from "../core/config.js";

/**
 * 系统设置 API（页面2 后端）。
 *
 * 路由：
 *   GET /api/config/system   读取当前系统设置
 *   PUT /api/config/system   更新系统设置（部分更新）
 *
 * 注意：系统设置不热加载（仅模型配置热加载）。改后下次读取生效。
 */
export function createConfigSystemApp(dataDir: string = getDataDir()): Hono {
  const app = new Hono();

  // GET 当前设置
  app.get("/", (c) => {
    return c.json({ status: "success", data: loadSystemSettings(dataDir) });
  });

  // PUT 部分更新
  app.put("/", async (c) => {
    const body = await c.req.json();
    try {
      const updated = patchSystemSettings(body as SystemSettingsPatch, dataDir);
      return c.json({ status: "success", data: updated });
    } catch (e) {
      return c.json(
        { status: "error", message: e instanceof Error ? e.message : String(e) },
        400,
      );
    }
  });

  return app;
}

/** 暴露类型供前端类型对齐参考。 */
export type { SystemSettings, SystemSettingsPatch };
