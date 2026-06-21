/**
 * P1 工具层 schema 单测：
 *   1. web_fetch schema 设计缺陷修复（urls 与 fromInputRefs 二选一）
 *   2. tool-adapter withObjectType 把 zod .shape 转成合法 JSON Schema
 *
 * 这两类 bug 是用户报"做一期 AI 技术趋势播客"在 web_fetch 处
 * invalid_type/expected array/received undefined 的根因。
 */
import { describe, it, expect } from "vitest";
import { createWebFetchTool } from "../../../src/tools/builtin/web-fetch.js";
import { createWebSearchTool } from "../../../src/tools/builtin/web-search.js";
import { createDeliverTool } from "../../../src/tools/builtin/deliver.js";
import { createLlmNodeTool } from "../../../src/tools/builtin/llm-node.js";
import { adaptTool } from "../../../src/agent/tool-adapter.js";
import type { FlowConnector, ToolResult } from "../../../src/tools/base.js";
import type { ToolEvent } from "../../../src/core/stream-events.js";
import { z } from "zod";

const mockCtx = {
  taskId: "t",
  runId: "r",
  nodeId: "n",
  intent: "",
  emit: async () => ({}) as never,
  requireConfirmation: async () => ({ approved: true }),
  resolveRef: () => undefined,
} as unknown as Parameters<FlowConnector["execute"]>[1];

/** 消费 async generator，取最终 ToolResult。 */
async function runTool(
  tool: FlowConnector,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const gen = tool.execute(args, mockCtx);
  let final: ToolResult | undefined;
  while (true) {
    const r = await gen.next();
    if (r.done) {
      final = r.value;
      break;
    }
  }
  return final!;
}

/** 收集 async generator 产出的全部 ToolEvent（断言事件流用）。 */
async function collectEvents(
  tool: FlowConnector,
  args: Record<string, unknown>,
): Promise<{ events: ToolEvent[]; final: ToolResult | undefined }> {
  const gen = tool.execute(args, mockCtx);
  const events: ToolEvent[] = [];
  let final: ToolResult | undefined;
  while (true) {
    const r = await gen.next();
    if (r.done) {
      final = r.value;
      break;
    }
    events.push(r.value);
  }
  return { events, final };
}

// ─────────────────────────────────────────────────────────────────────────────
// web_fetch schema 修复：urls 与 fromInputRefs 二选一
// ─────────────────────────────────────────────────────────────────────────────

