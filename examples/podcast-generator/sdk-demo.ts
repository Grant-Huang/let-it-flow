/**
 * Let-it-Flow SDK 端到端示例（P6）。
 *
 * 用法：
 *   # 文本子链（无需重 IO 环境）：
 *   tsx examples/podcast-generator/sdk-demo.ts "把 https://example.com/a 做成播客"
 *
 *   # 完整视频链（需 ai-content-factory + Ollama/TTS/FFmpeg）：
 *   LIF_AICF_REPO_ROOT=/path/to/ai-content-factory \
 *   tsx examples/podcast-generator/sdk-demo.ts "把 https://example.com/a 做成播客视频"
 *
 * 流程：
 *   1. flow.execute(intent) 启动并流式产出事件
 *   2. 遇到 confirm_gate（HITL）时自动批准继续（示例默认 auto-approve）
 *   3. 遇到 clarification_required 时用预设补充信息释放
 *   4. 打印各阶段事件，最终展示产物路径
 */
import "dotenv/config";
import { LetItFlow } from "../../src/index.js";
import type { StreamEvent } from "../../src/index.js";
import { registerPodcastTools, buildPodcastConfigFromEnv, SubprocessAdapter } from "./toolkit.js";
import { podcastTemplate } from "./template.js";

const intent = process.argv[2] ?? "把 https://example.com/a 做成播客";
console.log(`\n=== Let-it-Flow 端到端示例 ===\n意图：${intent}\n`);

const flow = new LetItFlow({
  openaiApiKey: process.env.OPENAI_API_KEY,
  openaiBaseUrl: process.env.OPENAI_BASE_URL,
  tavilyApiKey: process.env.TAVILY_API_KEY,
  consumerTemplates: [podcastTemplate],
});

// 显式注册 podcast domain 工具（内核不再默认装配）
const heavyConfig = buildPodcastConfigFromEnv();
if (heavyConfig) {
  registerPodcastTools(flow.tools, {
    runtime: new SubprocessAdapter(heavyConfig),
    llm: flow.llm,
    config: heavyConfig,
  });
  console.log(`已注册 podcast domain 工具（repo: ${heavyConfig.repoRoot}）`);
} else {
  console.log(`未配置 LIF_AICF_REPO_ROOT，仅文本子链可用`);
}

let runId = "";
const artifacts: string[] = [];

for await (const ev of flow.execute(intent)) {
  runId = ev.taskId;
  const p = ev.payload as Record<string, unknown>;
  printEvent(ev);

  // HITL：confirm_gate → 自动批准（示例；实际应用可弹窗让用户决策）
  if (ev.type === "extension" && p.name === "confirm_gate") {
    const data = (p.data ?? {}) as Record<string, unknown>;
    console.log(`  ↳ [HITL] 确认门 ${data.gate_id}，自动批准…`);
    await flow.approve(runId);
  }

  // guardrail 澄清 → 自动补充
  if (ev.type === "extension" && p.name === "clarification_required") {
    console.log(`  ↳ [HITL] 需要澄清，自动补充主题…`);
    await flow.clarify(runId, "主题是 AI 技术趋势");
  }

  // 收集产物（output 可能是 JSON 对象也可能是纯文本，防御性解析）
  if (ev.type === "tool_result") {
    const raw = String(p.output ?? "");
    let out: { ok?: boolean; videoPath?: string; audioPath?: string } = {};
    try {
      out = JSON.parse(raw) as typeof out;
    } catch {
      // 非 JSON 输出（如纯文本文稿），忽略——无文件路径可收集
    }
    if (out.videoPath) artifacts.push(out.videoPath);
    if (out.audioPath) artifacts.push(out.audioPath);
  }

  if (ev.type === "done") {
    console.log(`\n=== 完成 ===`);
  }
  if (ev.type === "error") {
    console.log(`\n=== 错误：${p.message} ===`);
  }
}

if (artifacts.length > 0) {
  console.log(`\n产物文件：`);
  for (const a of artifacts) console.log(`  - ${a}`);
}

function printEvent(ev: StreamEvent): void {
  const p = ev.payload as Record<string, unknown>;
  switch (ev.type) {
    case "stage":
      console.log(`[stage] ${p.name}（${p.state}）`);
      break;
    case "workflow_node":
      console.log(`[node]  ${p.node_id}（${p.state}）`);
      break;
    case "tool_call":
      console.log(`[call]  ${(p as { name?: string }).name}`);
      break;
    case "text":
      process.stdout.write(String(p.delta ?? ""));
      break;
    case "tool_result":
      console.log(`[result] ok`);
      break;
    case "extension":
      console.log(`[ext]   ${(p as { name: string }).name}`);
      break;
    case "done":
      break;
    case "error":
      break;
    default:
      console.log(`[${ev.type}]`);
  }
}
