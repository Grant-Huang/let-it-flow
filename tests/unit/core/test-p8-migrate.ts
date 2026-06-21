/**
 * P8.3 TS 直连迁移测试。
 *
 * 验证 5 个 LLM 工具支持 backend="ts" 走 TS 直连 LLM，
 * 同时保留 backend="python"（默认）向后兼容。
 *
 * 本测试聚焦工具契约与切换逻辑；实际 LLM 调用用 mock LlmService。
 * prompt 逐字移植验证见 prompts/ 目录文件存在性检查。
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createImagePromptsTool, createTranslateTool, createSeamRepairTool, createTerminologyTool } from "../../../src/tools/builtin/text-steps.js";
import type { ToolResult } from "../../../src/tools/base.js";
import type { ToolEvent } from "../../../src/core/stream-events.js";
import type { ImagePromptsRuntime } from "../../../src/tools/heavy-io/runtime-interfaces.js";
import type { LlmService } from "../../../src/services/llm-service.js";

let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "lif-p83-"));
  process.env.LIF_DATA_DIR = tmpRoot;
});

/** mock ImagePromptsRuntime（记录调用，模拟文件中转）。 */
function mockRuntime(): ImagePromptsRuntime & {
  writtenScripts: Map<string, string>;
  runStepCalls: string[];
} {
  const writtenScripts = new Map<string, string>();
  const runStepCalls: string[] = [];
  return {
    workDirOf: (taskId: string) => join(tmpRoot, taskId),
    ensureWorkDir: async () => {},
    writeScript: async (_wd: string, name: string, content: string) => {
      writtenScripts.set(name, content);
    },
    readScript: async (_wd: string, name: string) => writtenScripts.get(name) ?? null,
    runStep: async (step: string) => {
      runStepCalls.push(step);
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    },
    writtenScripts,
    runStepCalls,
  } as never;
}

/** mock LlmService（返回可控 model）。 */
function mockLlmService(): LlmService {
  return {
    model: () => ({ modelId: "mock-model" }) as never,
    compatMode: false,
    // P8.5：mock registry 为空，新方法回退（与旧 compatMode:false 行为一致）
    compatModeFor: () => false,
    resolveEndpoint: () => undefined,
  } as never;
}

/** 消费 async generator 取最终 ToolResult。 */
async function consumeResult(gen: AsyncGenerator<ToolEvent, ToolResult<{ plan: string }>>): Promise<ToolResult<{ plan: string }>> {
  let result: ToolResult<{ plan: string }> | undefined;
  while (true) {
    const r = await gen.next();
    if (r.done) {
      result = r.value;
      break;
    }
  }
  return result!;
}

// mock ai 模块的 generateText（P8.3 TS 直连路径用）
let generateTextCalls = 0;
vi.mock("ai", () => ({
  generateText: vi.fn(async () => {
    generateTextCalls++;
    return {
      text: JSON.stringify({
        theme: "AI chips",
        image_prompt: "cinematic chips",
        ken_burns: "zoom_in",
      }),
      usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    };
  }),
}));

