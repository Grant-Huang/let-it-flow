/**
 * Podcast 消费应用工具包入口。
 *
 * 聚合 podcast 完整链所需的全部 domain.* 工具，提供一站式注册函数。
 * 消费应用通过 `import { registerPodcastTools } from "./toolkit.js"` 显式装配，
 * 平台内核不内置任何 podcast 工具。
 *
 * 工具实现仍在内核目录（src/tools/heavy-io/、src/tools/builtin/text-steps.ts），
 * 只是"谁来注册"的调用权从内核（LetItFlow 构造函数）移交给了消费应用。
 */
import { getArtifactsDir } from "../../src/core/config.js";
import type { HeavyIoConfig } from "../../src/tools/heavy-io/provider.js";

export {
  registerHeavyIoTools as registerPodcastTools,
} from "../../src/tools/index.js";
export type { HeavyIoConfig } from "../../src/tools/heavy-io/provider.js";
export { SubprocessAdapter } from "../../src/tools/heavy-io/subprocess-adapter.js";

/**
 * 从环境变量构建 podcast 工具链配置（HeavyIoConfig）。
 * 未配置 LIF_AICF_REPO_ROOT 时返回 null（仅文本子链可用）。
 *
 *   LIF_AICF_REPO_ROOT   ai-content-factory 仓库根（必填）
 *   LIF_PYTHON_BIN       通用 Python（缺省 python3）
 *   LIF_TTS_PYTHON_BIN   Qwen3-TTS venv python（缺省同 LIF_PYTHON_BIN）
 *   LIF_REWRITE_BACKEND  ollama | openai（缺省 ollama）
 *   LIF_OLLAMA_MODEL     rewrite 用的 ollama 模型
 *   LIF_REWRITE_MODEL    rewrite 用的 openai 模型 id
 */
export function buildPodcastConfigFromEnv(): HeavyIoConfig | null {
  const repoRoot = process.env.LIF_AICF_REPO_ROOT;
  if (!repoRoot) return null;
  return {
    repoRoot,
    pythonBin: process.env.LIF_PYTHON_BIN ?? "python3",
    ttsPythonBin: process.env.LIF_TTS_PYTHON_BIN ?? process.env.LIF_PYTHON_BIN ?? "python3",
    artifactsDir: getArtifactsDir(),
    rewriteBackend: (process.env.LIF_REWRITE_BACKEND as "ollama" | "openai") ?? "ollama",
    ollamaRewriteModel: process.env.LIF_OLLAMA_MODEL,
    rewriteOpenaiModel: process.env.LIF_REWRITE_MODEL,
  };
}
