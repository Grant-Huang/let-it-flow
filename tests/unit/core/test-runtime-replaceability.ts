import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { MockHeavyIoRuntime } from "../../../src/tools/heavy-io/mock-runtime.js";
import { createTtsTool } from "../../../src/tools/heavy-io/tts.js";
import { createImageGenTool } from "../../../src/tools/heavy-io/image-gen.js";
import { createVideoBuildTool } from "../../../src/tools/heavy-io/video-build.js";
import { createRewriteTool } from "../../../src/tools/heavy-io/rewrite.js";
import {
  createTranslateTool,
  createSubtitleTool,
  createImagePromptsTool,
} from "../../../src/tools/builtin/text-steps.js";
import type { FlowConnector } from "../../../src/tools/base.js";
import type { ToolEvent } from "../../../src/core/stream-events.js";

/**
 * P5 重构验证：重 IO 工具依赖能力接口（TtsRuntime 等）而非具体类。
 * 本测试注入 MockHeavyIoRuntime（不调 Python，回放产物），证明：
 *   - 同一批工具工厂（createTtsTool 等）能接受 mock 实现；
 *   - mock 实现可驱动工具产出合规结果，无需 SubprocessAdapter / GPU / Python。
 * 即"换运行时实现，不换工具"的可替换性成立。
 */

/** 跑一个工具的 execute，收集事件与返回值。 */
async function runTool(
  tool: FlowConnector,
  params: Record<string, unknown>,
): Promise<{ events: ToolEvent[]; result: unknown }> {
  const events: ToolEvent[] = [];
  const ctx = {
    taskId: `t_${randomUUID().slice(0, 8)}`,
    nodeId: `n_${randomUUID().slice(0, 8)}`,
    emit: async (e: ToolEvent) => {
      events.push(e);
    },
  };
  const gen = tool.execute(params, ctx as never);
  let result: unknown;
  while (true) {
    const { value, done } = await gen.next(result as never);
    if (done) {
      result = value;
      break;
    }
    events.push(value);
  }
  return { events, result };
}

describe("P5 重 IO 能力接口可替换性（MockHeavyIoRuntime）", () => {
  it("MockHeavyIoRuntime 能注入全部工具工厂（类型层兼容）", async () => {
    const mock = await MockHeavyIoRuntime.create();
    // 这些工厂都按各自能力接口声明依赖；mock 满足全部接口
    const tts = createTtsTool(mock);
    const imageGen = createImageGenTool(mock);
    const video = createVideoBuildTool(mock);
    const rewrite = createRewriteTool({ runtime: mock, llm: {} as never, backend: "ollama" });
    const translate = createTranslateTool(mock);
    const subtitle = createSubtitleTool(mock);
    const imagePrompts = createImagePromptsTool(mock);

    expect(tts.name).toBe("domain.tts");
    expect(imageGen.name).toBe("domain.image_gen");
    expect(video.name).toBe("domain.video_build");
    expect(rewrite.name).toBe("domain.rewrite");
    expect(translate.name).toBe("domain.translate");
    expect(subtitle.name).toBe("domain.subtitle");
    expect(imagePrompts.name).toBe("domain.image_prompts");
  });

  it("tts 工具用 mock 跑通：产出 audioPath 且 runStep 不调 Python", async () => {
    const mock = await MockHeavyIoRuntime.create();
    const tts = createTtsTool(mock);
    const { events, result } = await runTool(tts, { script: "hello world", engine: "edge" });

    // 应有 tool_call + tool_result 事件
    expect(events.some((e) => e.type === "tool_call")).toBe(true);
    expect(events.some((e) => e.type === "tool_result")).toBe(true);

    const r = result as { output: { audioPath: string; engine: string }; summary: string };
    expect(r.output.engine).toBe("edge");
    // mock 回放的音频文件真实写入
    const buf = await readFile(r.output.audioPath);
    expect(buf.toString()).toBe("mock-audio");
  });

  it("translate 工具用 mock 跑通：回放 translated.txt", async () => {
    const mock = await MockHeavyIoRuntime.create();
    const translate = createTranslateTool(mock);
    const { result } = await runTool(translate, { sourceText: "原文内容" });
    const r = result as { output: { text: string }; summary: string };
    expect(r.output.text).toContain("mock");
  });

  it("image_gen 工具用 mock 跑通：images 目录有占位 png", async () => {
    const mock = await MockHeavyIoRuntime.create();
    const imageGen = createImageGenTool(mock);
    const { result } = await runTool(imageGen, { imagePlan: '[{"image_path":"cover.png"}]' });
    const r = result as { output: { imageDir: string; count: number }; summary: string };
    expect(r.output.count).toBeGreaterThan(0);
  });

  it("subtitle 工具用 mock 跑通：回放 final.srt", async () => {
    const mock = await MockHeavyIoRuntime.create();
    const subtitle = createSubtitleTool(mock);
    const { result } = await runTool(subtitle, { audioPath: "x" });
    const r = result as { output: { srtPath: string }; summary: string };
    expect(r.output.srtPath).toContain("final.srt");
  });

  it("image_prompts 工具用 mock 跑通：回放 image_prompts.json", async () => {
    const mock = await MockHeavyIoRuntime.create();
    const ip = createImagePromptsTool(mock);
    const { result } = await runTool(ip, { scriptText: "脚本内容" });
    const r = result as { output: { plan: string }; summary: string };
    const plan = JSON.parse(r.output.plan);
    expect(plan[0].image_path).toBe("cover.png");
  });

  it("video_build 工具用 mock 跑通：回放 final.mp4", async () => {
    const mock = await MockHeavyIoRuntime.create();
    const video = createVideoBuildTool(mock);
    const { result } = await runTool(video, {});
    const r = result as { output: { videoPath: string }; summary: string };
    const buf = await readFile(r.output.videoPath);
    expect(buf.toString()).toBe("mock-video");
  });

  it("rewrite(ollama) 工具用 mock 跑通：回放 script_v2_raw.txt", async () => {
    const mock = await MockHeavyIoRuntime.create();
    const rewrite = createRewriteTool({ runtime: mock, llm: {} as never, backend: "ollama" });
    const { result } = await runTool(rewrite, { translatedText: "译稿", style: "dialogue" });
    const r = result as { output: { script: string }; summary: string };
    expect(r.output.script).toContain("mock");
  });

  it("workDir 任务隔离：两个 taskId 互不污染", async () => {
    const mock = await MockHeavyIoRuntime.create();
    const w1 = mock.workDirOf("taskA");
    const w2 = mock.workDirOf("taskB");
    expect(w1).not.toBe(w2);
    await mock.ensureWorkDir(w1);
    await mock.writeScript(w1, "foo.txt", "A");
    // taskB 读不到 taskA 的文件
    const got = await mock.readScript(w2, "foo.txt");
    expect(got).toBeNull();
  });
});
