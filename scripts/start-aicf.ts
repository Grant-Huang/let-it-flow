#!/usr/bin/env tsx
/**
 * AI Content Factory 本地一键启动（scripts/start-aicf.ts）。
 *
 * 用法：
 *   pnpm start:aicf            # 生产模式（先 build，再跑 vite preview + tsx server）
 *   pnpm start:aicf:dev        # 开发模式（vite + tsx watch，热重载）
 *
 * 职责：
 *   1. 检查 .env（缺失则从 .env.example 拷贝，提示用户填 key）
 *   2. 首次启动自动初始化 KB vault（OBSIDIAN_VAULT_PATH=./data/aicf-vault）
 *   3. 前置 build（生产模式：tsc -b + vite build；开发模式跳过）
 *   4. 并行启动后端（:8789）+ 前端（:5174 → 代理 /api 到后端）
 *   5. 统一日志前缀 [web] / [api]，Ctrl+C 优雅退出两个子进程
 *
 * 设计原则：
 *   - 零新增依赖（用 node:child_process，不引 concurrently）
 *   - 失败可见（任一子进程退出 → 全部退出 + 非零码）
 *   - 幂等（重复跑不重复初始化 vault）
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { argv, cwd, env, exit, platform } from "node:process";
import { AICF_PORT, AICF_WEB_PORT } from "../src/core/ports.js";

const ROOT = cwd();
const AICF_DIR = join(ROOT, "apps", "ai-content-factory");
const WEB_DIR = join(AICF_DIR, "web");
const ENV_PATH = join(ROOT, ".env");
const ENV_EXAMPLE = join(ROOT, ".env.example");
const VAULT_PATH = join(ROOT, "data", "aicf-vault");

const isDev = argv.includes("--dev") || argv.includes("dev");
const mode = isDev ? "dev" : "prod";

// ─────────────────────────────────────────────────────────────────────────────
// 1. .env 检查
// ─────────────────────────────────────────────────────────────────────────────
if (!existsSync(ENV_PATH)) {
  if (existsSync(ENV_EXAMPLE)) {
    copyFileSync(ENV_EXAMPLE, ENV_PATH);
    console.log(`[start-aicf] 已从 .env.example 创建 .env，请编辑填入 OPENAI_API_KEY 后重跑`);
    exit(1);
  } else {
    console.error(`[start-aicf] 未找到 .env 也未找到 .env.example，无法启动`);
    exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. KB vault 初始化（首次启动）
// ─────────────────────────────────────────────────────────────────────────────
if (!existsSync(VAULT_PATH)) {
  console.log(`[start-aicf] 首次启动，初始化 KB vault → ${VAULT_PATH.replace(ROOT + "/", "./")}`);
  const install = spawn(
    "pnpm",
    ["tsx", "apps/ai-content-factory/kb-seed/install-vault.ts"],
    {
      stdio: "inherit",
      env: { ...env, OBSIDIAN_VAULT_PATH: VAULT_PATH },
      cwd: ROOT,
      shell: platform === "win32",
    },
  );
  install.on("exit", (code) => {
    if (code !== 0) {
      console.error(`[start-aicf] vault 初始化失败（exit ${code}）`);
      exit(code ?? 1);
    }
    continueStart();
  });
} else {
  console.log(`[start-aicf] KB vault 已存在，跳过初始化`);
  continueStart();
}

// ─────────────────────────────────────────────────────────────────────────────
// 3+. build + 并行启动
// ─────────────────────────────────────────────────────────────────────────────
function continueStart(): void {
  // 设置后端要读的环境（vault 路径 + 端口）
  const apiEnv: NodeJS.ProcessEnv = {
    ...env,
    OBSIDIAN_VAULT_PATH: VAULT_PATH,
    AICF_PORT: env.AICF_PORT ?? String(AICF_PORT),
    LIF_DATA_DIR: env.LIF_DATA_DIR ?? join(ROOT, "data"),
  };
  // 前端通过 vite proxy 把 /api 转到后端，preview/dev 都复用 server.proxy 配置
  const webEnv: NodeJS.ProcessEnv = {
    ...env,
    LIF_BACKEND_URL: `http://localhost:${apiEnv.AICF_PORT}`,
  };

  if (!isDev) {
    // 生产模式：先 build
    console.log(`[start-aicf] 生产模式：构建前端 + 后端...`);
    const buildApi = spawn("pnpm", ["--filter", "@let-it-flow/ai-content-factory", "build"], {
      stdio: "inherit",
      cwd: ROOT,
      shell: platform === "win32",
    });
    buildApi.on("exit", (code1) => {
      if (code1 !== 0) return exit(code1 ?? 1);
      const buildWeb = spawn("pnpm", ["--filter", "@let-it-flow/ai-content-factory-web", "build"], {
        stdio: "inherit",
        cwd: ROOT,
        shell: platform === "win32",
      });
      buildWeb.on("exit", (code2) => {
        if (code2 !== 0) return exit(code2 ?? 1);
        launchParallel(apiEnv, webEnv);
      });
    });
  } else {
    launchParallel(apiEnv, webEnv);
  }
}

/** 并行启动 web + api，统一日志，任一退出则全部退出。 */
function launchParallel(apiEnv: NodeJS.ProcessEnv, webEnv: NodeJS.ProcessEnv): void {
  console.log(`\n[start-aicf] 启动 ${mode} 模式：后端 :${apiEnv.AICF_PORT} + 前端 :${AICF_WEB_PORT}\n`);

  const apiCmd = isDev ? ["tsx", "watch", "apps/ai-content-factory/server/index.ts"] : ["tsx", "apps/ai-content-factory/server/index.ts"];
  const webCmd = isDev ? ["vite", "--port", String(AICF_WEB_PORT)] : ["vite", "preview", "--port", String(AICF_WEB_PORT)];

  const api = spawn("pnpm", apiCmd, {
    stdio: ["ignore", "pipe", "pipe"],
    env: apiEnv,
    cwd: ROOT,
    shell: platform === "win32",
  });
  const web = spawn("pnpm", webCmd, {
    stdio: ["ignore", "pipe", "pipe"],
    env: webEnv,
    cwd: WEB_DIR,
    shell: platform === "win32",
  });

  prefixPipe(api.stdout, "[api] ");
  prefixPipe(api.stderr, "[api] ");
  prefixPipe(web.stdout, "[web] ");
  prefixPipe(web.stderr, "[web] ");

  const children: ChildProcess[] = [api, web];
  let exiting = false;
  const killAll = (code: number) => {
    if (exiting) return;
    exiting = true;
    for (const c of children) {
      if (!c.killed) c.kill(code === 0 ? "SIGTERM" : "SIGKILL");
    }
    exit(code);
  };

  api.on("exit", (code) => {
    console.log(`[api] 进程退出（code=${code}）`);
    killAll(code ?? 1);
  });
  web.on("exit", (code) => {
    console.log(`[web] 进程退出（code=${code}）`);
    killAll(code ?? 1);
  });

  process.on("SIGINT", () => killAll(0));
  process.on("SIGTERM", () => killAll(0));

  console.log(`[start-aicf] 前端访问：http://localhost:${AICF_WEB_PORT}`);
  console.log(`[start-aicf] 后端 API：http://localhost:${apiEnv.AICF_PORT}/health`);
  console.log(`[start-aicf] Ctrl+C 退出全部\n`);
}

/** 给子进程输出加前缀，行缓冲。 */
function prefixPipe(stream: NodeJS.ReadableStream | null, prefix: string): void {
  if (!stream) return;
  let buf = "";
  stream.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) process.stdout.write(prefix + line + "\n");
  });
  stream.on("end", () => {
    if (buf) process.stdout.write(prefix + buf + "\n");
  });
}
