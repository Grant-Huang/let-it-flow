/**
 * 诊断 stopWhen 多步循环是否生效。
 *
 * 用真实 LLM + 最小工具集跑一个简单意图，
 * 打印 streamText 实际收到的 stopWhen 和产出的 steps 数。
 */
import "dotenv/config";
import { streamText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { LlmService } from "../src/services/llm-service.js";
import { loadConfig } from "../src/llm/config-loader.js";
import { ensureSeedConfig } from "../src/llm/seed.js";

async function main() {
  ensureSeedConfig();
  const llm = new LlmService({
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    runtimeConfig: loadConfig(),
  });
  const model = llm.model("nexus_agent");
  const compatMode = llm.compatModeFor ? llm.compatModeFor("nexus_agent") : false;

  // 构造 stopWhen（与 react-harness 一致）
  const stopWhen = [stepCountIs(5), ((_opts: { steps: unknown[] }) => false) as never];

  console.log("═".repeat(80));
  console.log("  stopWhen 多步循环诊断");
  console.log("═".repeat(80));
  console.log("stopWhen 条件数:", stopWhen.length);
  console.log("compatMode:", compatMode);
  console.log("");

  // 简单工具：返回一个数字
  const tools = {
    get_number: tool({
      description: "获取一个数字。可多次调用获取不同数字。",
      inputSchema: z.object({ label: z.string().describe("数字标签") }),
      execute: async ({ label }: { label: string }) => {
        const val = Math.floor(Math.random() * 100);
        console.log(`  [工具执行] get_number(label="${label}") → ${val}`);
        return { label, value: val };
      },
    }),
  };

  const intent = "请分别获取三个数字（A、B、C），然后计算它们的总和并给出结论。每一步都要调工具。";

  const system = `你是测试助手。任务：${intent}
可用工具：get_number。
要求：必须分步调用工具，不要一次性给出答案。`;

  const streamArgs = compatMode
    ? { messages: [{ role: "user" as const, content: `${system}\n\n---\n${intent}` }] }
    : { system, messages: [{ role: "user" as const, content: intent }] };

  console.log("发起 streamText...");
  console.log("");

  const result = streamText({
    model,
    ...streamArgs,
    tools,
    stopWhen: stopWhen as never,
    onStepFinish: (ev) => {
      const toolNames = ev.toolCalls?.map((tc: { toolName: string }) => tc.toolName).join(", ") ?? "(无)";
      console.log(`  [onStepFinish] step ${ev.stepNumber}: finishReason=${ev.finishReason}, tools=[${toolNames}]`);
    },
  });

  const final = await result;
  const steps = (await final.steps) as Array<{ finishReason: string; toolResults?: unknown[] }>;
  const finalText = await final.text;

  console.log("");
  console.log("═".repeat(80));
  console.log("  结果");
  console.log("═".repeat(80));
  console.log("总 step 数:", steps?.length ?? 0);
  console.log("finalText:", finalText?.slice(0, 200));
  console.log("");
  console.log("各 step 的 finishReason:");
  for (let i = 0; i < (steps?.length ?? 0); i++) {
    console.log(`  step ${i}: ${steps![i]!.finishReason}`);
  }

  if ((steps?.length ?? 0) <= 1) {
    console.log("");
    console.log("⚠️ 只跑了 1 步！多步循环未生效。");
    console.log("  可能原因：");
    console.log("  1. stopWhen 未被 SDK 正确识别");
    console.log("  2. LLM 第一步就返回纯文本（无 tool-call）");
    console.log("  3. 兼容模式影响循环行为");
  } else {
    console.log("");
    console.log("✅ 多步循环生效！");
  }
}

main().catch((e) => {
  console.error("诊断失败：", e);
  process.exit(1);
});