describe("P8.3 image_prompts TS 直连", () => {
  beforeEach(() => {
    generateTextCalls = 0;
  });

  it("backend='python'（默认）：走 runtime.runStep（向后兼容）", async () => {
    const runtime = mockRuntime();
    const tool = createImagePromptsTool(runtime); // 不传 llm，默认 python
    const events: ToolEvent[] = [];
    const gen = tool.execute!(
      { scriptText: "测试文本" },
      { taskId: "task-1", nodeId: "n1", emit: async (e: ToolEvent) => events.push(e) } as never,
    );
    await consumeResult(gen);
    expect(runtime.runStepCalls).toEqual(["3d"]);
    expect(generateTextCalls).toBe(0); // python 路径不调 LLM
  });

  it("backend='ts'：走 LLM 直连，不调 runtime.runStep", async () => {
    const runtime = mockRuntime();
    const mockLlm = mockLlmService();
    const tool = createImagePromptsTool(runtime, {
      llm: mockLlm,
      backend: "ts",
    });
    const gen = tool.execute!(
      { scriptText: "第一段\n\n第二段" },
      { taskId: "task-1", nodeId: "n1", emit: async () => {} } as never,
    );
    const result = await consumeResult(gen);
    // 不应调 runStep
    expect(runtime.runStepCalls).toEqual([]);
    // 应调 LLM（2 段 → 2 次调用）
    expect(generateTextCalls).toBe(2);
    // 输出应为拼接的 JSON plan
    const plan = JSON.parse(result.output.plan);
    expect(Array.isArray(plan)).toBe(true);
    expect(plan.length).toBe(2);
    expect(plan[0]).toHaveProperty("image_prompt");
    expect(plan[0]).toHaveProperty("ken_burns");
  });

  it("TS 路径产出含 cover.png 封面 + para_NN 段落路径", async () => {
    const runtime = mockRuntime();
    const mockLlm = mockLlmService();
    const tool = createImagePromptsTool(runtime, { llm: mockLlm, backend: "ts" });
    const gen = tool.execute!(
      { scriptText: "段落A\n\n段落B\n\n段落C" },
      { taskId: "t1", nodeId: "n1", emit: async () => {} } as never,
    );
    const result = await consumeResult(gen);
    const plan = JSON.parse(result.output.plan);
    expect(plan[0].image_path).toBe("images/cover.png");
    expect(plan[1].image_path).toBe("images/para_01.png");
    expect(plan[2].image_path).toBe("images/para_02.png");
  });

  it("TS 路径产出的 plan 落盘到 scenes/image_prompts.json", async () => {
    const runtime = mockRuntime();
    const mockLlm = mockLlmService();
    const tool = createImagePromptsTool(runtime, { llm: mockLlm, backend: "ts" });
    const gen = tool.execute!(
      { scriptText: "段落A" },
      { taskId: "t1", nodeId: "n1", emit: async () => {} } as never,
    );
    await consumeResult(gen);
    const written = runtime.writtenScripts.get("image_prompts.json");
    expect(written).toBeTruthy();
    const plan = JSON.parse(written!);
    expect(Array.isArray(plan)).toBe(true);
  });
});

