/**
 * 端口默认值集中配置（避免 8787/8788/8789/5173/5174 散落字面量）。
 *
 * 设计目的：let-it-flow 多 App（内核 + nexusops + ai-content-factory）各自
 * 跑 Hono 后端 + Vite 前端，端口分布复杂。集中到一处便于：
 *   - 查看端口拓扑一眼明白
 *   - 改端口只改一处（之前散落在 vite.config.ts / server/index.ts / scripts）
 *
 * 优先级：环境变量（PORT / NEXUS_PORT / AICF_PORT / ...）> 本文件默认值。
 *
 * 注：前端 Vite dev server 端口（5173/5174）也在此声明，
 *     因为 scripts/start-aicf.ts 会用 vite --port 启动。
 */

/** 内核主服务（src/server.ts）后端端口。env: PORT。 */
export const CORE_PORT = Number(process.env.PORT ?? 8787);

/** NexusOps 后端端口。env: NEXUS_PORT / PORT。 */
export const NEXUS_PORT = Number(process.env.NEXUS_PORT ?? process.env.PORT ?? 8788);

/** AI Content Factory 后端端口。env: AICF_PORT / PORT。 */
export const AICF_PORT = Number(process.env.AICF_PORT ?? process.env.PORT ?? 8789);

/** 内核前端 Vite dev server 端口。 */
export const CORE_WEB_PORT = 5173;

/** AI Content Factory 前端 Vite dev server 端口。 */
export const AICF_WEB_PORT = 5174;

/**
 * 各服务本地 dev URL（vite.config.ts 代理 target 用）。
 * env 覆盖：LIF_BACKEND_URL / NEXUS_BACKEND_URL / AICF_BACKEND_URL。
 */
export const DEV_BACKEND_URLS = {
  /** 内核后端。 */
  core: process.env.LIF_BACKEND_URL ?? `http://localhost:${CORE_PORT}`,
  /** NexusOps 后端。 */
  nexusops: process.env.NEXUS_BACKEND_URL ?? `http://localhost:${NEXUS_PORT}`,
  /** AI Content Factory 后端。 */
  aicf: process.env.AICF_BACKEND_URL ?? `http://localhost:${AICF_PORT}`,
} as const;
