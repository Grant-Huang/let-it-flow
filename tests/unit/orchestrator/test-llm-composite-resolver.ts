/**
 * LlmToolResolver + CompositeToolResolver 单测（Phase 0.12）。
 *
 * 验证：
 *   - LLM 解析（source="llm"，confidence=0.7）
 *   - LLM 返回 null 时降级
 *   - LLM 返回非法 JSON 时容错
 *   - CompositeToolResolver 三档优先级
 *   - CompositeToolResolver 缓存
 */
import { describe, it, expect } from "vitest";
import { ToolRegistry } from "../../../src/tools/registry.js";
import { LlmToolResolver, type LlmClient } from "../../../src/orchestrator/llm-resolver.js";
import { CompositeToolResolver } from "../../../src/orchestrator/composite-resolver.js";
import { IndexToolResolver } from "../../../src/orchestrator/index-resolver.js";
import type { ToolResolver, ResolvedTool } from "../../../src/orchestrator/tool-resolver.js";
import type { SemanticNeed, BizContext } from "../../../src/orchestrator/types.js";

const ctx: BizContext = { scenarioId: "anomaly", line: "L01" };

/** Stub LLM：返回预设响应。 */
class StubLlm implements LlmClient {
  constructor(private response: string) {}
  async complete(_prompt: string): Promise<string> {
    return this.response;
  }
}

/** Stub resolver：返回预设结果（用于 CompositeToolResolver 测试）。 */
class StubResolver implements ToolResolver {
  constructor(private result: ResolvedTool | null) {}
  async resolve(_need: SemanticNeed, _ctx: BizContext): Promise<ResolvedTool | null> {
    return this.result;
  }
  async resolveBatch(needs: SemanticNeed[], _ctx: BizContext): Promise<ResolvedTool[]> {
    return this.result ? needs.map(() => this.result!) : [];
  }
}

/** 构造一个含假工具的 registry。 */
function makeRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register({
    name: "quality.cp_cpk",
    tier: "domain",
    description: "查过程能力指数 Cp/Cpk",
    inputSchema: { type: "object" },
    whenToUse: { triggers: ["Cpk", "过程能力"], notFor: [] },
    outputSchema: { type: "object" },
    outputExample: {},
    async *execute() {
      return { output: {} };
    },
  });
  return reg;
}

describe("LlmToolResolver", () => {
  it("LLM 返回工具名 → source=llm, confidence=0.7", async () => {
    const reg = makeRegistry();
    const llm = new StubLlm(JSON.stringify({ toolName: "quality.cp_cpk", reason: "匹配过程能力" }));
    const resolver = new LlmToolResolver(reg, llm);
    const need: SemanticNeed = { semantic: "process_capability", required: true };
    const result = await resolver.resolve(need, ctx);
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("quality.cp_cpk");
    expect(result!.source).toBe("llm");
    expect(result!.confidence).toBe(0.7);
  });

  it("LLM 返回 null → resolve 返回 null", async () => {
    const reg = makeRegistry();
    const llm = new StubLlm(JSON.stringify({ toolName: null }));
    const resolver = new LlmToolResolver(reg, llm);
    const need: SemanticNeed = { semantic: "nonexistent", required: false };
    const result = await resolver.resolve(need, ctx);
    expect(result).toBeNull();
  });

  it("LLM 返回非 JSON 文本 → 容错返回 null", async () => {
    const reg = makeRegistry();
    const llm = new StubLlm("这不是 JSON，是自然语言回答");
    const resolver = new LlmToolResolver(reg, llm);
    const need: SemanticNeed = { semantic: "process_capability", required: true };
    const result = await resolver.resolve(need, ctx);
    expect(result).toBeNull();
  });

  it("LLM 返回带前后噪声的 JSON → 提取成功", async () => {
    const reg = makeRegistry();
    const llm = new StubLlm(`好的，分析结果如下：\n${JSON.stringify({ toolName: "quality.cp_cpk" })}\n以上是建议。`);
    const resolver = new LlmToolResolver(reg, llm);
    const need: SemanticNeed = { semantic: "process_capability", required: true };
    const result = await resolver.resolve(need, ctx);
    expect(result).not.toBeNull();
    expect(result!.toolName).toBe("quality.cp_cpk");
  });
});

