import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import type { HeavyIoConfig, SubprocessResult } from "./provider.js";

/**
 * Python 子进程适配（见 09 P5）。
 *
 * 复用 ai-content-factory 的 run_step.py 统一调度器：
 *   python -m tools.run_step <step> <work_dir> --repo-root <repo>
 *
 * 数据传递统一用文件中转（与 ai-content-factory 约定一致）：
 *   workDir/scripts/*.txt  文本产物（transcript/translate/rewrite/prompts）
 *   workDir/audio/*.mp3    TTS 产物
 *   workDir/images/*.png   生图产物
 *   workDir/video/*.mp4    视频合成产物
 *
 * 每个 podcast 任务用独立 workDir（artifactsDir/<taskId>）。
 */
export class SubprocessAdapter {
  constructor(private readonly config: HeavyIoConfig) {}

  get pythonBin(): string {
    return this.config.pythonBin ?? "python3";
  }

  get ttsPythonBin(): string {
    return this.config.ttsPythonBin ?? this.config.pythonBin ?? "python3";
  }

  /** 任务工作目录（artifactsDir/<taskId>）。 */
  workDirOf(taskId: string): string {
    return join(this.config.artifactsDir, taskId);
  }

  /** 确保 workDir 及其子目录存在（与 run_step.py 一致）。 */
  async ensureWorkDir(workDir: string): Promise<void> {
    for (const sub of ["scripts", "audio", "images", "video"]) {
      await mkdir(join(workDir, sub), { recursive: true });
    }
  }

  /** 写文本产物到 workDir/scripts/<name>。 */
  async writeScript(workDir: string, name: string, content: string): Promise<string> {
    const path = join(workDir, "scripts", name);
    await mkdir(join(workDir, "scripts"), { recursive: true });
    await writeFile(path, content, "utf8");
    return path;
  }

  /** 读文本产物。不存在返回 null。 */
  async readScript(workDir: string, name: string): Promise<string | null> {
    const path = join(workDir, "scripts", name);
    try {
      await access(path);
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  }

  /**
   * 运行一个 ai-content-factory 步骤。
   * @param step     步骤号（如 "2"、"3"、"4b"、"6"）
   * @param workDir  任务工作目录
   * @param opts     额外 CLI 参数（如 --url）+ 是否用 TTS venv + 额外环境变量
   * @returns 子进程结果
   */
  async runStep(
    step: string,
    workDir: string,
    opts: { extraArgs?: string[]; useTtsVenv?: boolean; timeoutMs?: number; extraEnv?: Record<string, string> } = {},
  ): Promise<SubprocessResult> {
    const bin = opts.useTtsVenv ? this.ttsPythonBin : this.pythonBin;
    const args = ["-m", "tools.run_step", step, workDir, "--repo-root", this.config.repoRoot];
    if (opts.extraArgs) args.push(...opts.extraArgs);

    return runChild(bin, args, {
      cwd: this.config.repoRoot,
      timeoutMs: opts.timeoutMs ?? 600_000, // 重 IO 默认 10 分钟超时
      extraEnv: opts.extraEnv,
    });
  }

  /**
   * 直接运行任意 Python 脚本（用于 TTS 等不在 run_step 调度的能力）。
   */
  async runScript(
    scriptArgs: string[],
    opts: { pythonBin?: string; cwd?: string; timeoutMs?: number; extraEnv?: Record<string, string> } = {},
  ): Promise<SubprocessResult> {
    return runChild(opts.pythonBin ?? this.pythonBin, scriptArgs, {
      cwd: opts.cwd ?? this.config.repoRoot,
      timeoutMs: opts.timeoutMs ?? 600_000,
      extraEnv: opts.extraEnv,
    });
  }
}

/** 子进程执行内核：spawn → 收集 stdout/stderr → 超时杀进程。 */
function runChild(
  bin: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; extraEnv?: Record<string, string> },
): Promise<SubprocessResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.extraEnv ? { ...process.env, ...opts.extraEnv } : process.env,
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGTERM");
    }, opts.timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: `${stderr}\n[spawn error] ${err.message}`, exitCode: null });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (killed) {
        resolve({ ok: false, stdout, stderr: `${stderr}\n[timeout] 超过 ${opts.timeoutMs}ms`, exitCode: null });
        return;
      }
      resolve({ ok: code === 0, stdout, stderr, exitCode: code });
    });
  });
}
