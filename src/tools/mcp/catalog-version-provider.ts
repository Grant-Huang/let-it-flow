/**
 * Catalog 版本提供器接口（R8 content 驱动刷新）。
 *
 * 解决问题：McpCatalogCache 的 warmup(force=true) 是"全量拉取 + 全量持久化"，
 * 在定时刷新场景下浪费网络/IO——如果 mestar catalog 没变化，应该跳过刷新。
 *
 * 设计：
 *   - 抽象 CatalogVersionProvider 接口，应用注入具体实现（如 ETag / Last-Modified / hash）
 *   - 平台提供 NoopVersionProvider：总返回 undefined，强制全量（向后兼容默认行为）
 *   - mcp-catalog-cache 的 refreshIfChanged 据此决定是否跳过
 *
 * 应用接入示例：
 *   const versionProvider = new HttpETagVersionProvider(...);
 *   await cache.refreshIfChanged(versionProvider);
 *
 * 若应用无版本感知能力（默认），warmup 行为与原版完全一致。
 */

/**
 * Catalog 版本提供器：返回当前 catalog 的版本指纹。
 *
 * 不同实现的取舍：
 *   - HTTP ETag / Last-Modified：网络层轻量，但要求 mestar 暴露 HEAD 接口或 catalog.search 返回版本头
 *   - catalog.search 的 hash：内容驱动，准确但需先拉取一次
 *   - 外部版本号（如 mestar 管理后台的 releaseId）：最准，要求 mestar 提供版本 API
 */
export interface CatalogVersionProvider {
  /**
   * 取当前 catalog 的版本指纹。
   *
   * @returns 版本字符串（ETag / hash / releaseId 等）；undefined 表示"无法判断，请全量刷新"。
   *          与上次的版本相同 → 缓存层跳过刷新。
   */
  getVersion(): Promise<string | undefined>;
}

/**
 * Noop 版本提供器：始终返回 undefined。
 *
 * 平台默认实现，让 refreshIfChanged 走全量刷新路径——
 * 与现有 NexusOps 行为完全一致（向后兼容）。
 *
 * 用途：
 *   - 应用未注入版本提供器时的兜底
 *   - 单测验证"未配置版本感知时行为不变"
 */
export class NoopVersionProvider implements CatalogVersionProvider {
  async getVersion(): Promise<string | undefined> {
    return undefined;
  }
}
