/**
 * HeavyIoProvider —— 重 IO 能力抽象（见 09 P5）。
 *
 * MVP 提供本地子进程实现（调 ai-content-factory 的 run_step.py）；
 * 接口设计允许后续替换为云端实现（mock / 远程 API）。
 *
 * 每个 provider 封装一类重 IO 能力：
 *   - 文件中转：TS 把输入写入 workDir/scripts/*.txt，调 Python 子进程，
 *     读 workDir/{audio,images,video}/* 结果文件。
 *   - workDir：每任务独立的工作目录（ARTIFACTS_DIR/<taskId>）。
 */
export interface HeavyIoProvider {
  /** provider 唯一名（如 "tts"、"image-gen"）。 */
  readonly name: string;
}

/**
 * 子进程执行结果。
 * @param ok      是否成功（exit 0）
 * @param stdout  子进程标准输出
 * @param stderr  子进程标准错误
 * @param exitCode 退出码（失败时有）
 */
export interface SubprocessResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

/**
 * 重 IO 子进程调用的通用配置。
 * 所有 provider 共享：Python 解释器路径、ai-content-factory 仓库根、TTS venv。
 */
export interface HeavyIoConfig {
  /** Python 解释器（运行 ai-content-factory 文本步骤）。缺省 "python3"。 */
  pythonBin?: string;
  /** ai-content-factory 仓库根目录（含 tools/ 包）。 */
  repoRoot: string;
  /** Qwen3-TTS venv 的 python（TTS 专用，依赖 torch/transformers）。 */
  ttsPythonBin?: string;
  /** 工作目录根（任务产物落盘的父目录）。 */
  artifactsDir: string;
  /** rewrite 用的 LLM 后端：ollama（默认 35b）/ openai。 */
  rewriteBackend?: "ollama" | "openai";
  /** ollama rewrite 模型名（缺省 huihui-qwen3.6-35b-a3b-abliterated:latest）。 */
  ollamaRewriteModel?: string;
}

export const DEFAULT_OLLAMA_REWRITE_MODEL = "huihui-qwen3.6-35b-a3b-abliterated:latest";
