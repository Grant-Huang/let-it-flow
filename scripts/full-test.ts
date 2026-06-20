#!/usr/bin/env tsx
/**
 * 全量测试报告器（scripts/full-test.ts）
 *
 * 用法：
 *   pnpm full-test            # 默认：离线全量（跳过网络/外部依赖测试）
 *   pnpm full-test --online   # 在线全量（含网络/LLM 测试，慢）
 *
 * 产物：终端彩色报告 + tests/reports/full-test-report.json（机器可读）。
 *
 * 报告内容：
 *   - 环境摘要（node/vitest/平台/时间）
 *   - 最初输入：所有发现的测试文件 + 分桶（离线/在线/跳过）
 *   - 最终输出：每个文件的通过/失败/跳过数 + 耗时
 *   - 失败用例详情（断言/堆栈）
 *   - 汇总：通过率、总耗时、退出码
 *
 * 设计原则：
 *   1. 一次跑完所有测试（不分批），用 startVitest 编程 API 收集结构化结果
 *   2. 在线测试默认跳过（CI/本地常用），--online 才纳入
 *   3. 报告自包含（不依赖外部 diff），大修后只需重跑即可对比
 *   4. 失败不静默：任何失败都进报告 + 非零退出码
 */
import { startVitest } from "vitest/node";
import { readdirSync, statSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { argv, cwd, exit, env, versions, platform } from "node:process";

// ─────────────────────────────────────────────────────────────────────────────
// 配置：网络/外部依赖测试清单（默认离线跳过，--online 才跑）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 在线测试：依赖真实 LLM API key / 外部网络 / 真实 MCP server。
 * 这些测试慢、可能因额度/网络波动 flaky，默认离线模式跳过。
 * 大修后如需验证完整链路，用 --online。
 */
const ONLINE_TESTS = [
  "tests/unit/test-p6-sdk.ts", // 真实 LetItFlow() → LLM planner + 网络
];

/**
 * E2E 测试：依赖完整服务栈，默认也跳过（用 --online 纳入）。
 */
const E2E_TESTS = ["tests/e2e/"];

// ─────────────────────────────────────────────────────────────────────────────
// 工具函数
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = cwd();
const REPORT_DIR = join(ROOT, "tests", "reports");

function color(code: string, s: string): string {
  if (env.NO_COLOR || !env.TTY) return s;
  return `\x1b[${code}m${s}\x1b[0m`;
}
const c = {
  red: (s: string) => color("31", s),
  green: (s: string) => color("32", s),
  yellow: (s: string) => color("33", s),
  cyan: (s: string) => color("36", s),
  dim: (s: string) => color("2", s),
  bold: (s: string) => color("1", s),
};

/** 格式化毫秒耗时为可读字符串。 */
function fmtMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function now(): string {
  return new Date().toISOString();
}

/** 递归列出 tests/ 下所有 .ts 文件（相对仓库根）。 */
function listAllTestFiles(): string[] {
  const out: string[] = [];
  /** 非 vitest 测试的子目录（scenarios 是 tsx 脚本聚合器，reports 是产物）。 */
  const SKIP_DIRS = new Set(["tests/scenarios", "tests/reports"]);
  const walk = (dir: string) => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e);
      const rel = relative(ROOT, full);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(rel)) walk(full);
      } else if (e.endsWith(".ts") && !e.endsWith(".d.ts")) {
        out.push(rel);
      }
    }
  };
  walk(join(ROOT, "tests"));
  return out.sort();
}

