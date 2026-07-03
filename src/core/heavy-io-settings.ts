import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getDataDir } from "./config.js";

/**
 * 重 IO 工具链设置（页面3 后端数据层）。
 *
 * 这些项原本就走 env（LIF_REWRITE_BACKEND / LIF_TTS_ENGINE 等），
 * 这里增加一层 JSON 覆盖（优先级高于 env），供前端可视化编辑。
 *
 * 优先级：JSON 文件 > 环境变量 > 默认值
 *
 * 注意：重 IO 设置在进程启动时读取并构造 SubprocessAdapter，
 * 改动后需重启进程才生效（不热加载）。
 */

/** 重 IO 工具链设置类型（显式接口，避免 as const 字面量映射导致类型过窄）。 */
export interface HeavyIoSettings {
  /** rewrite 用的 LLM 后端。原 "ollama"。env: LIF_REWRITE_BACKEND。 */
  rewriteBackend: "ollama" | "openai";
  /** ollama rewrite 模型名。env: LIF_OLLAMA_MODEL。无默认（部署时按实际环境配置）。 */
  ollamaRewriteModel: string;
  /** openai rewrite 模型 id。env: LIF_REWRITE_MODEL。 */
  rewriteOpenaiModel: string;
  /** TTS 引擎。原 "edge"。env: LIF_TTS_ENGINE。 */
  ttsEngine: "edge" | "qwen";
  /** TTS 参考音色路径（qwen 引擎用）。env: LIF_TTS_REF_AUDIO。 */
  ttsRefAudio: string;
  /** 通用 Python 解释器。原 "python3"。env: LIF_PYTHON_BIN。 */
  pythonBin: string;
  /** Qwen3-TTS venv python。原 "python3"。env: LIF_TTS_PYTHON_BIN。 */
  ttsPythonBin: string;
}

/** 部分更新类型。 */
export type HeavyIoSettingsPatch = Partial<HeavyIoSettings>;

export const DEFAULT_HEAVY_IO_SETTINGS: HeavyIoSettings = {
  rewriteBackend: "ollama",
  ollamaRewriteModel: "",
  rewriteOpenaiModel: "",
  ttsEngine: "edge",
  ttsRefAudio: "",
  pythonBin: "python3",
  ttsPythonBin: "python3",
};

const FILE_NAME = "heavy_io_settings.json";

function configFilePath(dataDir: string = getDataDir()): string {
  return join(dataDir, "config", FILE_NAME);
}

/**
 * 读取设置：JSON > env > 默认值。
 * 返回 { settings, sourceMap } 便于前端展示每项值来源。
 */
export function loadHeavyIoSettings(
  dataDir: string = getDataDir(),
): { settings: HeavyIoSettings; sources: Record<string, "json" | "env" | "default"> } {
  const sources: Record<string, "json" | "env" | "default"> = {};
  const result: HeavyIoSettings = { ...DEFAULT_HEAVY_IO_SETTINGS };

  // env 映射
  const envMap: Record<keyof HeavyIoSettings, string> = {
    rewriteBackend: "LIF_REWRITE_BACKEND",
    ollamaRewriteModel: "LIF_OLLAMA_MODEL",
    rewriteOpenaiModel: "LIF_REWRITE_MODEL",
    ttsEngine: "LIF_TTS_ENGINE",
    ttsRefAudio: "LIF_TTS_REF_AUDIO",
    pythonBin: "LIF_PYTHON_BIN",
    ttsPythonBin: "LIF_TTS_PYTHON_BIN",
  };

  // 类型安全的字段写入辅助（绕过联合类型 key 索引问题）
  function setField<K extends keyof HeavyIoSettings>(key: K, value: HeavyIoSettings[K]): void {
    result[key] = value;
  }
  function setFieldInto<K extends keyof HeavyIoSettings>(
    target: Partial<HeavyIoSettings>,
    key: K,
    value: HeavyIoSettings[K],
  ): void {
    target[key] = value;
  }

  // 先读 JSON 覆盖
  const jsonOverrides: Partial<HeavyIoSettings> = {};
  const path = configFilePath(dataDir);
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const key of Object.keys(DEFAULT_HEAVY_IO_SETTINGS) as (keyof HeavyIoSettings)[]) {
        if (parsed[key] !== undefined) {
          setFieldInto(jsonOverrides, key, parsed[key] as HeavyIoSettings[typeof key]);
        }
      }
    } catch {
      // 损坏降级
    }
  }

  // 按优先级链合并
  const keys = Object.keys(DEFAULT_HEAVY_IO_SETTINGS) as (keyof HeavyIoSettings)[];
  for (const key of keys) {
    if (jsonOverrides[key] !== undefined) {
      setField(key, jsonOverrides[key]!);
      sources[key] = "json";
    } else {
      const envVal = process.env[envMap[key]];
      if (envVal !== undefined && envVal !== "") {
        setField(key, envVal as HeavyIoSettings[typeof key]);
        sources[key] = "env";
      } else {
        setField(key, DEFAULT_HEAVY_IO_SETTINGS[key]);
        sources[key] = "default";
      }
    }
  }

  return { settings: result, sources };
}

/** 持久化设置（覆盖写 JSON 文件）。 */
export function saveHeavyIoSettings(
  settings: HeavyIoSettings,
  dataDir: string = getDataDir(),
): void {
  const dir = resolve(dataDir, "config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(configFilePath(dataDir), JSON.stringify(settings, null, 2), "utf8");
}

/** 应用部分更新（合并到现有 JSON），返回合并后的完整设置。 */
export function patchHeavyIoSettings(
  patch: HeavyIoSettingsPatch,
  dataDir: string = getDataDir(),
): { settings: HeavyIoSettings; sources: Record<string, "json" | "env" | "default"> } {
  const current = loadHeavyIoSettings(dataDir).settings;
  const merged: HeavyIoSettings = { ...current, ...patch } as HeavyIoSettings;
  saveHeavyIoSettings(merged, dataDir);
  // 重新解析以获取 source（写后所有 json 覆盖项 source=json）
  return loadHeavyIoSettings(dataDir);
}
