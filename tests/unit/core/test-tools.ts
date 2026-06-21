import { describe, it, expect, vi } from "vitest";

// 顶层 mock：覆盖 ai.streamText（ai 的 ESM 导出不可 redefine，必须用 vi.mock）。
// 工厂里保留其余命名导出，只替换 streamText。
const streamTextMock = vi.fn();
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: (...args: unknown[]) => streamTextMock(...args),
  };
});

const { streamText: _ensureMocked } = await import("ai");
void _ensureMocked;

import { ToolRegistry } from "../../src/tools/registry.js";
import {
  createWebSearchTool,
  createTavilyProvider,
  createNativeProvider,
  type SearchProvider,
  type SearchResult,
} from "../../src/tools/builtin/web-search.js";
import { createWebFetchTool, extractHtml } from "../../src/tools/builtin/web-fetch.js";
import { createLlmNodeTool } from "../../src/tools/builtin/llm-node.js";
import { createDeliverTool } from "../../src/tools/builtin/deliver.js";
import { LlmService } from "../../src/services/llm-service.js";
import type { ExecutionContext, ToolResult } from "../../src/tools/base.js";
import type { StreamEvent, ToolEvent } from "../../src/core/stream-events.js";

/** 构造一个记录事件的 ExecutionContext。 */
function makeCtx(overrides?: Partial<ExecutionContext>): {
  ctx: ExecutionContext;
  events: ToolEvent[];
  outputs: unknown[];
} {
  const events: ToolEvent[] = [];
  let seq = 0;
  const ctx: ExecutionContext = {
    taskId: "t_test",
    runId: "r_test",
    nodeId: "n_test",
    emit: async (event) => {
      const full: StreamEvent = { ...event, seq: ++seq, taskId: "t_test", ts: Date.now() } as StreamEvent;
      return full;
    },
    requireConfirmation: async () => ({ approved: true }),
    resolveRef: (ref: string) => {
      if (ref === "$.upstream") return "UPSTREAM_DATA";
      return undefined;
    },
    ...overrides,
  };
  return { ctx, events, outputs: [] };
}

/** 跑完一个 async generator 工具，收集 yield 的事件 + 最终 ToolResult。 */
async function runTool(
  gen: AsyncGenerator<ToolEvent, ToolResult>,
  events: ToolEvent[],
): Promise<ToolResult> {
  while (true) {
    const r = await gen.next();
    if (r.done) return r.value;
    events.push(r.value);
  }
}

describe("ToolRegistry", () => {
  it("register / get / has / list", () => {
    const reg = new ToolRegistry();
    const t = createDeliverTool();
    reg.register(t);
    expect(reg.has("core.deliver")).toBe(true);
    expect(reg.get("core.deliver")).toBe(t);
    expect(reg.list()).toHaveLength(1);
  });

  it("duplicate register throws", () => {
    const reg = new ToolRegistry();
    reg.register(createDeliverTool());
    expect(() => reg.register(createDeliverTool())).toThrow(/already registered/);
  });

  it("listByTier filters by tier", () => {
    const reg = new ToolRegistry();
    reg.register(createWebFetchTool());
    reg.register(createDeliverTool());
    expect(reg.listByTier("core")).toHaveLength(2);
    expect(reg.listByTier("domain")).toHaveLength(0);
    expect(reg.listByTiers(["core", "domain"])).toHaveLength(2);
  });
});

describe("deliver tool", () => {
  it("aggregates items and emits tool_call + tool_result", async () => {
    const { ctx, events } = makeCtx();
    const tool = createDeliverTool();
    const result = await runTool(tool.execute({ items: ["片段一", "片段二"], artifactType: "podcast_script" }, ctx), events);
    expect(result.output).toMatchObject({ type: "podcast_script", content: "片段一\n\n片段二" });
    const types = events.map((e) => e.type);
    expect(types).toEqual(["tool_call", "tool_result"]);
    expect((events[0]!.payload as { name: string }).name).toBe("core.deliver");
  });
});