describe("P1 web_fetch schema 二选一修复", () => {
  const tool = createWebFetchTool();

  it("schema 不应把 urls 标为 required（允许只传 fromInputRefs）", () => {
    // inputSchema.shape 经过 zod 后，required 数组不应包含 urls
    const shape = tool.inputSchema as unknown as { required?: string[] };
    const required = shape.required ?? [];
    expect(required).not.toContain("urls");
  });

  it("只传 urls（无 fromInputRefs）应成功", async () => {
    // 用一个必然失败的 URL，但不应是 schema 错（应是 fetch 网络错写进 doc.error）
    const result = await runTool(tool, {
      urls: ["https://nonexistent.invalid.example/article"],
    });
    const docs = result.output as Array<{ url: string; error?: string }>;
    expect(Array.isArray(docs)).toBe(true);
    expect(docs.length).toBe(1);
    // 网络失败应写进 error 字段，而非抛 schema 错
    expect(docs[0]!.error).toBeTruthy();
  });

  it("只传 fromInputRefs（无 urls）应成功 —— 修复前的报错路径", async () => {
    // 这是用户报错的精确复现路径：topic 模式只注入 fromInputRefs
    const result = await runTool(tool, {
      fromInputRefs: [{ url: "https://nonexistent.invalid.example/article", title: "测试" }],
    });
    const docs = result.output as Array<{ url: string; error?: string }>;
    expect(Array.isArray(docs)).toBe(true);
    expect(docs.length).toBe(1);
    // 网络失败写进 error，但不应抛 ZodError
    expect(docs[0]!.error).toBeTruthy();
  });

  it("二者全缺应抛明确错误（urls 或 fromInputRefs 至少需其一）", async () => {
    await expect(runTool(tool, {})).rejects.toThrow(
      /urls|fromInputRefs/i,
    );
  });

  it("fromInputRefs 优先于 urls", async () => {
    const result = await runTool(tool, {
      urls: ["https://a.invalid/x"],
      fromInputRefs: [{ url: "https://b.invalid/y", title: "优先项" }],
    });
    const docs = result.output as Array<{ url: string }>;
    expect(docs.length).toBe(1);
    expect(docs[0]!.url).toBe("https://b.invalid/y");
  });

  it("tool_result 事件不应包含 schema 校验错误", async () => {
    const { events } = await collectEvents(tool, {
      fromInputRefs: [{ url: "https://nonexistent.invalid.example/x" }],
    });
    const resultEvent = events.find((e) => e.type === "tool_result");
    const payload = resultEvent?.payload as { output?: string };
    expect(payload?.output).toBeDefined();
    // output 里不应出现 zod schema 错的特征
    expect(payload!.output).not.toMatch(/invalid_type|expected.*array.*received.*undefined/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// tool-adapter zod .shape → 合法 JSON Schema
// ─────────────────────────────────────────────────────────────────────────────

/** 断言一个值是合法的 JSON Schema object 定义。 */
function assertValidJsonSchema(schema: unknown): void {
  expect(schema).toBeDefined();
  expect(typeof schema).toBe("object");
  const s = schema as Record<string, unknown>;
  // function calling 要求顶层 type:object
  expect(s.type).toBe("object");
  // 必须有 properties（即使是空对象）
  expect(s.properties).toBeDefined();
  expect(typeof s.properties).toBe("object");
  // 不应残留 zod 内部标记（_def / typeName）
  const json = JSON.stringify(s);
  expect(json).not.toContain("_def");
  expect(json).not.toContain("typeName");
  expect(json).not.toContain("Zod");
}

describe("P1 tool-adapter zod .shape → JSON Schema 转换", () => {
  const ctxMeta = { taskId: "t", runId: "r", nodeId: "n" };
  const deps = {}; // 最小 deps，inputSchema 适配不依赖运行时

  /** 取 adaptTool 后的工具定义的 inputSchema。
   * AI SDK tool() 产物结构：{ description, inputSchema: { jsonSchema: {...} }, execute }
   * jsonSchema() 把 schema 包成 { jsonSchema: <实际 schema> } 形态。
   */
  function getAdaptedSchema(connector: FlowConnector): Record<string, unknown> {
    const adapted = adaptTool(connector, deps, ctxMeta);
    const a = adapted as unknown as {
      inputSchema?: { jsonSchema?: Record<string, unknown> } | Record<string, unknown>;
    };
    const raw = a.inputSchema ?? {};
    // 解包 jsonSchema() 的 { jsonSchema: {...} } 包装
    if ("jsonSchema" in raw && raw.jsonSchema) {
      return raw.jsonSchema as Record<string, unknown>;
    }
    return raw as Record<string, unknown>;
  }

  it("web_fetch（z.array.min + .optional + .default）转成合法 JSON Schema", () => {
    const schema = getAdaptedSchema(createWebFetchTool());
    assertValidJsonSchema(schema);
    const props = (schema as { properties: Record<string, unknown> }).properties;
    expect(props.urls).toBeDefined();
    expect(props.fromInputRefs).toBeDefined();
  });

  it("web_search（z.string.min + .default + .enum.optional）转成合法 JSON Schema", () => {
    const schema = getAdaptedSchema(createWebSearchTool());
    assertValidJsonSchema(schema);
    const props = (schema as { properties: Record<string, unknown> }).properties;
    expect(props.query).toBeDefined();
    expect(props.maxResults).toBeDefined();
    // enum 应转成 { type:"string", enum:[...] }，不残留 zod
    const provider = props.provider as Record<string, unknown>;
    expect(provider.type).toBe("string");
  });

  it("deliver（z.union + .default）转成合法 JSON Schema", () => {
    const schema = getAdaptedSchema(createDeliverTool());
    assertValidJsonSchema(schema);
    const props = (schema as { properties: Record<string, unknown> }).properties;
    expect(props.items).toBeDefined();
    expect(props.separator).toBeDefined();
  });

  it("llm_node（多字段混合 zod）转成合法 JSON Schema", () => {
    const llm = createLlmNodeTool({ llm: { model: () => ({}) } as never });
    const schema = getAdaptedSchema(llm);
    assertValidJsonSchema(schema);
    const props = (schema as { properties: Record<string, unknown> }).properties;
    expect(props.prompt).toBeDefined();
    expect(props.systemPrompt).toBeDefined();
    // style enum
    const style = props.style as Record<string, unknown>;
    expect(style.type).toBe("string");
    expect(Array.isArray(style.enum)).toBe(true);
  });

  it("已转换的 schema 无 zod 内部标记泄漏", () => {
    for (const connector of [
      createWebFetchTool(),
      createWebSearchTool(),
      createDeliverTool(),
    ]) {
      const schema = getAdaptedSchema(connector);
      const json = JSON.stringify(schema);
      expect(json, `${connector.name} schema 残留 zod 内部结构`).not.toMatch(/_def|typeName|Zod\w+/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 防回归：z.object .shape 的 withObjectType 行为
// ─────────────────────────────────────────────────────────────────────────────

describe("P1 withObjectType 防回归", () => {
  it("空对象兜底成合法 schema", () => {
    // 直接构造一个 shape 形态，验证 adaptTool 不炸
    const connector: FlowConnector = {
      name: "test.empty",
      tier: "core",
      description: "空 schema 测试",
      inputSchema: {},
      outputSchema: { type: "object", properties: {} },
      outputExample: {},
      whenToUse: { triggers: [], notFor: [] },
      async *execute() {
        return { output: {} };
      },
    };
    const ctxMeta = { taskId: "t", runId: "r", nodeId: "n" };
    expect(() => adaptTool(connector, {}, ctxMeta)).not.toThrow();
  });

  it("纯 zod .shape（无顶层 type）被正确识别和转换", () => {
    const shape = z.object({
      a: z.string(),
      b: z.number().optional(),
    }).shape;
    const connector: FlowConnector = {
      name: "test.zodshape",
      tier: "core",
      description: "zod shape 测试",
      inputSchema: shape,
      outputSchema: { type: "object", properties: {} },
      outputExample: {},
      whenToUse: { triggers: [], notFor: [] },
      async *execute() {
        return { output: {} };
      },
    };
    const adapted = adaptTool(connector, {}, { taskId: "t", runId: "r", nodeId: "n" });
    const a = adapted as unknown as {
      inputSchema?: { jsonSchema?: Record<string, unknown> } | Record<string, unknown>;
    };
    expect(a).toBeDefined();
    // 关键：能被 JSON 序列化（说明不是 zod 内部对象）
    const raw = a.inputSchema ?? {};
    const schema = "jsonSchema" in raw && raw.jsonSchema ? raw.jsonSchema : raw;
    expect(() => JSON.stringify(schema)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(schema));
    expect(parsed.type).toBe("object");
  });
});
