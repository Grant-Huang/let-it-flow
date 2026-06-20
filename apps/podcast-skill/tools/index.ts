/**
 * Podcast-skill 应用工具。
 * 暂时复用 core.web_search / core.web_fetch / kb.search。
 * 后续可加 domain.* 工具（如 RSS feed、播客平台 API）。
 */

import type { ToolRegistry } from "../../../src/agent/types.js";

export function buildPodcastSkillTools(registry: ToolRegistry): ToolRegistry {
  // 当前直接复用平台内置工具
  // 若需扩展，可在此注册 domain.* 工具
  return registry;
}
