/**
 * 诊断 NexusOps 真实 task 的多步循环行为。
 *
 * 直接 bootNexusOps → 提交 task → 等待完成 → 打印 stepTrace。
 * 绕过 HTTP，确保 server 生命周期与诊断进程一致。
 */
import "dotenv/config";
import { bootNexusOps } from "../apps/nexusops/server/boot.js";
import { TaskRegistry } from "../src/tasks/registry.js";

async function main() {
  console.log("═".repeat(80));
  console.log("  NexusOps 多步循环诊断");
  console.log("═".repeat(80));

  const intent = "找到OEE最近偏低的产线，帮我诊断原因并给改善建议";
  console.log("Intent:", intent);
  console.log("");

  console.log("[1/4] bootNexusOps...");
  const runtime = await bootNexusOps();
  console.log("boot 完成");
  console.log("");

  console.log("[2/4] 组装 TaskRegistry...");
  const { FileTaskStore } = await import("../src/tasks/task-store.js");
  const taskStore = new FileTaskStore();
  const registry = new TaskRegistry(taskStore, runtime.taskRuntime);
  console.log("");

  console.log("[3/4] 提交 task...");
  const meta = registry.start(intent);
  const taskId = meta.id;
  console.log("taskId:", taskId);
  console.log("");

  // 监听完成事件
  const startedAt = Date.now();
  let finished = false;
  let finalResult: any = null;

  const checkInterval = setInterval(() => {
    const task = taskStore.get(taskId);
    if (task?.status === "done" || task?.status === "failed" || task?.status === "error") {
      finished = true;
      finalResult = task;
      clearInterval(checkInterval);
    }
  }, 1000);

  // 等待完成（最多 180 秒）
  const timeoutMs = 180000;
  const startWait = Date.now();
  while (!finished && Date.now() - startWait < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000));
    const elapsed = Math.floor((Date.now() - startWait) / 1000);
    if (elapsed % 10 === 0) {
      const task = taskStore.get(taskId);
      console.log(`  [${elapsed}s] status=${task?.status ?? "unknown"}`);
    }
  }
  clearInterval(checkInterval);

  if (!finished) {
    console.log("⚠️ task 超时未完成");
    process.exit(1);
  }

  console.log("");
  console.log("[4/4] task 结果");
  console.log("═".repeat(80));
  console.log("status:", finalResult.status);

  // 从 events.jsonl 读取 step_trace 扩展事件
  const fs = await import("node:fs");
  const path = await import("node:path");
  // data dir 可能是 data/tasks 或 data/nexusops/tasks，取决于 LIF_DATA_DIR
  const { getDataDir } = await import("../src/core/config.js");
  const dataDir = getDataDir();
  const eventsPath = path.join(dataDir, "tasks", taskId, "events.jsonl");
  let stepTrace: any[] = [];
  let finalText = "";
  let finishReason = "";
  if (fs.existsSync(eventsPath)) {
    const lines = fs.readFileSync(eventsPath, "utf8").split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const ev = JSON.parse(line);
        const payload = ev.payload;
        if (payload?.name === "step_trace" || payload?.name === "react_step_trace") {
          stepTrace = payload.data?.stepTrace ?? [];
          finalText = payload.data?.finalText ?? "";
        }
        if (payload?.name === "react_result") {
          finishReason = payload.data?.finishReason ?? "";
        }
      } catch {}
    }
  }

  console.log("finishReason:", finishReason);
  console.log("");

  console.log("stepTrace 数量:", stepTrace.length);
  for (const s of stepTrace) {
    const tools = s.toolCalls?.map((tc: { toolName: string }) => tc.toolName).join(", ") ?? "(无工具)";
    const textPreview = (s.thought ?? "").slice(0, 100);
    console.log(`  step ${s.stepNumber}: finishReason=${s.finishReason}, tools=[${tools}]`);
    if (textPreview) console.log(`    thought: ${textPreview}`);
  }

  console.log("");
  console.log("finalText 前 500 字:");
  console.log(finalText.slice(0, 500));

  // 判定
  console.log("");
  console.log("═".repeat(80));
  if (stepTrace.length <= 1) {
    console.log("⚠️ 只跑了 1 步！多步循环未生效。");
  } else if (stepTrace.length < 4) {
    console.log(`⚠️ 只跑了 ${stepTrace.length} 步（偏少）。`);
  } else {
    console.log(`✅ 多步循环正常（${stepTrace.length} 步）。`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("诊断失败：", e);
  process.exit(1);
});