describe("CompositeToolResolver", () => {
  it("索引命中优先于 LLM", async () => {
    const indexResult: ResolvedTool = { toolName: "quality.cp_cpk", params: {}, source: "index", confidence: 1.0 };
    const llmResult: ResolvedTool = { toolName: "quality.cp_cpk", params: {}, source: "llm", confidence: 0.7 };
    const composite = new CompositeToolResolver([
      new StubResolver(indexResult),
      new StubResolver(llmResult),
    ]);
    const need: SemanticNeed = { semantic: "process_capability", required: true };
    const result = await composite.resolve(need, ctx);
    expect(result!.source).toBe("index");
  });

  it("索引未命中 → LLM 兜底", async () => {
    const llmResult: ResolvedTool = { toolName: "quality.cp_cpk", params: {}, source: "llm", confidence: 0.7 };
    const composite = new CompositeToolResolver([
      new StubResolver(null), // 索引未命中
      new StubResolver(llmResult),
    ]);
    const need: SemanticNeed = { semantic: "process_capability", required: true };
    const result = await composite.resolve(need, ctx);
    expect(result!.source).toBe("llm");
  });

  it("全部未命中 → 返回 null", async () => {
    const composite = new CompositeToolResolver([
      new StubResolver(null),
      new StubResolver(null),
    ]);
    const need: SemanticNeed = { semantic: "nonexistent", required: false };
    const result = await composite.resolve(need, ctx);
    expect(result).toBeNull();
  });

  it("同 semantic 第二次查询走缓存", async () => {
    let callCount = 0;
    const trackingResolver: ToolResolver = {
      async resolve(_need, _ctx) {
        callCount++;
        return { toolName: "quality.cp_cpk", params: {}, source: "index", confidence: 1.0 };
      },
      async resolveBatch() {
        return [];
      },
    };
    const composite = new CompositeToolResolver([trackingResolver]);
    const need: SemanticNeed = { semantic: "process_capability", required: true };
    await composite.resolve(need, ctx);
    await composite.resolve(need, ctx);
    expect(callCount).toBe(1); // 第二次走缓存
  });

  it("clearCache 后重新查询", async () => {
    let callCount = 0;
    const trackingResolver: ToolResolver = {
      async resolve(_need, _ctx) {
        callCount++;
        return { toolName: "quality.cp_cpk", params: {}, source: "index", confidence: 1.0 };
      },
      async resolveBatch() {
        return [];
      },
    };
    const composite = new CompositeToolResolver([trackingResolver]);
    const need: SemanticNeed = { semantic: "process_capability", required: true };
    await composite.resolve(need, ctx);
    composite.clearCache();
    await composite.resolve(need, ctx);
    expect(callCount).toBe(2);
  });

  it("reload() 联动子 resolver + 清会话缓存", async () => {
    // ReloadableResolver stub：记录 reload 调用次数
    let reloadCount = 0;
    let currentTool = "quality.cp_cpk.v1";
    const reloadable: ToolResolver & { reload(): void } = {
      async resolve(_need, _ctx) {
        return { toolName: currentTool, params: {}, source: "index", confidence: 1.0 };
      },
      async resolveBatch() {
        return [];
      },
      reload() {
        reloadCount++;
        currentTool = "quality.cp_cpk.v2"; // reload 后切到新工具
      },
    };
    // 普通 stub（无 reload 方法）
    const plain: ToolResolver = {
      async resolve(_need, _ctx) {
        return null;
      },
      async resolveBatch() {
        return [];
      },
    };
    const composite = new CompositeToolResolver([reloadable, plain]);
    const need: SemanticNeed = { semantic: "process_capability", required: true };

    // 第一次查询：命中 v1，缓存
    const r1 = await composite.resolve(need, ctx);
    expect(r1!.toolName).toBe("quality.cp_cpk.v1");

    // reload：应触发 reloadable.reload() + 清缓存
    composite.reload();
    expect(reloadCount).toBe(1);

    // 第二次查询：缓存已清 + reload 后切到 v2
    const r2 = await composite.resolve(need, ctx);
    expect(r2!.toolName).toBe("quality.cp_cpk.v2");
  });
});