describe("P8.3 prompt 逐字移植验证", () => {
  const promptsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src", "tools", "heavy-io", "prompts");

  it("image-prompts.md 存在且含关键约束", () => {
    const path = join(promptsDir, "image-prompts.md");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    // 验证关键约束（逐字移植自 pipeline_steps.py IMAGE_PROMPT_SYS）
    expect(content).toContain("Cinematic editorial illustration");
    expect(content).toContain("no human faces");
    expect(content).toContain("ken_burns");
    expect(content).toContain("zoom_out");
    expect(content).toContain("no text, no watermark");
  });

  it("translate 两个版本 prompt 存在且含关键约束", () => {
    const withPath = join(promptsDir, "translate-with-speaker.md");
    const noPath = join(promptsDir, "translate-no-speaker.md");
    expect(existsSync(withPath)).toBe(true);
    expect(existsSync(noPath)).toBe(true);
    const withContent = readFileSync(withPath, "utf8");
    const noContent = readFileSync(noPath, "utf8");
    // 逐字移植自 pipeline_steps.py TRANSLATE_SYS_*
    expect(withContent).toContain("【姓名】：");
    expect(withContent).toContain("黄仁勋");
    expect(withContent).toContain("Agent");
    expect(noContent).toContain("节目中提到");
    expect(noContent).toContain("大模型");
  });

  it("seam_repair 三个 prompt 存在且含关键约束", () => {
    const seamPath = join(promptsDir, "seam-repair.md");
    const introPath = join(promptsDir, "seam-intro.md");
    const outroPath = join(promptsDir, "seam-outro.md");
    expect(existsSync(seamPath)).toBe(true);
    expect(existsSync(introPath)).toBe(true);
    expect(existsSync(outroPath)).toBe(true);
    const seam = readFileSync(seamPath, "utf8");
    const intro = readFileSync(introPath, "utf8");
    const outro = readFileSync(outroPath, "utf8");
    // 逐字移植自 seam_repair.py
    expect(seam).toContain("[OK]");
    expect(seam).toContain("120 字");
    expect(intro).toContain("节目元信息");
    expect(intro).toContain("接下来我们就来看看");
    expect(outro).toContain("告一段落");
    expect(outro).toContain("严禁");
  });

  it("terminology prompt 存在且含关键约束", () => {
    const path = join(promptsDir, "terminology.md");
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, "utf8");
    // 逐字移植自 terminology_pass.py TERM_SYSTEM
    expect(content).toContain("统一为出现频率最高的那个");
    expect(content).toContain("大模型");
    expect(content).toContain("只改术语，不改句式");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// translate TS 直连
// ─────────────────────────────────────────────────────────────────────────────

/** mock TextStepRuntime（含 readWorkFile/writeWorkFile/listScripts，支持 transcript_meta）。 */
function mockTextRuntime(): ImagePromptsRuntime & {
  writtenScripts: Map<string, string>;
  writtenWorkFiles: Map<string, string>;
  runStepCalls: string[];
} {
  const writtenScripts = new Map<string, string>();
  const writtenWorkFiles = new Map<string, string>();
  const runStepCalls: string[] = [];
  return {
    workDirOf: (taskId: string) => join(tmpRoot, taskId),
    ensureWorkDir: async () => {},
    writeScript: async (_wd: string, name: string, content: string) => {
      writtenScripts.set(name, content);
      return name;
    },
    readScript: async (_wd: string, name: string) => writtenScripts.get(name) ?? null,
    writeWorkFile: async (_wd: string, name: string, content: string) => {
      writtenWorkFiles.set(name, content);
      return name;
    },
    readWorkFile: async (_wd: string, name: string) => writtenWorkFiles.get(name) ?? null,
    listScripts: async (_wd: string, _glob: string) => [],
    runStep: async (step: string) => {
      runStepCalls.push(step);
      return { ok: true, exitCode: 0, stdout: "", stderr: "" };
    },
    writtenScripts,
    writtenWorkFiles,
    runStepCalls,
  } as never;
}

/** 消费 async generator 取最终 ToolResult（text 版本）。 */
async function consumeTextResult(gen: AsyncGenerator<ToolEvent, ToolResult<{ text: string }>>): Promise<ToolResult<{ text: string }>> {
  let result: ToolResult<{ text: string }> | undefined;
  while (true) {
    const r = await gen.next();
    if (r.done) { result = r.value; break; }
  }
  return result!;
}

describe("P8.3 translate TS 直连", () => {
  beforeEach(() => { generateTextCalls = 0; });

  it("backend='python'（默认）：走 runtime.runStep（向后兼容）", async () => {
    const runtime = mockTextRuntime();
    const tool = createTranslateTool(runtime);
    const gen = tool.execute!(
      { sourceText: "Hello world" },
      { taskId: "t1", nodeId: "n1", emit: async () => {} } as never,
    );
    await consumeTextResult(gen);
    expect(runtime.runStepCalls).toEqual(["2"]);
    expect(generateTextCalls).toBe(0);
  });

  it("backend='ts'：走 LLM 直连，不调 runtime.runStep", async () => {
    const runtime = mockTextRuntime();
    const mockLlm = mockLlmService();
    const tool = createTranslateTool(runtime, { llm: mockLlm, backend: "ts" });
    const gen = tool.execute!(
      { sourceText: "First paragraph.\n\nSecond paragraph." },
      { taskId: "t1", nodeId: "n1", emit: async () => {} } as never,
    );
    const result = await consumeTextResult(gen);
    expect(runtime.runStepCalls).toEqual([]);
    expect(generateTextCalls).toBe(2); // 2 段
    expect(result.output.text.length).toBeGreaterThan(0);
  });

  it("TS 路径产出落盘 translated.txt", async () => {
    const runtime = mockTextRuntime();
    const mockLlm = mockLlmService();
    const tool = createTranslateTool(runtime, { llm: mockLlm, backend: "ts" });
    const gen = tool.execute!(
      { sourceText: "Hello" },
      { taskId: "t1", nodeId: "n1", emit: async () => {} } as never,
    );
    await consumeTextResult(gen);
    expect(runtime.writtenScripts.get("translated.txt")).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// seam_repair TS 直连
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.3 seam_repair TS 直连", () => {
  beforeEach(() => { generateTextCalls = 0; });

  it("backend='python'（默认）：走 runtime.runStep", async () => {
    const runtime = mockTextRuntime();
    const tool = createSeamRepairTool(runtime);
    const gen = tool.execute!(
      { rewriteText: "段落A\n\n段落B" },
      { taskId: "t1", nodeId: "n1", emit: async () => {} } as never,
    );
    await consumeTextResult(gen);
    expect(runtime.runStepCalls).toEqual(["3b"]);
    expect(generateTextCalls).toBe(0);
  });

  it("backend='ts'：走 LLM 直连（引言 + 接缝 + 小结）", async () => {
    const runtime = mockTextRuntime();
    const mockLlm = mockLlmService();
    const tool = createSeamRepairTool(runtime, { llm: mockLlm, backend: "ts" });
    const gen = tool.execute!(
      { rewriteText: "段落一。\n\n段落二。\n\n段落三。" },
      { taskId: "t1", nodeId: "n1", emit: async () => {} } as never,
    );
    const result = await consumeTextResult(gen);
    expect(runtime.runStepCalls).toEqual([]);
    // 3 段 → 1 引言 + 2 接缝 + 1 小结 = 4 次 LLM 调用
    expect(generateTextCalls).toBe(4);
    expect(result.output.text.length).toBeGreaterThan(0);
  });

  it("TS 路径产出落盘 script_v2_seamed.txt", async () => {
    const runtime = mockTextRuntime();
    const mockLlm = mockLlmService();
    const tool = createSeamRepairTool(runtime, { llm: mockLlm, backend: "ts" });
    const gen = tool.execute!(
      { rewriteText: "段落A\n\n段落B" },
      { taskId: "t1", nodeId: "n1", emit: async () => {} } as never,
    );
    await consumeTextResult(gen);
    expect(runtime.writtenScripts.get("script_v2_seamed.txt")).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// terminology TS 直连
// ─────────────────────────────────────────────────────────────────────────────

describe("P8.3 terminology TS 直连", () => {
  beforeEach(() => { generateTextCalls = 0; });

  it("backend='python'（默认）：走 runtime.runStep", async () => {
    const runtime = mockTextRuntime();
    const tool = createTerminologyTool(runtime);
    const gen = tool.execute!(
      { seamedText: "测试文本" },
      { taskId: "t1", nodeId: "n1", emit: async () => {} } as never,
    );
    await consumeTextResult(gen);
    expect(runtime.runStepCalls).toEqual(["3c"]);
    expect(generateTextCalls).toBe(0);
  });

  it("backend='ts'：走 LLM 直连", async () => {
    const runtime = mockTextRuntime();
    const mockLlm = mockLlmService();
    const tool = createTerminologyTool(runtime, { llm: mockLlm, backend: "ts" });
    const gen = tool.execute!(
      { seamedText: "这是 LLM 和 AI Agents 的测试。" },
      { taskId: "t1", nodeId: "n1", emit: async () => {} } as never,
    );
    const result = await consumeTextResult(gen);
    expect(runtime.runStepCalls).toEqual([]);
    expect(generateTextCalls).toBe(1);
    // mock 返回固定文本，应含术语替换后的内容
    expect(result.output.text).toContain("theme");
  });

  it("长文保护（≥60000 字）跳过 LLM，走最小替换", async () => {
    const runtime = mockTextRuntime();
    const mockLlm = mockLlmService();
    const tool = createTerminologyTool(runtime, { llm: mockLlm, backend: "ts" });
    const longText = "LLM ".repeat(16000); // 80000 字符
    const gen = tool.execute!(
      { seamedText: longText },
      { taskId: "t1", nodeId: "n1", emit: async () => {} } as never,
    );
    await consumeTextResult(gen);
    expect(generateTextCalls).toBe(0); // 长文跳过 LLM
    const written = runtime.writtenScripts.get("script_v2.txt")!;
    expect(written).toContain("大模型"); // LLM → 大模型
    expect(written).not.toContain("LLM ");
  });
});