function isOnline(rel: string): boolean {
  return ONLINE_TESTS.some((p) => rel === p || rel.startsWith(p));
}
function isE2E(rel: string): boolean {
  return E2E_TESTS.some((p) => rel.startsWith(p));
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

interface FileResult {
  file: string;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
  failures?: Array<{ name: string; message: string; stack?: string }>;
}

interface Report {
  generatedAt: string;
  mode: "offline" | "online";
  env: {
    node: string;
    vitest: string;
    platform: string;
    cwd: string;
  };
  input: {
    allTestFiles: string[];
    buckets: {
      offline: string[];
      onlineSkipped: string[];
      e2eSkipped: string[];
    };
    testArgs: string[];
  };
  output: {
    files: FileResult[];
    totals: {
      passed: number;
      failed: number;
      skipped: number;
      total: number;
      duration: number;
      passRate: string;
    };
    duration: number;
    exitCode: number;
  };
}

async function main(): Promise<number> {
  const startTime = Date.now();
  const online = argv.includes("--online");
  const mode: "offline" | "online" = online ? "online" : "offline";

  console.log(c.bold(`\n╔══ 全量测试 ${mode === "online" ? "（在线）" : "（离线，跳过网络/E2E）"} ══╗\n`));

  // 1. 收集最初输入：所有测试文件 + 分桶
  const allFiles = listAllTestFiles();
  const offline = allFiles.filter((f) => !isOnline(f) && !isE2E(f));
  const onlineSkipped = allFiles.filter((f) => isOnline(f));
  const e2eSkipped = allFiles.filter((f) => isE2E(f));

  console.log(c.dim(`发现 ${allFiles.length} 个测试文件：`));
  console.log(`  ${c.green("离线")} ${offline.length}  ${c.yellow("在线跳过")} ${onlineSkipped.length}  ${c.dim("E2E 跳过")} ${e2eSkipped.length}`);

  if (!online) {
    if (onlineSkipped.length > 0) {
      console.log(c.dim(`\n  跳过的在线测试（用 --online 纳入）：`));
      for (const f of onlineSkipped) console.log(c.dim(`    - ${f}`));
    }
    if (e2eSkipped.length > 0) {
      console.log(c.dim(`\n  跳过的 E2E 测试（用 --online 纳入）：`));
      for (const f of e2eSkipped) console.log(c.dim(`    - ${f}`));
    }
  }

  // 2. 计算要跑的文件集合 + 排除集合
  const includeGlobs = online
    ? ["tests/unit/**/*.ts", "tests/e2e/**/*.ts"]
    : offline.map((f) => f);
  const excludeGlobs = online ? [] : [...onlineSkipped, ...e2eSkipped];

  console.log(c.dim(`\n运行 ${includeGlobs.length} 个测试文件...\n`));

  // 3. startVitest：stdin 退化为 pipe 避免交互式 TUI 抢占；reporter 用 json
  let exitCode = 0;
  const fileResults: FileResult[] = [];

  const vitest = await startVitest("test", includeGlobs, {
    run: true,
    exclude: ["node_modules/**", ...excludeGlobs],
    testTimeout: 15_000,
    reporters: ["json"],
    outputFile: join(REPORT_DIR, ".vitest-raw.json"),
    silent: false,
    api: false,
    ui: false,
  }, {
    test: {
      include: includeGlobs.length > 0 ? includeGlobs : ["tests/unit/**/*.ts"],
      exclude: ["node_modules/**", ...excludeGlobs],
    },
  });

  // startVitest 在 v2 把 process.exit 接管了；通过 onProcessExit / 读 outputFile 取结果
  // 兼容写法：vitest 可能已 close，这里直接读 outputFile
  const rawPath = join(REPORT_DIR, ".vitest-raw.json");
  try {
    const raw = JSON.parse(readFileSync(rawPath, "utf8")) as {
      testResults?: Array<{
        name?: string;
        assertionResults?: Array<{
          fullName?: string;
          status?: string;
          failureMessages?: string[];
        }>;
      }>;
      numTotalTests?: number;
      numPassedTests?: number;
      numFailedTests?: number;
      numPendingTests?: number;
      startTime?: number;
      success?: boolean;
    };

    // 按 file 聚合
    const byFile = new Map<string, FileResult>();
    for (const tr of raw.testResults ?? []) {
      const file = tr.name ? relative(ROOT, tr.name) : "(unknown)";
      const duration = (tr.endTime ?? 0) - (tr.startTime ?? 0);
      const fr: FileResult = { file, passed: 0, failed: 0, skipped: 0, duration, failures: [] };
      for (const ar of tr.assertionResults ?? []) {
        if (ar.status === "passed") fr.passed++;
        else if (ar.status === "failed") {
          fr.failed++;
          fr.failures!.push({
            name: ar.fullName ?? "(unknown)",
            message: ar.failureMessages?.[0] ?? "(no message)",
          });
        } else fr.skipped++; // skipped/todo/pending
      }
      byFile.set(file, fr);
    }
    fileResults.push(...byFile.values());
    exitCode = raw.success === false ? 1 : 0;

    // 汇总
    const passed = raw.numPassedTests ?? fileResults.reduce((a, f) => a + f.passed, 0);
    const failed = raw.numFailedTests ?? fileResults.reduce((a, f) => a + f.failed, 0);
    const skipped = raw.numPendingTests ?? fileResults.reduce((a, f) => a + f.skipped, 0);
    const total = raw.numTotalTests ?? passed + failed + skipped;
    printSummary(fileResults, { passed, failed, skipped, total, duration: Date.now() - startTime });

    // 写报告
    const report: Report = {
      generatedAt: now(),
      mode,
      env: {
        node: versions.node,
        vitest: getVitestVersion(),
        platform: `${platform} ${env.HOME ?? ""}`,
        cwd: ROOT,
      },
      input: {
        allTestFiles: allFiles,
        buckets: { offline, onlineSkipped, e2eSkipped },
        testArgs: argv.slice(2),
      },
      output: {
        files: fileResults.sort((a, b) => a.file.localeCompare(b.file)),
        totals: {
          passed, failed, skipped, total,
          duration: Date.now() - startTime,
          passRate: total > 0 ? `${((passed / total) * 100).toFixed(1)}%` : "n/a",
        },
        duration: Date.now() - startTime,
        exitCode,
      },
    };
    saveReport(report);
  } catch (e) {
    console.error(c.red(`\n报告解析失败：${(e as Error).message}`));
    exitCode = 1;
  } finally {
    try { await vitest.close(); } catch { /* noop */ }
    // 清理 vitest 中间产物（只保留汇总报告）
    try {
      const { unlinkSync } = await import("node:fs");
      unlinkSync(join(REPORT_DIR, ".vitest-raw.json"));
    } catch { /* noop */ }
  }

  return exitCode;
}

function getVitestVersion(): string {
  try {
    const p = join(ROOT, "node_modules", "vitest", "package.json");
    return JSON.parse(readFileSync(p, "utf8")).version;
  } catch {
    return "unknown";
  }
}

function printSummary(files: FileResult[], totals: { passed: number; failed: number; skipped: number; total: number; duration: number }) {
  console.log(c.bold(`\n╔══ 测试报告 ══╗\n`));
  console.log(`${c.dim("文件")}                              ${c.dim("通过 失败 跳过  耗时")}`);
  console.log(c.dim("─".repeat(70)));
  for (const f of files.sort((a, b) => a.file.localeCompare(b.file))) {
    const name = f.file.padEnd(38).slice(0, 38);
    const ok = f.failed === 0;
    const status = ok ? c.green("✓") : c.red("✗");
    const p = String(f.passed).padStart(4);
    const fa = f.failed > 0 ? c.red(String(f.failed).padStart(4)) : String(f.failed).padStart(4);
    const sk = c.dim(String(f.skipped).padStart(4));
    const dur = c.dim(fmtMs(f.duration).padStart(6));
    console.log(`${status} ${name} ${p} ${fa} ${sk} ${dur}`);
  }
  console.log(c.dim("─".repeat(70)));
  const pr = totals.total > 0 ? ((totals.passed / totals.total) * 100).toFixed(1) : "0.0";
  console.log(
    `${c.bold("汇总")}  ${c.green(`通过 ${totals.passed}`)}  ${totals.failed > 0 ? c.red(`失败 ${totals.failed}`) : `失败 ${totals.failed}`}  ${c.dim(`跳过 ${totals.skipped}`)}  ${c.bold(`通过率 ${pr}%`)}  ${c.dim(fmtMs(totals.duration))}`,
  );

  // 失败详情
  const failed = files.filter((f) => f.failed > 0);
  if (failed.length > 0) {
    console.log(c.bold(c.red(`\n╔══ 失败详情（${failed.length} 个文件）══╗`)));
    for (const f of failed) {
      console.log(c.red(`\n  ${f.file}`));
      for (const fail of f.failures ?? []) {
        console.log(c.red(`    × ${fail.name}`));
        const msg = fail.message.split("\n").slice(0, 6).join("\n      ");
        console.log(c.dim(`      ${msg}`));
      }
    }
  }
}

function saveReport(report: Report) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const path = join(REPORT_DIR, "full-test-report.json");
  writeFileSync(path, JSON.stringify(report, null, 2), "utf8");
  console.log(c.dim(`\n报告已写入 ${relative(ROOT, path)}\n`));
}

// ─────────────────────────────────────────────────────────────────────────────
// 入口
// ─────────────────────────────────────────────────────────────────────────────

main().then((code) => {
  exit(code);
}).catch((e) => {
  console.error(c.red(`\n全量测试异常退出：${(e as Error).message}`));
  console.error((e as Error).stack);
  exit(1);
});
