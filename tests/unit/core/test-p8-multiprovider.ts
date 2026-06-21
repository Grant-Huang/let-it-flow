/**
 * P8.5 多 Provider 密钥管理完整落地测试。
 *
 * 覆盖：
 *   - config-loader.resolveEndpoint 优先级链 + 完整 endpoint 返回
 *   - LlmService.getProvider 缓存（同 provider+baseURL 复用实例，不同则新建）
 *   - buildProvider 五 provider 分发（各 provider 产出带正确 modelId 的 LanguageModel）
 *   - compatModeFor per-callSite（不同调用点返回不同值）
 *   - ModelRegistry.validateEnvKeys（缺失清单）
 *   - ensureSeedConfig（首次 seed + 二次跳过 + .env 派生）
 *   - 向后兼容（registry 为空走 legacyModel 兜底）
 *   - call-tracer traceCtxFor（provider/pricing 从 endpoint 读）
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ModelRegistry } from "../../../src/llm/model-registry.js";
import { loadConfig, saveConfig } from "../../../src/llm/config-loader.js";
import { ensureSeedConfig } from "../../../src/llm/seed.js";
import { LlmService } from "../../../src/services/llm-service.js";

let tmpRoot: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lif-p85-"));
  process.env.LIF_DATA_DIR = tmpRoot;
  savedEnv = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    AZURE_API_KEY: process.env.AZURE_API_KEY,
    LIF_MODEL: process.env.LIF_MODEL,
    LIF_PLANNER_MODEL: process.env.LIF_PLANNER_MODEL,
    LIF_REWRITE_MODEL: process.env.LIF_REWRITE_MODEL,
  };
  process.env.OPENAI_API_KEY = "test-openai-key";
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  process.env.AZURE_API_KEY = "test-azure-key";
  delete process.env.OPENAI_BASE_URL;
  delete process.env.OPENAI_MODEL;
  delete process.env.LIF_MODEL;
  delete process.env.LIF_PLANNER_MODEL;
  delete process.env.LIF_REWRITE_MODEL;
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  process.env.LIF_DATA_DIR = savedEnv.LIF_DATA_DIR ?? tmpRoot;
});

/** 写一份多 provider registry + 6 调用点绑定到 tmpRoot/config。 */
function writeMultiProviderConfig(): void {
  mkdirSync(join(tmpRoot, "config"), { recursive: true });
  const registry = [
    {
      alias: "openai-official",
      provider: "openai",
      modelId: "gpt-4o",
      apiKeyEnv: "OPENAI_API_KEY",
      capabilities: ["chat", "structured"],
      enabled: true,
    },
    {
      alias: "deepseek-compat",
      provider: "openai-compatible",
      modelId: "deepseek-chat",
      baseURL: "https://api.deepseek.com",
      apiKeyEnv: "OPENAI_API_KEY",
      capabilities: ["chat"],
      enabled: true,
    },
    {
      alias: "claude-sonnet",
      provider: "anthropic",
      modelId: "claude-3-5-sonnet-20241022",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      capabilities: ["chat", "structured"],
      enabled: true,
    },
    {
      alias: "local-ollama",
      provider: "ollama",
      modelId: "qwen2.5:14b",
      baseURL: "http://localhost:11434/v1",
      capabilities: ["chat"],
      enabled: true,
    },
    {
      alias: "azure-pro",
      provider: "azure",
      modelId: "gpt-4o",
      apiKeyEnv: "AZURE_API_KEY",
      azureResourceName: "my-azure-resource",
      capabilities: ["chat", "structured"],
      enabled: true,
    },
  ];
  writeFileSync(
    join(tmpRoot, "config", "model_registry.json"),
    JSON.stringify(registry, null, 2),
  );
  const bindings = [
    { callSite: "planner", modelAlias: "openai-official", params: {}, robustGuard: false },
    { callSite: "rewrite", modelAlias: "deepseek-compat", params: {}, robustGuard: false },
    { callSite: "translate", modelAlias: "claude-sonnet", params: {}, robustGuard: false },
    { callSite: "seam_repair", modelAlias: "local-ollama", params: {}, robustGuard: false },
    { callSite: "terminology", modelAlias: "azure-pro", params: {}, robustGuard: false },
    { callSite: "image_prompts", modelAlias: "openai-official", params: {}, robustGuard: false },
  ];
  writeFileSync(
    join(tmpRoot, "config", "call_site_bindings.json"),
    JSON.stringify(bindings, null, 2),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// config-loader.resolveEndpoint
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.5 resolveEndpoint 优先级链", () => {
  it("命中 binding → 返回完整 ModelEndpoint（含 provider/apiKeyEnv/baseURL）", () => {
    writeMultiProviderConfig();
    const cfg = loadConfig(tmpRoot);
    const ep = cfg.resolveEndpoint("rewrite");
    expect(ep).toBeDefined();
    expect(ep?.provider).toBe("openai-compatible");
    expect(ep?.apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(ep?.baseURL).toBe("https://api.deepseek.com");
    expect(ep?.modelId).toBe("deepseek-chat");
  });

  it("binding 缺失 → 调用点 env → 返回 undefined（env 值不在 registry）", () => {
    // 仅写 registry，不写 bindings（调用点无显式绑定 → 走 env 回退）
    mkdirSync(join(tmpRoot, "config"), { recursive: true });
    writeFileSync(
      join(tmpRoot, "config", "model_registry.json"),
      JSON.stringify([
        {
          alias: "openai-official",
          provider: "openai",
          modelId: "gpt-4o",
          apiKeyEnv: "OPENAI_API_KEY",
          capabilities: ["chat"],
          enabled: true,
        },
      ]),
    );
    process.env.LIF_PLANNER_MODEL = "some-env-model-not-in-registry";
    const cfg = loadConfig(tmpRoot);
    // env 给出的 alias 不在 registry 中 → resolveEndpoint 返回 undefined
    expect(cfg.resolveEndpoint("planner")).toBeUndefined();
    // 但 resolveAlias 仍能返回该 env 值（优先级链正常工作）
    expect(cfg.resolveAlias("planner")).toBe("some-env-model-not-in-registry");
  });

  it("alias 命中 registry → 返回的对象 enabled 字段透传", () => {
    writeMultiProviderConfig();
    const cfg = loadConfig(tmpRoot);
    expect(cfg.resolveEndpoint("translate")?.enabled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// LlmService.getProvider 缓存 + buildProvider 五 provider 分发
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.5 LlmService 多 provider 分发", () => {
  it("model(callSite) 按 endpoint.provider 返回对应 modelId 的 LanguageModel", () => {
    writeMultiProviderConfig();
    const cfg = loadConfig(tmpRoot);
    const svc = new LlmService({ runtimeConfig: cfg });

    // planner → openai 官方 gpt-4o
    expect((svc.model("planner") as unknown as { modelId: string }).modelId).toBe("gpt-4o");
    // rewrite → openai-compatible deepseek-chat（走 .chat()）
    expect((svc.model("rewrite") as unknown as { modelId: string }).modelId).toBe("deepseek-chat");
    // translate → anthropic claude
    expect((svc.model("translate") as unknown as { modelId: string }).modelId).toBe("claude-3-5-sonnet-20241022");
    // seam_repair → ollama qwen（走 .chat()）
    expect((svc.model("seam_repair") as unknown as { modelId: string }).modelId).toBe("qwen2.5:14b");
    // terminology → azure gpt-4o
    expect((svc.model("terminology") as unknown as { modelId: string }).modelId).toBe("gpt-4o");
  });

  it("相同 provider+baseURL 的调用点复用同一 provider 实例（缓存）", () => {
    writeMultiProviderConfig();
    const cfg = loadConfig(tmpRoot);
    const svc = new LlmService({ runtimeConfig: cfg });
    // planner + image_prompts 都绑 openai-official（同 provider:modelId）
    const a = svc.model("planner");
    const b = svc.model("image_prompts");
    expect(a).toBe(b); // 同一 LanguageModel 实例（缓存命中）
  });

  it("不同 provider 的调用点产出不同实例", () => {
    writeMultiProviderConfig();
    const cfg = loadConfig(tmpRoot);
    const svc = new LlmService({ runtimeConfig: cfg });
    expect(svc.model("planner")).not.toBe(svc.model("rewrite"));
    expect(svc.model("rewrite")).not.toBe(svc.model("translate"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// compatModeFor per-callSite
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.5 compatModeFor per-callSite", () => {
  it("openai-compatible / ollama → true；openai / anthropic / azure → false", () => {
    writeMultiProviderConfig();
    const cfg = loadConfig(tmpRoot);
    const svc = new LlmService({ runtimeConfig: cfg });
    expect(svc.compatModeFor("planner")).toBe(false); // openai
    expect(svc.compatModeFor("rewrite")).toBe(true); // openai-compatible
    expect(svc.compatModeFor("translate")).toBe(false); // anthropic
    expect(svc.compatModeFor("seam_repair")).toBe(true); // ollama
    expect(svc.compatModeFor("terminology")).toBe(false); // azure
  });

  it("同任务内不同调用点返回不同 compatMode（per-callSite 生效）", () => {
    writeMultiProviderConfig();
    const cfg = loadConfig(tmpRoot);
    const svc = new LlmService({ runtimeConfig: cfg });
    // planner 走 openai 不需折叠 system；rewrite 走兼容服务需折叠
    const plannerCompat = svc.compatModeFor("planner");
    const rewriteCompat = svc.compatModeFor("rewrite");
    expect(plannerCompat).toBe(false);
    expect(rewriteCompat).toBe(true);
    expect(plannerCompat).not.toBe(rewriteCompat);
  });

  it("未命中 registry 时回退全局 useChat（向后兼容）", () => {
    // 空 registry + 无 baseURL → 全局 useChat = false
    const cfg = loadConfig(tmpRoot);
    const svc = new LlmService({ runtimeConfig: cfg });
    expect(svc.compatModeFor("planner")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ModelRegistry.validateEnvKeys
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.5 validateEnvKeys", () => {
  it("enabled endpoint 缺 key → 返回缺失清单", () => {
    delete process.env.ANTHROPIC_API_KEY; // claude-sonnet 会缺
    delete process.env.AZURE_API_KEY; // azure-pro 会缺
    writeMultiProviderConfig();
    const cfg = loadConfig(tmpRoot);
    const missing = cfg.registry.validateEnvKeys();
    const missingAliases = missing.map((m) => m.alias).sort();
    expect(missingAliases).toEqual(["azure-pro", "claude-sonnet"]);
  });

  it("ollama 不校验（本地无 key）", () => {
    writeMultiProviderConfig();
    const cfg = loadConfig(tmpRoot);
    const missing = cfg.registry.validateEnvKeys();
    expect(missing.find((m) => m.alias === "local-ollama")).toBeUndefined();
  });

  it("全部 key 已设 → 返回空数组", () => {
    writeMultiProviderConfig();
    const cfg = loadConfig(tmpRoot);
    expect(cfg.registry.validateEnvKeys()).toEqual([]);
  });

  it("禁用的 endpoint 不校验", () => {
    writeMultiProviderConfig();
    const cfg = loadConfig(tmpRoot);
    cfg.registry.update("claude-sonnet", { enabled: false });
    delete process.env.ANTHROPIC_API_KEY;
    const missing = cfg.registry.validateEnvKeys();
    expect(missing.find((m) => m.alias === "claude-sonnet")).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ensureSeedConfig
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.5 ensureSeedConfig", () => {
  it("首次启动（registry 空）→ 从 .env 派生 seed，返回 true", () => {
    process.env.OPENAI_API_KEY = "sk-seed-test";
    process.env.OPENAI_BASE_URL = "https://api.deepseek.com";
    process.env.OPENAI_MODEL = "deepseek-chat";
    const created = ensureSeedConfig(tmpRoot);
    expect(created).toBe(true);

    // 生成的配置文件应存在
    const regPath = join(tmpRoot, "config", "model_registry.json");
    expect(existsSync(regPath)).toBe(true);
    const reg = JSON.parse(readFileSync(regPath, "utf8"));
    expect(reg).toHaveLength(1);
    // 有 baseURL → provider=openai-compatible
    expect(reg[0].provider).toBe("openai-compatible");
    expect(reg[0].alias).toBe("default-openai-compatible");
    expect(reg[0].apiKeyEnv).toBe("OPENAI_API_KEY");
    expect(reg[0].modelId).toBe("deepseek-chat");

    // 全部调用点应绑定到 seed alias（P8 基础 6 + nexus 扩展 3 + podcast-skill 1 = 10）
    const bPath = join(tmpRoot, "config", "call_site_bindings.json");
    const bindings = JSON.parse(readFileSync(bPath, "utf8"));
    expect(bindings).toHaveLength(10);
    for (const b of bindings) {
      expect(b.modelAlias).toBe("default-openai-compatible");
    }
  });

  it("无 OPENAI_BASE_URL → seed provider=openai（官方）", () => {
    process.env.OPENAI_API_KEY = "sk-seed-test";
    delete process.env.OPENAI_BASE_URL;
    process.env.OPENAI_MODEL = "openai/gpt-4o";
    const created = ensureSeedConfig(tmpRoot);
    expect(created).toBe(true);
    const cfg = loadConfig(tmpRoot);
    const ep = cfg.registry.list()[0]!;
    expect(ep.provider).toBe("openai");
    // OPENAI_MODEL 的 openai/ 前缀应被剥离
    expect(ep.modelId).toBe("gpt-4o");
  });

  it("二次启动（registry 非空）→ 跳过，返回 false", () => {
    // 第一次 seed
    process.env.OPENAI_API_KEY = "sk-first";
    ensureSeedConfig(tmpRoot);
    // 用户手动新增一个模型（模拟已有配置）
    const cfg = loadConfig(tmpRoot);
    cfg.registry.add({
      alias: "user-model",
      provider: "anthropic",
      modelId: "claude-3-5-sonnet",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      capabilities: ["chat"],
      enabled: true,
    });
    saveConfig(tmpRoot, cfg.registry, Array.from(cfg.bindings.values()));

    // 第二次：不应覆盖
    process.env.OPENAI_API_KEY = "sk-changed-should-not-matter";
    const created = ensureSeedConfig(tmpRoot);
    expect(created).toBe(false);
    // 原配置应保留
    const after = loadConfig(tmpRoot);
    expect(after.registry.get("user-model")).toBeDefined();
    expect(after.registry.list()).toHaveLength(2); // seed 1 + 用户 1
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 向后兼容：registry 为空走 legacyModel 兜底
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.5 向后兼容（registry 空 → legacy 兜底）", () => {
  it("model(callSite) 在 registry 空时仍返回 LanguageModel（走 legacyModel）", () => {
    // 空 registry
    const cfg = loadConfig(tmpRoot);
    const svc = new LlmService({ runtimeConfig: cfg });
    expect(() => svc.model("planner")).not.toThrow();
    const m = svc.model("rewrite");
    expect(m).toBeDefined();
  });

  it("model(role) 旧重载在 registry 空时仍可用", () => {
    const cfg = loadConfig(tmpRoot);
    const svc = new LlmService({ runtimeConfig: cfg });
    expect(() => svc.model("writer" as never)).not.toThrow();
  });

  it("resolveEndpoint 返回 undefined 时不走 registry 路径", () => {
    // registry 有内容但调用点 env 指向不存在的 alias（且无该调用点的显式 binding）
    mkdirSync(join(tmpRoot, "config"), { recursive: true });
    writeFileSync(
      join(tmpRoot, "config", "model_registry.json"),
      JSON.stringify([
        {
          alias: "openai-official",
          provider: "openai",
          modelId: "gpt-4o",
          apiKeyEnv: "OPENAI_API_KEY",
          capabilities: ["chat"],
          enabled: true,
        },
      ]),
    );
    // 不写 bindings；planner 经 env 解析到不存在的 alias
    process.env.LIF_PLANNER_MODEL = "nonexistent-alias";
    const cfg = loadConfig(tmpRoot);
    const svc = new LlmService({ runtimeConfig: cfg });
    expect(cfg.resolveEndpoint("planner")).toBeUndefined();
    // resolveEndpoint 返回 undefined → 走 legacyModel（不抛错）
    expect(() => svc.model("planner")).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Azure schema 扩展
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.5 Azure schema 扩展", () => {
  it("azureResourceName / azureApiVersion 字段可解析", () => {
    writeMultiProviderConfig();
    const cfg = loadConfig(tmpRoot);
    const azure = cfg.resolveEndpoint("terminology");
    expect(azure?.provider).toBe("azure");
    expect(azure?.azureResourceName).toBe("my-azure-resource");
    expect(azure?.azureApiVersion).toBe("2024-10-21");
  });

  it("旧 JSON（无 azure 字段）仍可加载（向后兼容）", () => {
    mkdirSync(join(tmpRoot, "config"), { recursive: true });
    writeFileSync(
      join(tmpRoot, "config", "model_registry.json"),
      JSON.stringify([
        {
          alias: "legacy-openai",
          provider: "openai",
          modelId: "gpt-4o",
          apiKeyEnv: "OPENAI_API_KEY",
          capabilities: ["chat"],
          enabled: true,
        },
      ]),
    );
    const cfg = loadConfig(tmpRoot);
    const ep = cfg.registry.get("legacy-openai");
    expect(ep).toBeDefined();
    // azureApiVersion 有默认值
    expect(ep?.azureApiVersion).toBe("2024-10-21");
  });

  it("旧 JSON（含已废弃的 displayName 字段）仍可加载（Zod 忽略未知 key）", () => {
    mkdirSync(join(tmpRoot, "config"), { recursive: true });
    writeFileSync(
      join(tmpRoot, "config", "model_registry.json"),
      JSON.stringify([
        {
          alias: "legacy-with-displayname",
          provider: "openai",
          modelId: "gpt-4o",
          apiKeyEnv: "OPENAI_API_KEY",
          capabilities: ["chat"],
          enabled: true,
          // 旧版本曾有的字段，删除后应被 Zod 静默忽略
          displayName: "GPT-4o 友好名",
        },
      ]),
    );
    const cfg = loadConfig(tmpRoot);
    const ep = cfg.registry.get("legacy-with-displayname");
    expect(ep).toBeDefined();
    expect(ep?.alias).toBe("legacy-with-displayname");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// call-tracer provider/pricing 从 endpoint 读（经 LlmService.resolveEndpoint）
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.5 call-tracer provider/pricing 打通", () => {
  it("resolveEndpoint 暴露给业务调用方读 provider/pricing", () => {
    mkdirSync(join(tmpRoot, "config"), { recursive: true });
    writeFileSync(
      join(tmpRoot, "config", "model_registry.json"),
      JSON.stringify([
        {
          alias: "priced-model",
          provider: "anthropic",
          modelId: "claude-3-5-sonnet",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          capabilities: ["chat"],
          pricing: { inputPer1K: 0.003, outputPer1K: 0.015 },
          enabled: true,
        },
      ]),
    );
    writeFileSync(
      join(tmpRoot, "config", "call_site_bindings.json"),
      JSON.stringify([
        { callSite: "rewrite", modelAlias: "priced-model", params: {}, robustGuard: false },
      ]),
    );
    const cfg = loadConfig(tmpRoot);
    const svc = new LlmService({ runtimeConfig: cfg });

    // 业务调用方经 LlmService.resolveEndpoint 读 provider/pricing
    const ep = svc.resolveEndpoint("rewrite");
    expect(ep).toBeDefined();
    expect(ep?.provider).toBe("anthropic");
    expect(ep?.pricing).toEqual({ inputPer1K: 0.003, outputPer1K: 0.015 });
    // 这些字段会传入 tracedGenerateText 的 TraceContext，打通成本统计
  });

  it("registry 为空时 resolveEndpoint 返回 undefined（业务回退 provider=ts-direct）", () => {
    const cfg = loadConfig(tmpRoot);
    const svc = new LlmService({ runtimeConfig: cfg });
    expect(svc.resolveEndpoint("rewrite")).toBeUndefined();
  });
});
