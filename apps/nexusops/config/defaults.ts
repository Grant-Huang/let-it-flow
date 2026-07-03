/**
 * NexusOps 默认业务标识集中配置。
 *
 * 把散落在 domain 工具 / scenarios / skills 中的硬编码产线 ID（"L01"）等
 * 默认业务标识收敛到一处，便于换部署时统一调整。
 *
 * 优先级：环境变量 > 本文件默认值。
 */

/**
 * 默认产线 ID。
 *
 * 散落引用点（domain 工具的 provenance / getData 兜底 / scenarios.resolveLine），
 * 全部应引用本常量。env: NEXUS_DEFAULT_LINE。
 */
export const DEFAULT_LINE: string = process.env.NEXUS_DEFAULT_LINE ?? "L01";
