/**
 * P8.1 两层配置基础设施测试。
 *
 * 覆盖：
 *   - ModelRegistry CRUD + 校验（alias 唯一、modelId 非空）
 *   - CallSiteBinding 解析（6 个调用点）
 *   - config-loader 优先级链（binding > 调用点 env > 全局 env > 默认）
 *   - LlmService.model(callSite) 按 binding 解析模型
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ModelEndpoint, ModelRegistry } from "../../../src/llm/model-registry.js";
import { CALL_SITES, CallSiteBinding } from "../../../src/llm/call-sites.js";
import { loadConfig } from "../../../src/llm/config-loader.js";
import { LlmService } from "../../../src/services/llm-service.js";

let tmpRoot: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lif-p81-"));
  process.env.LIF_DATA_DIR = tmpRoot;
  // 保存相关 env
  savedEnv = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    LIF_MODEL: process.env.LIF_MODEL,
    LIF_PLANNER_MODEL: process.env.LIF_PLANNER_MODEL,
    LIF_REWRITE_MODEL: process.env.LIF_REWRITE_MODEL,
    LIF_TRANSLATE_MODEL: process.env.LIF_TRANSLATE_MODEL,
  };
  // 测试用固定 key
  process.env.OPENAI_API_KEY = "test-key";
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_MODEL;
  delete process.env.LIF_MODEL;
  delete process.env.LIF_PLANNER_MODEL;
  delete process.env.LIF_REWRITE_MODEL;
  delete process.env.LIF_TRANSLATE_MODEL;
});

afterEach(() => {
  // 恢复 env
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ModelRegistry
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.1 ModelRegistry", () => {
  it("ModelEndpoint schema 校验合法条目", () => {
    const ep = ModelEndpoint.parse({
      alias: "deepseek-v4-pro",
      provider: "openai-compatible",
      modelId: "deepseek-chat",
      baseURL: "https://api.deepseek.com",
      apiKeyEnv: "OPENAI_API_KEY",
      structuredSupport: "weak",
      capabilities: ["chat", "reasoning"],
    });
    expect(ep.alias).toBe("deepseek-v4-pro");
    expect(ep.structuredSupport).toBe("weak");
    expect(ep.enabled).toBe(true); // 默认值
  });

  it("ModelEndpoint 拒绝非法 alias（含大写/空格）", () => {
    expect(() => ModelEndpoint.parse({ alias: "Bad Alias", provider: "openai", modelId: "x" })).toThrow();
  });

  it("ModelEndpoint 拒绝缺 modelId", () => {
    expect(() => ModelEndpoint.parse({ alias: "x", provider: "openai" })).toThrow();
  });

  it("registry.add 成功添加", () => {
    const reg = new ModelRegistry();
    reg.add({
      alias: "gpt-4o",
      provider: "openai",
      modelId: "gpt-4o",
      apiKeyEnv: "OPENAI_API_KEY",
      structuredSupport: "native",
      capabilities: ["chat"],
    });
    expect(reg.get("gpt-4o")?.modelId).toBe("gpt-4o");
  });

  it("registry.add 拒绝重复 alias", () => {
    const reg = new ModelRegistry();
    reg.add({
      alias: "gpt-4o", provider: "openai", modelId: "gpt-4o",
      apiKeyEnv: "OPENAI_API_KEY", structuredSupport: "native", capabilities: ["chat"],
    });
    expect(() =>
      reg.add({
        alias: "gpt-4o", provider: "openai", modelId: "gpt-4o-2024",
        apiKeyEnv: "OPENAI_API_KEY", structuredSupport: "native", capabilities: ["chat"],
      }),
    ).toThrow(/alias.*已存在/i);
  });

  it("registry.listEnabled 只返回 enabled=true", () => {
    const reg = new ModelRegistry();
    reg.add({
      alias: "a", provider: "openai", modelId: "a",
      apiKeyEnv: "K", structuredSupport: "native", capabilities: ["chat"], enabled: true,
    });
    reg.add({
      alias: "b", provider: "openai", modelId: "b",
      apiKeyEnv: "K", structuredSupport: "native", capabilities: ["chat"], enabled: false,
    });
    expect(reg.listEnabled().map((e) => e.alias)).toEqual(["a"]);
  });

  it("registry.remove 删除条目", () => {
    const reg = new ModelRegistry();
    reg.add({
      alias: "x", provider: "openai", modelId: "x",
      apiKeyEnv: "K", structuredSupport: "native", capabilities: ["chat"],
    });
    reg.remove("x");
    expect(reg.get("x")).toBeUndefined();
  });

  it("registry.toJSON / fromJSON 往返", () => {
    const reg = new ModelRegistry();
    reg.add({
      alias: "x", provider: "openai", modelId: "x",
      apiKeyEnv: "K", structuredSupport: "native", capabilities: ["chat"],
    });
    const json = reg.toJSON();
    const reg2 = ModelRegistry.fromJSON(json);
    expect(reg2.get("x")?.modelId).toBe("x");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CallSiteBinding
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.1 CallSiteBinding", () => {
  it("CALL_SITES 包含全部调用点（P8 基础 6 + nexus 扩展 4 + podcast-skill 扩展 1）", () => {
    expect(CALL_SITES).toEqual([
      "planner",
      "rewrite",
      "translate",
      "seam_repair",
      "terminology",
      "image_prompts",
      // S3 平台扩展：ReAct harness / NexusOps 应用调用点
      "nexus_agent",
      "nexus_advise",
      // C2 扩展：finalize 后可信度审计（便宜模型，事后 review pass）
      "nexus_review",
      // 叙事层扩展：工具结果实时解读（轻量模型，每步一次）
      "nexus_narrate",
      // podcast-skill 应用调用点
      "podcast_skill_agent",
    ]);
  });

  it("CallSiteBinding schema 校验合法绑定", () => {
    const b = CallSiteBinding.parse({
      callSite: "planner",
      modelAlias: "deepseek-v4-pro",
      params: { temperature: 0.2 },
    });
    expect(b.callSite).toBe("planner");
    expect(b.modelAlias).toBe("deepseek-v4-pro");
    expect(b.params.temperature).toBe(0.2);
    expect(b.robustGuard).toBe(false); // 默认
  });

  it("CallSiteBinding 拒绝未知 callSite", () => {
    expect(() =>
      CallSiteBinding.parse({ callSite: "unknown", modelAlias: "x" }),
    ).toThrow();
  });

  it("CallSiteBinding 拒绝越界 temperature", () => {
    expect(() =>
      CallSiteBinding.parse({
        callSite: "planner", modelAlias: "x",
        params: { temperature: 3 },
      }),
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// config-loader 优先级链
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.1 config-loader 优先级", () => {
  it("优先级 1：CallSiteBinding 显式指定 > env", () => {
    process.env.LIF_PLANNER_MODEL = "from-env";
    mkdirSync(join(tmpRoot, "config"), { recursive: true });
    writeFileSync(
      join(tmpRoot, "config", "call_site_bindings.json"),
      JSON.stringify([{ callSite: "planner", modelAlias: "from-binding" }]),
    );
    const cfg = loadConfig(tmpRoot);
    expect(cfg.resolveAlias("planner")).toBe("from-binding");
  });

  it("优先级 2：无 binding 时回退调用点专用 env", () => {
    process.env.LIF_PLANNER_MODEL = "from-env";
    const cfg = loadConfig(tmpRoot); // tmpRoot 无 config 目录
    expect(cfg.resolveAlias("planner")).toBe("from-env");
  });

  it("优先级 3：无 binding 无专用 env 时回退全局 env", () => {
    process.env.OPENAI_MODEL = "global-model";
    const cfg = loadConfig(tmpRoot);
    expect(cfg.resolveAlias("planner")).toBe("global-model");
  });

  it("优先级 4：全无时回退默认绑定", () => {
    const cfg = loadConfig(tmpRoot);
    const alias = cfg.resolveAlias("planner");
    expect(alias).toBeTruthy(); // DEFAULT_BINDINGS 给出
    expect(typeof alias).toBe("string");
  });

  it("rewrite 调用点专用 env：LIF_REWRITE_MODEL", () => {
    process.env.LIF_REWRITE_MODEL = "rewrite-specific";
    const cfg = loadConfig(tmpRoot);
    expect(cfg.resolveAlias("rewrite")).toBe("rewrite-specific");
  });

  it("配置文件损坏时降级到 env 不抛错", () => {
    mkdirSync(join(tmpRoot, "config"), { recursive: true });
    writeFileSync(
      join(tmpRoot, "config", "call_site_bindings.json"),
      "{ broken json",
    );
    const cfg = loadConfig(tmpRoot); // 不抛
    process.env.OPENAI_MODEL = "fallback";
    expect(cfg.resolveAlias("planner")).toBe("fallback");
  });

  it("getBinding 返回完整绑定（含 params）", () => {
    mkdirSync(join(tmpRoot, "config"), { recursive: true });
    writeFileSync(
      join(tmpRoot, "config", "call_site_bindings.json"),
      JSON.stringify([{
        callSite: "planner", modelAlias: "p",
        params: { temperature: 0.3, maxTokens: 2000 },
      }]),
    );
    const cfg = loadConfig(tmpRoot);
    const binding = cfg.getBinding("planner");
    expect(binding?.modelAlias).toBe("p");
    expect(binding?.params.temperature).toBe(0.3);
    expect(binding?.params.maxTokens).toBe(2000);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LlmService.model(callSite) 集成
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.1 LlmService 按 callSite 解析", () => {
  it("model(callSite) 返回 LanguageModel（不抛错）", () => {
    process.env.OPENAI_MODEL = "gpt-4o";
    const svc = new LlmService();
    const m = svc.model("planner");
    expect(m).toBeDefined();
  });

  it("model(role) 旧重载仍可用（向后兼容）", () => {
    process.env.OPENAI_MODEL = "gpt-4o";
    const svc = new LlmService();
    expect(() => svc.model("writer" as never)).not.toThrow();
  });
});
