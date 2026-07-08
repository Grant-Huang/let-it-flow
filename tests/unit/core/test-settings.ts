/**
 * 系统设置（页面2）与重 IO 设置（页面3）后端测试。
 *
 * 覆盖：
 *   - system-settings 读写 + 默认值降级 + 部分更新 + 类型校验
 *   - heavy-io-settings JSON > env > 默认值 优先级链
 *   - /api/config/system GET/PUT
 *   - /api/config/heavy-io GET/PUT
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  loadSystemSettings,
  saveSystemSettings,
  patchSystemSettings,
  DEFAULT_SYSTEM_SETTINGS,
  getHeavyIoTimeoutMs,
} from "../../../src/core/system-settings.js";
import {
  loadHeavyIoSettings,
  patchHeavyIoSettings,
  DEFAULT_HEAVY_IO_SETTINGS,
} from "../../../src/core/heavy-io-settings.js";
import { createConfigSystemApp } from "../../../src/api/config-system.js";
import { createConfigHeavyIoApp } from "../../../src/api/config-heavy-io.js";

interface ApiResponse<T = unknown> {
  status: "success" | "error";
  data: T;
  message?: string;
}

let tmpRoot: string;
let savedDataDir: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lif-settings-"));
  savedDataDir = process.env.LIF_DATA_DIR;
  process.env.LIF_DATA_DIR = tmpRoot;
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.LIF_DATA_DIR;
  else process.env.LIF_DATA_DIR = savedDataDir;
});

// ─────────────────────────────────────────────────────────────────────────────
// system-settings 数据层
// ─────────────────────────────────────────────────────────────────────────────

describe("system-settings 数据层", () => {
  it("无配置文件时返回默认值", () => {
    const s = loadSystemSettings(tmpRoot);
    expect(s.heavyIoTimeoutMs).toBe(900_000);
    expect(s.coalescerMaxBuffer).toBe(8);
    expect(s.contentStrip).toBe(true);
    expect(s.contentSummarize).toBe(false);
  });

  it("默认值含新增 SSE push 模式字段", () => {
    const s = loadSystemSettings(tmpRoot);
    expect(s.ssePushMode).toBe("push");
    expect(s.coalescerEnabled).toBe(false);
    expect(s.sseDeadlineMs).toBe(5 * 60 * 1000);
    expect(s.ssePollIntervalMs).toBe(50);
  });

  it("ssePushMode 非法值降级为默认 push", () => {
    mkdirSync(join(tmpRoot, "config"), { recursive: true });
    writeFileSync(
      join(tmpRoot, "config", "system_settings.json"),
      JSON.stringify({ ...DEFAULT_SYSTEM_SETTINGS, ssePushMode: "invalid" }),
      "utf8",
    );
    const s = loadSystemSettings(tmpRoot);
    expect(s.ssePushMode).toBe("push");
  });

  it("patchSystemSettings 可切换 ssePushMode 到 poll", () => {
    patchSystemSettings({ ssePushMode: "poll" }, tmpRoot);
    const loaded = loadSystemSettings(tmpRoot);
    expect(loaded.ssePushMode).toBe("poll");
  });

  it("patchSystemSettings 对非法 ssePushMode 抛错", () => {
    expect(() =>
      patchSystemSettings({ ssePushMode: "weird" as "push" | "poll" }, tmpRoot),
    ).toThrow(/ssePushMode/);
  });

  it("saveSystemSettings 写盘，loadSystemSettings 读回", () => {
    const modified = { ...DEFAULT_SYSTEM_SETTINGS, heavyIoTimeoutMs: 123456, coalescerMaxBuffer: 16 };
    saveSystemSettings(modified, tmpRoot);
    expect(existsSync(join(tmpRoot, "config", "system_settings.json"))).toBe(true);
    const loaded = loadSystemSettings(tmpRoot);
    expect(loaded.heavyIoTimeoutMs).toBe(123456);
    expect(loaded.coalescerMaxBuffer).toBe(16);
  });

  it("patchSystemSettings 部分更新，未指定字段保持不变", () => {
    patchSystemSettings({ ssePollIntervalMs: 100 }, tmpRoot);
    const loaded = loadSystemSettings(tmpRoot);
    expect(loaded.ssePollIntervalMs).toBe(100);
    expect(loaded.heavyIoTimeoutMs).toBe(DEFAULT_SYSTEM_SETTINGS.heavyIoTimeoutMs);
  });

  it("配置文件损坏时降级到默认值（不抛错）", () => {
    mkdirSync(join(tmpRoot, "config"), { recursive: true });
    writeFileSync(join(tmpRoot, "config", "system_settings.json"), "{ invalid json", "utf8");
    const s = loadSystemSettings(tmpRoot);
    expect(s.heavyIoTimeoutMs).toBe(900_000);
  });

  it("未知字段被忽略，不污染结果", () => {
    saveSystemSettings(
      { ...DEFAULT_SYSTEM_SETTINGS, unknownField: "x" } as unknown as typeof DEFAULT_SYSTEM_SETTINGS,
      tmpRoot,
    );
    const loaded = loadSystemSettings(tmpRoot);
    expect((loaded as unknown as Record<string, unknown>).unknownField).toBeUndefined();
  });

  it("便捷 getter 返回当前设置值", () => {
    patchSystemSettings({ heavyIoTimeoutMs: 777777 }, tmpRoot);
    // getter 默认读 process.env.LIF_DATA_DIR（已设为 tmpRoot）
    expect(getHeavyIoTimeoutMs()).toBe(777777);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/config/system 端点
// ─────────────────────────────────────────────────────────────────────────────

describe("/api/config/system", () => {
  it("GET 返回默认设置", async () => {
    const app = createConfigSystemApp(tmpRoot);
    const res = await app.request("/");
    const body = (await res.json()) as ApiResponse<{ heavyIoTimeoutMs: number }>;
    expect(body.status).toBe("success");
    expect(body.data.heavyIoTimeoutMs).toBe(900_000);
  });

  it("PUT 部分更新后 GET 反映新值", async () => {
    const app = createConfigSystemApp(tmpRoot);
    const res = await app.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ssePollIntervalMs: 99, contentStrip: false }),
    });
    const body = (await res.json()) as ApiResponse<{ ssePollIntervalMs: number; contentStrip: boolean }>;
    expect(body.status).toBe("success");
    expect(body.data.ssePollIntervalMs).toBe(99);
    expect(body.data.contentStrip).toBe(false);
  });

  it("PUT 类型错误返回 400", async () => {
    const app = createConfigSystemApp(tmpRoot);
    const res = await app.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ heavyIoTimeoutMs: "not-a-number" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as ApiResponse;
    expect(body.status).toBe("error");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// heavy-io-settings 数据层（优先级链）
// ─────────────────────────────────────────────────────────────────────────────

describe("heavy-io-settings 优先级链", () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {
      LIF_REWRITE_BACKEND: process.env.LIF_REWRITE_BACKEND,
      LIF_OLLAMA_MODEL: process.env.LIF_OLLAMA_MODEL,
      LIF_TTS_ENGINE: process.env.LIF_TTS_ENGINE,
      LIF_PYTHON_BIN: process.env.LIF_PYTHON_BIN,
    };
    delete process.env.LIF_REWRITE_BACKEND;
    delete process.env.LIF_OLLAMA_MODEL;
    delete process.env.LIF_TTS_ENGINE;
    delete process.env.LIF_PYTHON_BIN;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("无 JSON 无 env 时返回默认值（source=default）", () => {
    const { settings, sources } = loadHeavyIoSettings(tmpRoot);
    expect(settings.rewriteBackend).toBe("ollama");
    expect(settings.ttsEngine).toBe("edge");
    expect(sources.rewriteBackend).toBe("default");
  });

  it("env 覆盖默认值（source=env）", () => {
    process.env.LIF_REWRITE_BACKEND = "openai";
    process.env.LIF_TTS_ENGINE = "qwen";
    const { settings, sources } = loadHeavyIoSettings(tmpRoot);
    expect(settings.rewriteBackend).toBe("openai");
    expect(settings.ttsEngine).toBe("qwen");
    expect(sources.rewriteBackend).toBe("env");
    expect(sources.ttsEngine).toBe("env");
  });

  it("JSON 覆盖 env（source=json 优先级最高）", () => {
    process.env.LIF_REWRITE_BACKEND = "openai";
    // 写 JSON
    mkdirSync(join(tmpRoot, "config"), { recursive: true });
    writeFileSync(
      join(tmpRoot, "config", "heavy_io_settings.json"),
      JSON.stringify({ rewriteBackend: "ollama", pythonBin: "/custom/python" }),
      "utf8",
    );
    const { settings, sources } = loadHeavyIoSettings(tmpRoot);
    expect(settings.rewriteBackend).toBe("ollama");
    expect(settings.pythonBin).toBe("/custom/python");
    expect(sources.rewriteBackend).toBe("json");
    expect(sources.pythonBin).toBe("json");
  });

  it("patchHeavyIoSettings 写盘后所有覆盖项 source=json", () => {
    const { settings, sources } = patchHeavyIoSettings(
      { rewriteBackend: "openai", ttsRefAudio: "new/ref.wav" },
      tmpRoot,
    );
    expect(settings.rewriteBackend).toBe("openai");
    expect(sources.rewriteBackend).toBe("json");
    expect(sources.ttsRefAudio).toBe("json");
    // patch 把完整设置写盘，故未显式改的字段也变为 json 来源
    expect(sources.ttsEngine).toBe("json");
    // 但值仍是默认值
    expect(settings.ttsEngine).toBe(DEFAULT_HEAVY_IO_SETTINGS.ttsEngine);
  });

  it("JSON 文件损坏降级", () => {
    mkdirSync(join(tmpRoot, "config"), { recursive: true });
    writeFileSync(join(tmpRoot, "config", "heavy_io_settings.json"), "broken", "utf8");
    const { settings } = loadHeavyIoSettings(tmpRoot);
    expect(settings.rewriteBackend).toBe(DEFAULT_HEAVY_IO_SETTINGS.rewriteBackend);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /api/config/heavy-io 端点
// ─────────────────────────────────────────────────────────────────────────────

describe("/api/config/heavy-io", () => {
  it("GET 返回 settings + sources", async () => {
    const app = createConfigHeavyIoApp(tmpRoot);
    const res = await app.request("/");
    const body = (await res.json()) as ApiResponse<{
      settings: { rewriteBackend: string };
      sources: Record<string, string>;
    }>;
    expect(body.status).toBe("success");
    expect(body.data.settings.rewriteBackend).toBe("ollama");
    expect(body.data.sources.rewriteBackend).toBe("default");
  });

  it("PUT 部分更新后 GET 反映新值", async () => {
    const app = createConfigHeavyIoApp(tmpRoot);
    const res = await app.request("/", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ttsEngine: "qwen", pythonBin: "/usr/bin/python3.11" }),
    });
    const body = (await res.json()) as ApiResponse<{
      settings: { ttsEngine: string; pythonBin: string };
      sources: Record<string, string>;
    }>;
    expect(body.status).toBe("success");
    expect(body.data.settings.ttsEngine).toBe("qwen");
    expect(body.data.settings.pythonBin).toBe("/usr/bin/python3.11");
    expect(body.data.sources.ttsEngine).toBe("json");
  });
});
