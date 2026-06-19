import { Hono } from "hono";
import {
  loadHeavyIoSettings,
  patchHeavyIoSettings,
  type HeavyIoSettingsPatch,
} from "../core/heavy-io-settings.js";
import { getDataDir } from "../core/config.js";

/**
 * 重 IO 工具链设置 API（页面3 后端）。
 *
 * 路由：
 *   GET /api/config/heavy-io   读取（含每项值来源 source）
 *   PUT /api/config/heavy-io   部分更新
 *
 * 注意：改动需重启进程才生效（SubprocessAdapter 在启动时构造）。
 */
export function createConfigHeavyIoApp(dataDir: string = getDataDir()): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const { settings, sources } = loadHeavyIoSettings(dataDir);
    return c.json({ status: "success", data: { settings, sources } });
  });

  app.put("/", async (c) => {
    const body = await c.req.json();
    const { settings, sources } = patchHeavyIoSettings(
      body as HeavyIoSettingsPatch,
      dataDir,
    );
    return c.json({ status: "success", data: { settings, sources } });
  });

  return app;
}
