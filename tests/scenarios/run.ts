/**
 * 全流程场景测试 —— 主入口（tests/scenarios/run.ts）。
 *
 * 用法：pnpm scenarios
 *
 * 聚合 V/G/C/L/T 各层场景，逐个执行，生成供人阅读的 Markdown 报告：
 *   tests/reports/scenario-report.md
 *
 * 报告结构（每个场景）：
 *   - 假设 / 目的 / 过程
 *   - 调用清单（mock / real / synthetic 逐条标注 ← 关键可信度信息）
 *   - 预期 vs 实际（每个断言）
 *   - 通过/失败
 *
 * 与 full-test（vitest 聚合）的区别：
 *   full-test 是"机器视角"的测试运行器（通过/失败/耗时）；
 *   scenarios 是"人视角"的验收报告（假设→过程→预期→实际，可读叙事）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { versions, platform, cwd } from "node:process";
import type { Scenario, ScenarioResult, CallProvenance } from "./types.js";
import { vLayerScenarios } from "./v-layer.js";
import { gLayerScenarios } from "./g-layer.js";
import { cLayerScenarios } from "./c-layer.js";
import { lLayerScenarios } from "./l-layer.js";
import { tLayerScenarios } from "./t-layer.js";

const ROOT = cwd();
const REPORT_DIR = join(ROOT, "tests", "reports");
const REPORT_PATH = join(REPORT_DIR, "scenario-report.md");

const LAYER_NAMES: Record<string, string> = {
  V: "V 层 · 一致性（Precondition 前置条件）",
  G: "G 层 · 治理（Governance 确定性约束）",
  C: "C 层 · 准确度（输出结构自检）",
  L: "L 层 · 生命周期（Skill 沉淀）",
  T: "T 层 · 工具协议（EvidenceEnvelope + 动态裁剪）",
};

async function main() {
  const allScenarios: Scenario[] = [
    ...tLayerScenarios,
    ...vLayerScenarios,
    ...gLayerScenarios,
    ...cLayerScenarios,
    ...lLayerScenarios,
  ];

  console.log(`\n运行 ${allScenarios.length} 个全流程场景...\n`);
  const results: ScenarioResult[] = [];
  for (const s of allScenarios) {
    const r = await runScenario(s);
    results.push(r);
    const mark = r.passed ? "✓" : "✗";
    console.log(`  ${mark} ${s.id} [${s.layer}] ${s.title}  (${r.failedAssertions}/${r.totalAssertions} 失败)`);
  }

  // 汇总统计
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  const totalAssertions = results.reduce((a, r) => a + r.totalAssertions, 0);
  const passedAssertions = results.reduce((a, r) => a + (r.totalAssertions - r.failedAssertions), 0);

  // mock/real 统计
  const allCalls = allScenarios.flatMap((s) => s.calls);
  const mockCount = allCalls.filter((c) => c.kind === "mock").length;
  const realCount = allCalls.filter((c) => c.kind === "real").length;
  const synthCount = allCalls.filter((c) => c.kind === "synthetic").length;

  // 生成 Markdown
  const md = renderReport(results, {
    generatedAt: new Date().toISOString(),
    env: { node: versions.node, platform },
    totals: { total, passed, failed, totalAssertions, passedAssertions },
    callStats: { mock: mockCount, real: realCount, synthetic: synthCount },
  });

  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(REPORT_PATH, md, "utf8");
  console.log(`\n报告已写入 ${REPORT_PATH.replace(ROOT + "/", "")}`);
  console.log(`汇总：场景 ${passed}/${total} 通过，断言 ${passedAssertions}/${totalAssertions} 通过`);
  console.log(`调用来源：real=${realCount} mock=${mockCount} synthetic=${synthCount}\n`);

  if (failed > 0) process.exit(1);
}

async function runScenario(s: Scenario): Promise<ScenarioResult> {
  const start = Date.now();
  // 深拷贝断言，避免污染（run 多次）
  s.assertions = s.assertions.map((a) => ({ ...a }));
  try {
    await s.run();
  } catch (e) {
    return {
      scenario: s,
      passed: false,
      failedAssertions: s.assertions.length,
      totalAssertions: s.assertions.length,
      duration: Date.now() - start,
      error: (e as Error).message,
    };
  }
  const failedAssertions = s.assertions.filter((a) => !a.passed).length;
  return {
    scenario: s,
    passed: failedAssertions === 0,
    failedAssertions,
    totalAssertions: s.assertions.length,
    duration: Date.now() - start,
  };
}

interface ReportMeta {
  generatedAt: string;
  env: { node: string; platform: string };
  totals: { total: number; passed: number; failed: number; totalAssertions: number; passedAssertions: number };
  callStats: { mock: number; real: number; synthetic: number };
}

function renderReport(results: ScenarioResult[], meta: ReportMeta): string {
  const L: string[] = [];
  L.push(`# 全流程场景测试报告`);
  L.push("");
  L.push(`> 生成时间：${meta.generatedAt}`);
  L.push(`> 环境：Node ${meta.env.node} / ${meta.env.platform}`);
  L.push(`> 性质说明：本报告验证 NexusOps + let-it-flow 在**离线条件**下，各层机制（V/G/C/L/T）能否确定性输出符合预期的可信结果。真实 LLM 决策链路（ReAct 全流程）属 e2e 职责，不在此报告范围。`);
  L.push("");

  // ── 汇总 ──
  L.push(`## 汇总`);
  L.push("");
  L.push(`| 指标 | 值 |`);
  L.push(`|------|-----|`);
  const passRate = meta.totals.total > 0 ? ((meta.totals.passed / meta.totals.total) * 100).toFixed(1) : "0";
  const assertRate = meta.totals.totalAssertions > 0 ? ((meta.totals.passedAssertions / meta.totals.totalAssertions) * 100).toFixed(1) : "0";
  L.push(`| 场景通过率 | **${meta.totals.passed}/${meta.totals.total}**（${passRate}%）${meta.totals.failed > 0 ? " ⚠️ 有失败" : " ✅"} |`);
  L.push(`| 断言通过率 | ${meta.totals.passedAssertions}/${meta.totals.totalAssertions}（${assertRate}%） |`);
  L.push(`| 调用来源 | 🟢 real=${meta.callStats.real}　🟡 mock=${meta.callStats.mock}　⚪ synthetic=${meta.callStats.synthetic} |`);
  L.push("");

  // ── 调用来源图例 ──
  L.push(`### 调用来源图例`);
  L.push("");
  L.push(`报告对每个场景执行时涉及的调用逐条标注来源，便于判断"通过≠全链路真实"的边界：`);
  L.push("");
  L.push(`- 🟢 **real**：真实生产代码路径（如真实治理规则判定、真实证据强度计算）。机制正确性可信。`);
  L.push(`- 🟡 **mock**：替身（如工具未真实执行、LLM 未真调网络）。验证的是"机制被正确触发"，非"真实执行结果"。`);
  L.push(`- ⚪ **synthetic**：构造的输入数据（如手搓的 StepTrace、EvidenceEnvelope）。非真实运行产物，用于驱动 real 机制。`);
  L.push("");

  // ── 按层组织场景 ──
  const byLayer = new Map<string, ScenarioResult[]>();
  for (const r of results) {
    if (!byLayer.has(r.scenario.layer)) byLayer.set(r.scenario.layer, []);
    byLayer.get(r.scenario.layer)!.push(r);
  }
  for (const layer of ["T", "V", "G", "C", "L"]) {
    const items = byLayer.get(layer);
    if (!items || items.length === 0) continue;
    L.push(`---`);
    L.push(`## ${LAYER_NAMES[layer]}`);
    L.push("");
    for (const r of items) {
      L.push(renderScenario(r));
    }
  }

  // ── 失败详情速览 ──
  const failed = results.filter((r) => !r.passed);
  if (failed.length > 0) {
    L.push(`---`);
    L.push(`## 失败速览`);
    L.push("");
    for (const r of failed) {
      L.push(`- **${r.scenario.id} ${r.scenario.title}**`);
      if (r.error) L.push(`  - 场景级异常：${r.error}`);
      for (const a of r.scenario.assertions.filter((x) => !x.passed)) {
        L.push(`  - ${a.name}：预期 ${a.expected}；实际 ${a.actual ?? "(未填写)"}`);
      }
    }
    L.push("");
  }

  return L.join("\n");
}

function renderScenario(r: ScenarioResult): string {
  const s = r.scenario;
  const mark = r.passed ? "✅" : "❌";
  const L: string[] = [];
  L.push(`### ${mark} ${s.id} · ${s.title}`);
  L.push("");
  L.push(`**假设**：${s.hypothesis}`);
  L.push("");
  L.push(`**目的**：${s.purpose}`);
  L.push("");
  L.push(`**过程**：`);
  L.push(``);
  s.procedure.forEach((step, i) => L.push(`${i + 1}. ${step}`));
  L.push("");

  // 调用来源（关键）
  L.push(`**调用来源**（${r.passed ? "本次通过的可信度边界" : "失败时定位用"}）：`);
  L.push("");
  L.push(`| 调用对象 | 性质 | 说明 |`);
  L.push(`|----------|------|------|`);
  for (const c of s.calls) {
    L.push(`| \`${c.target}\` | ${kindEmoji(c.kind)} ${c.kind} | ${c.note} |`);
  }
  L.push("");

  // 断言：预期 vs 实际
  L.push(`**预期 vs 实际**：`);
  L.push("");
  L.push(`| # | 断言 | 预期 | 实际 | 结果 |`);
  L.push(`|---|------|------|------|------|`);
  s.assertions.forEach((a, i) => {
    const am = a.passed ? "✅" : "❌";
    L.push(`| ${i + 1} | ${a.name} | ${a.expected} | ${a.actual ?? "(未填写)"} | ${am} |`);
  });
  L.push("");

  if (r.error) {
    L.push(`> ⚠️ 场景级异常：\`${r.error}\``);
    L.push("");
  }

  return L.join("\n");
}

function kindEmoji(kind: CallProvenance["kind"]): string {
  return kind === "real" ? "🟢" : kind === "mock" ? "🟡" : "⚪";
}

main().catch((e) => {
  console.error("全流程场景测试异常：", e);
  process.exit(1);
});
