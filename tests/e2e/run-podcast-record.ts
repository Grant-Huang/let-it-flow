/**
 * Podcast-skill 真实 record 脚本（p5）。
 *
 * 用法：tsx tests/e2e/run-podcast-record.ts "<intent>"
 * 默认 intent：做一期关于 AI 技术趋势的播客
 *
 * 真实跑完整 ReAct 流程（真实 LLM + 真实 web_search），把：
 *   - 所有 tool_result 错误（schema/governance/tool_error）
 *   - 调用链
 *   - 产物预览
 *   - 最终状态
 * 写进 data/podcast-eval/<ts>-record.json 报告。
 *
 * 录制 fixture 到 tests/e2e/fixtures/podcast-<hash>.json（供 replay）。
 */
import "dotenv/config";
import { runPodcastFlow, writeReport, extractToolErrors } from "./podcast-eval-harness.js";

const intent = process.argv[2] ?? "做一期关于 AI 技术趋势的播客";

console.log(`\n[record] intent = ${intent}`);
console.log(`[record] 开始真实执行（可能需要数分钟）...\n`);

const startedAt = Date.now();

try {
  const result = await runPodcastFlow(intent, { mode: "record" });
  const elapsedMs = Date.now() - startedAt;

  const report = {
    intent,
    recordedAt: new Date().toISOString(),
    elapsedMs,
    status: result.status,
    error: result.error,
    stepCount: result.stepTrace.length,
    calledTools: result.calledTools,
    toolErrors: result.toolErrors,
    artifacts: result.artifacts.map((a) => ({
      type: a.type,
      sourceTool: a.sourceTool,
      fullLength: a.fullLength,
      preview: a.preview,
    })),
    finalText: result.finalText.slice(0, 1000),
    events: result.events.map((e) => ({ type: e.type })),
  };

  const reportPath = writeReport("record", report);
  console.log(`\n[record] 完成，耗时 ${(elapsedMs / 1000).toFixed(1)}s`);
  console.log(`[record] 状态: ${result.status}`);
  console.log(`[record] 步数: ${result.stepTrace.length}`);
  console.log(`[record] 工具调用: ${result.calledTools.join(" → ")}`);
  console.log(`[record] 产物数: ${result.artifacts.length}`);
  console.log(`[record] tool_result 错误数: ${result.toolErrors.length}`);
  if (result.toolErrors.length > 0) {
    console.log(`[record] 错误明细:`);
    for (const e of result.toolErrors) {
      console.log(`         - [${e.kind}] ${e.toolName}: ${e.message.slice(0, 120)}`);
    }
  }
  console.log(`\n[record] 报告: ${reportPath}`);

  process.exit(result.status === "done" && result.toolErrors.length === 0 ? 0 : 1);
} catch (err) {
  const elapsedMs = Date.now() - startedAt;
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(`\n[record] 异常（耗时 ${(elapsedMs / 1000).toFixed(1)}s）:`, message);
  if (stack) console.error(stack);
  writeReport("record-error", {
    intent,
    elapsedMs,
    error: message,
    stack,
  });
  process.exit(2);
}
