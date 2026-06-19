import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getDataDir } from "./config.js";

/**
 * 系统设置：把散落的「魔法数字」（超时/管道/搜索/流式）集中管理。
 *
 * 设计要点（见配置页面方案 §三 页面2）：
 *   - 存储位置：{DATA_DIR}/config/system_settings.json
 *   - 优先级：JSON 文件 > 代码内 DEFAULT_SYSTEM_SETTINGS
 *   - 不热加载（按用户确认：仅模型配置热加载）；改后下次读取生效
 *   - 不含密钥、部署期项（那些留 env）
 *
 * 读取点改造：原硬编码字面量改为 getSystemSettings().xxx。
 */

/** 系统设置的完整类型（显式接口，放宽为 number/boolean 避免字面量类型过窄）。 */
export interface SystemSettings {
  // ── 超时 ──
  /** 重 IO 单步超时（ms）。原 900_000（15 分钟）。来源 rewrite/tts/image-gen/video-build/text-steps。 */
  heavyIoTimeoutMs: number;
  /** 子进程默认超时（ms）。原 600_000（10 分钟）。来源 subprocess-adapter。 */
  subprocessDefaultTimeoutMs: number;
  // ── 内容管道默认 ──
  /** 默认最大 token。原 4000。来源 dag-schema ContentPipelineConfig.maxTokens。 */
  contentMaxTokens: number;
  /** rewrite 节点专用最大 token。原 6000。来源 templates.ts rewrite 节点。 */
  contentRewriteMaxTokens: number;
  /** HTML/Markdown 净化开关。原 true。 */
  contentStrip: boolean;
  /** 滚动窗口摘要化开关。原 false（MVP 砍）。 */
  contentSummarize: boolean;
  /** 单页最大抓取字节。原 1_000_000（1MB）。来源 templates fetch 节点 + web-fetch。 */
  fetchMaxBytes: number;
  // ── 搜索 ──
  /** web_search 默认最大结果数。原 5。来源 web-search + planner heuristicParams。 */
  searchMaxResults: number;
  // ── 流式 ──
  /** SSE 长连接最大挂起时间（ms）。原 5*60*1000。来源 tasks.ts。 */
  sseDeadlineMs: number;
  /** SSE 轮询事件间隔（ms）。原 50。来源 tasks.ts。 */
  ssePollIntervalMs: number;
  /** content 通道缓冲自动 flush 阈值（条数）。原 8。来源 coalescer。 */
  coalescerMaxBuffer: number;
  /** content 缓冲自动 flush 阈值（ms）。原 50。来源 coalescer。 */
  coalescerMaxDelayMs: number;
}

/** 系统设置的默认值（默认值 = 改造前的硬编码值）。 */
export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  heavyIoTimeoutMs: 900_000,
  subprocessDefaultTimeoutMs: 600_000,
  contentMaxTokens: 4000,
  contentRewriteMaxTokens: 6000,
  contentStrip: true,
  contentSummarize: false,
  fetchMaxBytes: 1_000_000,
  searchMaxResults: 5,
  sseDeadlineMs: 5 * 60 * 1000,
  ssePollIntervalMs: 50,
  coalescerMaxBuffer: 8,
  coalescerMaxDelayMs: 50,
};

/** 部分更新类型（前端 PUT 用）。 */
export type SystemSettingsPatch = Partial<SystemSettings>;

const FILE_NAME = "system_settings.json";

/** 取配置目录。 */
function configFilePath(dataDir: string = getDataDir()): string {
  return join(dataDir, "config", FILE_NAME);
}

/** 读取设置：JSON 文件覆盖默认值；文件缺失/损坏降级到默认值（不抛错，保证启动健壮）。 */
export function loadSystemSettings(dataDir: string = getDataDir()): SystemSettings {
  const path = configFilePath(dataDir);
  if (!existsSync(path)) return { ...DEFAULT_SYSTEM_SETTINGS };
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<SystemSettings>;
    // 合并：未知字段忽略；已知字段类型校验
    const merged = { ...DEFAULT_SYSTEM_SETTINGS };
    for (const key of Object.keys(DEFAULT_SYSTEM_SETTINGS) as (keyof SystemSettings)[]) {
      const v = parsed[key];
      if (v !== undefined && typeof v === typeof DEFAULT_SYSTEM_SETTINGS[key]) {
        // 类型已对齐（number/boolean），直接赋值
        (merged as unknown as Record<string, unknown>)[key] = v;
      }
    }
    return merged;
  } catch {
    return { ...DEFAULT_SYSTEM_SETTINGS };
  }
}

/** 持久化设置（覆盖写）。 */
export function saveSystemSettings(settings: SystemSettings, dataDir: string = getDataDir()): void {
  const dir = resolve(dataDir, "config");
  mkdirSync(dir, { recursive: true });
  writeFileSync(configFilePath(dataDir), JSON.stringify(settings, null, 2), "utf8");
}

/** 应用部分更新，返回合并后的完整设置并落盘。 */
export function patchSystemSettings(
  patch: SystemSettingsPatch,
  dataDir: string = getDataDir(),
): SystemSettings {
  const current = loadSystemSettings(dataDir);
  const merged: SystemSettings = { ...current, ...patch } as SystemSettings;
  // 类型保护：确保 number/boolean 类型一致
  for (const key of Object.keys(DEFAULT_SYSTEM_SETTINGS) as (keyof SystemSettings)[]) {
    if (merged[key] !== undefined && typeof merged[key] !== typeof DEFAULT_SYSTEM_SETTINGS[key]) {
      throw new Error(`字段 ${key} 类型错误：期望 ${typeof DEFAULT_SYSTEM_SETTINGS[key]}`);
    }
  }
  saveSystemSettings(merged, dataDir);
  return merged;
}

// ── 便捷 getter（供硬编码读取点改造用，避免每次解构整个 settings）──

/** 重 IO 单步超时（ms）。 */
export function getHeavyIoTimeoutMs(): number {
  return loadSystemSettings().heavyIoTimeoutMs;
}

/** 子进程默认超时（ms）。 */
export function getSubprocessDefaultTimeoutMs(): number {
  return loadSystemSettings().subprocessDefaultTimeoutMs;
}

/** 内容管道默认 maxTokens。 */
export function getContentMaxTokens(): number {
  return loadSystemSettings().contentMaxTokens;
}

/** rewrite 节点专用 maxTokens。 */
export function getContentRewriteMaxTokens(): number {
  return loadSystemSettings().contentRewriteMaxTokens;
}

/** 内容管道默认 strip。 */
export function getContentStrip(): boolean {
  return loadSystemSettings().contentStrip;
}

/** 内容管道默认 summarize。 */
export function getContentSummarize(): boolean {
  return loadSystemSettings().contentSummarize;
}

/** 单页最大抓取字节。 */
export function getFetchMaxBytes(): number {
  return loadSystemSettings().fetchMaxBytes;
}

/** web_search 默认最大结果数。 */
export function getSearchMaxResults(): number {
  return loadSystemSettings().searchMaxResults;
}
