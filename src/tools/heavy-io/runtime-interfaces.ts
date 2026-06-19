import type { SubprocessResult } from "./provider.js";

/**
 * 重 IO 能力接口（见 09 P5，按能力拆分）。
 *
 * 设计原则：工具依赖**能力接口**而非具体类（SubprocessAdapter）。
 * 每类重 IO 能力声明自己所需的最小运行时契约，便于：
 *   - 本地子进程实现（SubprocessAdapter implements 全部）
 *   - 云端实现（如 CloudTtsRuntime 直连 Azure/ElevenLabs HTTP API）
 *   - mock 实现（回放产物文件，测试/演示用）
 *
 * 所有能力共享工作目录 + 文件中转 + 步骤调度的底层约定，
 * 故先定义基础接口 WorkDirRuntime，各能力接口扩展之（按需收窄语义）。
 */

/** 任务工作目录 + 文件中转基础能力。 */
export interface WorkDirRuntime {
  /** 任务工作目录（artifactsDir/<taskId>）。 */
  workDirOf(taskId: string): string;
  /** 确保 workDir 及其子目录存在。 */
  ensureWorkDir(workDir: string): Promise<void>;
  /** 写文本产物到 workDir/scripts/<name>。返回绝对路径。 */
  writeScript(workDir: string, name: string, content: string): Promise<string>;
  /** 读文本产物；不存在返回 null。 */
  readScript(workDir: string, name: string): Promise<string | null>;
  /** 列出 workDir/scripts/ 下匹配 glob 的文件名（不含目录前缀，按名排序）。 */
  listScripts?(workDir: string, glob: string): Promise<string[]>;
  /** 写任意文件到 workDir 根（非 scripts/），如 transcript_meta.json。 */
  writeWorkFile?(workDir: string, name: string, content: string): Promise<string>;
  /** 读 workDir 根下的任意文件；不存在返回 null。 */
  readWorkFile?(workDir: string, name: string): Promise<string | null>;
}

/** 步骤调度能力：运行一个编号步骤（ai-content-factory step 1-7）。 */
export interface StepRuntime {
  /**
   * 运行一个步骤。
   * @param step     步骤号（如 "2"、"3"、"4b"、"6"）
   * @param workDir  任务工作目录
   * @param opts     超时 / 是否用 TTS venv / 额外环境变量
   */
  runStep(
    step: string,
    workDir: string,
    opts?: { useTtsVenv?: boolean; timeoutMs?: number; extraEnv?: Record<string, string> },
  ): Promise<SubprocessResult>;
}

/**
 * TTS 能力（step4b）：文稿 → 音频文件。
 * tts 工具只需工作目录 + 文件中转 + 步骤调度。
 */
export interface TtsRuntime extends WorkDirRuntime, StepRuntime {}

/**
 * 生图能力（step4a）：场景清单 JSON → 图片文件。
 */
export interface ImageGenRuntime extends WorkDirRuntime, StepRuntime {}

/**
 * 视频合成能力（step6）：音频+图片+字幕 → 视频文件。
 */
export interface VideoBuildRuntime extends WorkDirRuntime, StepRuntime {}

/**
 * 文本步骤能力（step2/3b/3c）：文本输入 → 文本输出。
 */
export interface TextStepRuntime extends WorkDirRuntime, StepRuntime {}

/**
 * 字幕对齐能力（step5）：音频 → srt。
 */
export interface SubtitleRuntime extends WorkDirRuntime, StepRuntime {}

/**
 * 图片提示词能力（step3d）：权威文本 → 提示词 JSON。
 */
export interface ImagePromptsRuntime extends WorkDirRuntime, StepRuntime {}

/**
 * 改写能力（step3）：译稿 → 改写稿。
 * ollama 路径需工作目录 + 文件 + 步骤调度；openai 路径不走 runtime（直连 LlmService）。
 */
export interface RewriteRuntime extends WorkDirRuntime, StepRuntime {}
