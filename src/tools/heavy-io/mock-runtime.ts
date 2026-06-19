import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { SubprocessResult } from "./provider.js";
import type {
  TtsRuntime,
  ImageGenRuntime,
  VideoBuildRuntime,
  TextStepRuntime,
  SubtitleRuntime,
  ImagePromptsRuntime,
  RewriteRuntime,
} from "./runtime-interfaces.js";

/**
 * Mock 重 IO 运行时（不调 Python，回放合成产物）。
 *
 * 用于：测试、演示、CI（无 GPU/无 ai-content-factory 环境下验证全链路）。
 * 证明"换运行时实现不换工具"：同样一批工具（createTtsTool 等），
 * 注入 MockHeavyIoRuntime 即可跑通，无需 SubprocessAdapter。
 *
 * 行为：
 *   - workDir：用系统临时目录（每实例一个根），与真实 adapter 同结构。
 *   - writeScript：真实写入文件（保持文件中转语义）。
 *   - runStep：按步骤号回放合成产物（脚本/占位音频/占位图片/占位视频），
 *     返回 ok=true 的 SubprocessResult。
 *   - readScript：读真实文件（步骤回放写入的）。
 */
export class MockHeavyIoRuntime
  implements
    TtsRuntime,
    ImageGenRuntime,
    VideoBuildRuntime,
    TextStepRuntime,
    SubtitleRuntime,
    ImagePromptsRuntime,
    RewriteRuntime
{
  private readonly rootDir: string;

  private constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  /** 创建一个隔离的 mock 运行时（独立临时根目录）。 */
  static async create(): Promise<MockHeavyIoRuntime> {
    const rootDir = await mkdtemp(join(tmpdir(), "lif-mock-"));
    return new MockHeavyIoRuntime(rootDir);
  }

  workDirOf(taskId: string): string {
    return join(this.rootDir, taskId);
  }

  async ensureWorkDir(workDir: string): Promise<void> {
    for (const sub of ["scripts", "audio", "images", "video"]) {
      await mkdir(join(workDir, sub), { recursive: true });
    }
  }

  async writeScript(workDir: string, name: string, content: string): Promise<string> {
    const path = join(workDir, "scripts", name);
    await mkdir(join(workDir, "scripts"), { recursive: true });
    await writeFile(path, content, "utf8");
    return path;
  }

  async readScript(workDir: string, name: string): Promise<string | null> {
    try {
      return await readFile(join(workDir, "scripts", name), "utf8");
    } catch {
      return null;
    }
  }

  async listScripts(workDir: string, glob: string): Promise<string[]> {
    try {
      const all = await readdir(join(workDir, "scripts"));
      const re = new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      return all.filter((f) => re.test(f)).sort();
    } catch {
      return [];
    }
  }

  async writeWorkFile(workDir: string, name: string, content: string): Promise<string> {
    const path = join(workDir, name);
    await mkdir(workDir, { recursive: true });
    await writeFile(path, content, "utf8");
    return path;
  }

  async readWorkFile(workDir: string, name: string): Promise<string | null> {
    try {
      return await readFile(join(workDir, name), "utf8");
    } catch {
      return null;
    }
  }

  /**
   * 回放步骤产物（不调 Python）。
   * 按 ai-content-factory 各步骤的输出约定写入合成文件。
   */
  async runStep(
    step: string,
    workDir: string,
    _opts?: { useTtsVenv?: boolean; timeoutMs?: number; extraEnv?: Record<string, string> },
  ): Promise<SubprocessResult> {
    await this.ensureWorkDir(workDir);
    switch (step) {
      case "2": // translate → translated.txt
        await this.writeScript(workDir, "translated.txt", "[mock] translated transcript text");
        break;
      case "3": // rewrite → script_v2_raw.txt
        await this.writeScript(workDir, "script_v2_raw.txt", "[mock] rewritten script narrative");
        break;
      case "3b": // seam_repair → output 由 makeStepTool 配置；写通用回退
        break;
      case "3c":
        break;
      case "3d": // image_prompts → image_prompts.json
        await this.writeScript(
          workDir,
          "image_prompts.json",
          JSON.stringify([{ image_path: "cover.png", para_summary: "mock scene" }]),
        );
        break;
      case "4b": // tts → audio/voiceover_full.mp3（占位）
        await writeFile(join(workDir, "audio", "voiceover_full.mp3"), Buffer.from("mock-audio"));
        break;
      case "4a": // image_gen → images/cover.png（占位）
        await writeFile(join(workDir, "images", "cover.png"), Buffer.from("mock-image"));
        break;
      case "5": // subtitle → final.srt
        await this.writeScript(workDir, "final.srt", "1\n00:00:00,000 --> 00:00:02,000\n[mock] subtitle\n");
        break;
      case "6": // video_build → video/final.mp4（占位）
        await writeFile(join(workDir, "video", "final.mp4"), Buffer.from("mock-video"));
        break;
      default:
        break;
    }
    return { ok: true, stdout: `[mock] step ${step} done`, stderr: "", exitCode: 0 };
  }
}