describe("web_search tool", () => {
  const fakeResults: SearchResult[] = [
    { title: "AI 进展", url: "https://example.com/ai", snippet: "最新进展…" },
    { title: "大模型", url: "https://example.com/llm", snippet: "GPT 与 Claude" },
  ];

  it("uses injected provider and emits tool_call/tool_result with results", async () => {
    const provider: SearchProvider = {
      name: "fake",
      search: vi.fn(async () => fakeResults),
    };
    const tool = createWebSearchTool({ provider });
    const { ctx, events } = makeCtx();
    const result = await runTool(tool.execute({ query: "AI", maxResults: 2 }, ctx), events);
    expect(provider.search).toHaveBeenCalledWith("AI", { maxResults: 2 });
    expect(result.output).toEqual(fakeResults);
    const callEv = events.find((e) => e.type === "tool_call")!;
    expect((callEv.payload as { name: string }).name).toBe("core.web_search");
    const resEv = events.find((e) => e.type === "tool_result")!;
    expect(JSON.parse((resEv.payload as { output: string }).output)).toHaveLength(2);
  });

  it("throws on provider error (after emitting tool_result with error)", async () => {
    const provider: SearchProvider = {
      name: "fail",
      search: vi.fn(async () => {
        throw new Error("network down");
      }),
    };
    const tool = createWebSearchTool({ provider });
    const { ctx, events } = makeCtx();
    await expect(runTool(tool.execute({ query: "x", maxResults: 1 }, ctx), events)).rejects.toThrow("web_search failed");
    const resEv = events.find((e) => e.type === "tool_result")!;
    expect((resEv.payload as { error?: string }).error).toContain("network down");
  });

  it("createTavilyProvider / createNativeProvider construct without throwing", () => {
    expect(() => createTavilyProvider("key")).not.toThrow();
    expect(() => createNativeProvider()).not.toThrow();
    expect(createNativeProvider().name).toBe("native");
  });
});

describe("web_fetch tool", () => {
  it("extractHtml strips scripts/styles/nav, keeps title + text", () => {
    const html = `
      <html><head><title>我的页面</title><style>.x{color:red}</style></head>
      <body>
        <nav>导航</nav>
        <script>alert(1)</script>
        <main><h1>标题</h1><p>正文段落一</p><p>正文段落二</p></main>
        <footer>版权</footer>
      </body></html>`;
    const { title, content } = extractHtml(html);
    expect(title).toBe("我的页面");
    expect(content).toContain("正文段落一");
    expect(content).toContain("正文段落二");
    expect(content).not.toContain("alert(1)");
    expect(content).not.toContain("color:red");
    expect(content).not.toContain("导航");
    expect(content).not.toContain("版权");
  });

  it("fetches URLs via injected fetch and returns FetchedDoc[]", async () => {
    const html = "<html><head><title>测试页</title></head><body><main><p>hello world</p></main></body></html>";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(html, { headers: { "content-type": "text/html" } }),
    );
    try {
      const tool = createWebFetchTool();
      const { ctx, events } = makeCtx();
      const result = await runTool(tool.execute({ urls: ["https://example.com/x"] }, ctx), events);
      const docs = result.output as Array<{ url: string; title: string; content: string }>;
      expect(docs).toHaveLength(1);
      expect(docs[0]!.title).toBe("测试页");
      expect(docs[0]!.content).toContain("hello world");
    } finally {
      fetchMock.mockRestore();
    }
  });

  it("records per-URL errors without failing the whole call", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 404 }));
    try {
      const tool = createWebFetchTool();
      const { ctx, events } = makeCtx();
      const result = await runTool(tool.execute({ urls: ["https://example.com/missing"] }, ctx), events);
      const docs = result.output as Array<{ error?: string }>;
      expect(docs[0]!.error).toContain("404");
    } finally {
      fetchMock.mockRestore();
    }
  });
});

describe("llm_node tool", () => {
  it("streams text deltas, applies style to system prompt, returns full output", async () => {
    async function* fakeStream(): AsyncGenerator<string> {
      yield "你好";
      yield "，";
      yield "世界";
    }
    const llm = new LlmService({ apiKey: "fake" });
    vi.spyOn(llm, "model").mockReturnValue({ id: "stub" } as never);
    streamTextMock.mockReturnValue({ textStream: fakeStream() });

    const tool = createLlmNodeTool({ llm });
    const { ctx, events } = makeCtx();
    const result = await runTool(
      tool.execute({ prompt: "打招呼", style: "dialogue", context: "素材" }, ctx),
      events,
    );
    expect(result.output).toBe("你好，世界");
    const textEvents = events.filter((e) => e.type === "text");
    expect(textEvents.map((e) => (e.payload as { delta: string }).delta).join("")).toBe("你好，世界");
    // style 被拼入 system prompt（dialogue → "对话"）
    const callArgs = streamTextMock.mock.calls[0]![0] as { messages: Array<{ content: string }> };
    expect(callArgs.messages[0]!.content).toContain("对话");
    // context 被注入到 user message
    expect(callArgs.messages.at(-1)!.content).toContain("素材");
    streamTextMock.mockReset();
  });
});
