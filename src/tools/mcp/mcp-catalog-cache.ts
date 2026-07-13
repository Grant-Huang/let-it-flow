/**
 * McpCatalogCache —— 大目录型 MCP server 的预热缓存层（07-mestar-integration-spec.md §5）。
 *
 * 解决问题：mestar 等 catalog 驱动的 MCP server 背后有数千个候选工具，
 * 全量注册会导致 LLM context 爆炸。本层在 boot 时分页拉取全量 catalog，
 * 按 domain 分桶缓存，让 ToolResolver 按需定位。
 *
 * 三份产出（见文档 §3）：
 *   A. module-map.json    —— 模块目录（喂 LLM，<2K token）
 *   B. 追加到 tool-index.json —— 语义索引（IndexToolResolver 本地命中）
 *   C. by-module/*.json   —— 分桶清单（LlmToolResolver 域内选择）
 *
 * 数据契约：对齐 mestar v0.2.0 实际返回字段（catalog item 自带 semanticTags /
 * exampleQueries / inputSummary / domain 等，route 字段对 readOnly 工具常为 null）。
 *
 * 降级原则：mestar 不可达时使用过期缓存或跳过，不阻塞 boot。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { McpClient, McpToolCallResult } from "./mcp-client.js";
import type { CatalogVersionProvider } from "./catalog-version-provider.js";
import type { EntrySource } from "../../orchestrator/tool-resolver.js";

// ── 数据类型（对齐 mestar catalog.search 返回的 item 结构） ──

/** 入参字段摘要（服务自带的中文字段清单，替代 build_params 的黑盒）。 */
export interface InputFieldSummary {
  name: string;
  label: string;
  type: string;
  required: boolean;
  /** 枚举/外键字段的候选选项（可选）。 */
  options?: string[];
}

/** 出参字段摘要。 */
export interface OutputFieldSummary {
  name: string;
  label: string;
  type: string;
}

/** catalog 单项（对齐 mestar v0.2.0 实际返回字段）。 */
export interface CatalogItem {
  name: string;
  /** 旧名（mestar.query.xxx.platform.select 形态，便于兼容历史调用）。 */
  legacyName?: string;
  /** 内部工具 id（与 legacyName 通常一致）。 */
  internalToolId?: string;
  title: string;
  /** 中文友好名（如"查询项目基本档案"，比 title 更适合喂 LLM）。 */
  displayName?: string;
  description: string;
  /** 业务域：Equipment / Quality / Production / Maintenance / ...（★ 比 module 更适合 LLM）。 */
  domain?: string;
  subDomain?: string;
  /** 服务自带的语义标签（中文，如 ["项目基本档案","ProductUnit"]）。 */
  semanticTags?: string[];
  /** 同义词（Embedding 质量增强）。 */
  aliases?: string[];
  /** 能力标签（如 ["Query"]）。 */
  capabilityLabels?: string[];
  /** LLM 选择时的最佳提示语（中文自然语言）。 */
  exampleQueries?: string[];
  /** 入参中文字段清单（替代 build_params 的黑盒）。 */
  inputSummary?: InputFieldSummary[];
  /** 出参字段清单。 */
  outputSummary?: OutputFieldSummary[];
  /** 服务自评的语义质量：ok / warn。 */
  semanticQuality?: string;
  kind: string;                  // platformController / templateAction
  risk: string;                  // readOnly / businessCritical
  executable: boolean;
  /** route 字段对 readOnly 查询工具常为 null（实测），派生逻辑不应依赖它。 */
  route?: {
    adapter?: string;
    bean?: string;
    method?: string;
    entity?: string;
  } | null;
  menu?: {
    name?: string;
    rel?: string;
  };
  menuKey?: string;
  templateGroup?: { code?: string; name?: string };
  templateGroupKey?: string;
  module?: {
    name?: string;
    source?: string;
  };
  moduleKey?: string;
  sourceGridId?: string;
}

/** 模块地图条目。 */
export interface ModuleMapEntry {
  name: string;
  desc: string;
  toolCount: number;
  executableCount: number;
}

/** 模块地图（A 缓存）。 */
export interface ModuleMap {
  serverId: string;
  generatedAt: string;
  totalTools: number;
  totalExecutable: number;
  modules: ModuleMapEntry[];
  /** 按业务域聚合的统计（L3：systemPrompt 按 domain 分组用）。 */
  domains: Array<{ name: string; toolCount: number; executableCount: number }>;
}

/** 分桶清单项（C 缓存，精简到 LLM 选择 + Embedding 检索所需字段）。 */
export interface BucketItem {
  name: string;
  title: string;
  /** 中文友好名。 */
  displayName?: string;
  desc: string;
  triggers: string[];
  /** 服务自带的中文语义标签。 */
  semanticTags?: string[];
  /** 同义词（Embedding 检索增强）。 */
  aliases?: string[];
  /** LLM 选择提示语。 */
  exampleQueries?: string[];
  /** 入参字段清单（LazyMcpActionTool 提示参数用）。 */
  inputSummary?: InputFieldSummary[];
  /** 业务域。 */
  domain?: string;
  risk: string;
}

/** 分桶清单文件结构。 */
export interface BucketFile {
  serverId: string;
  module: string;
  generatedAt: string;
  items: BucketItem[];
}

// ── 派生：semanticTags（优先消费服务自带，删除 route 依赖） ──

/**
 * 派生 semanticTags（D14 改造版）。
 *
 * 优先级（实测服务已自带高质量 semanticTags，覆盖率 100%）：
 *   ① 服务自带的 semanticTags（直接用）
 *   ② exampleQueries 派生（中文短句作为语义标签）
 *   ③ domain + module 兜底（删除 route.method 依赖，因为 readOnly 工具 route 常为 null）
 *
 * 只处理 executable=true + readOnly 的查询工具。
 */
export function deriveSemantic(item: CatalogItem): string[] {
  if (!item.executable || item.risk !== "readOnly") return [];

  // ① 优先：服务自带的 semanticTags（质量最高，实测全覆盖）
  if (item.semanticTags && item.semanticTags.length > 0) {
    return item.semanticTags;
  }

  // ② 次优：从 exampleQueries 派生（中文短句作为语义标签）
  if (item.exampleQueries && item.exampleQueries.length > 0) {
    return item.exampleQueries.slice(0, 3);
  }

  // ③ 兜底：domain + module（删除 route.method 依赖）
  const domain = item.domain?.toLowerCase() ?? item.module?.name?.toLowerCase();
  if (domain) {
    return [`${domain}_query`];
  }
  return [];
}

/**
 * 派生英文 snake_case semantic key（供 IndexToolResolver 精确命中）。
 *
 * 与 deriveSemantic 的区别：deriveSemantic 返回中文标签（喂 Embedding/LLM），
 * 本函数返回英文 key（喂 IndexToolResolver 的 entries 索引）。
 * 形成"中文 semanticTags + 英文 entries"双 tag 体系。
 */
export function deriveEnglishSemantic(item: CatalogItem): string | null {
  if (!item.executable || item.risk !== "readOnly") return null;

  // domain_subDomain 形态（如 equipment_general / quality_inspection）
  const domain = item.domain?.toLowerCase();
  const sub = item.subDomain?.toLowerCase();
  if (domain && sub && sub !== "general") {
    return `${domain}_${sub}`;
  }
  if (domain) {
    return domain;
  }
  // 兜底：module
  if (item.module?.name) {
    return item.module.name.toLowerCase();
  }
  return null;
}

// ── McpCatalogCache 实现 ──

/** 构造选项。 */
export interface McpCatalogCacheOptions {
  /** MCP server id（如 "mestar"）。 */
  serverId: string;
  /** 已连接的 MCP 客户端。 */
  client: McpClient;
  /** catalog 模式配置（来自 McpServerConfig.catalog）。 */
  pageSize?: number;
  /** 缓存根目录（缺省 data/mcp-catalog-cache）。 */
  cacheRoot?: string;
  /** tool-index.json 路径（缺省 data/relos-mock/tool-index.json，对齐 IndexToolResolver）。 */
  toolIndexPath?: string;
}

/** 版本指纹持久化文件结构（R8：版本感知刷新）。 */
interface VersionFingerprintFile {
  version: string;
  /** 上次刷新时拿到的 catalog 版本指纹。 */
  fingerprint?: string;
  updatedAt?: string;
}

/** 版本指纹文件名（存在 cacheDir 下）。 */
const VERSION_FINGERPRINT_FILE = "version.json";

/**
 * catalog 预热缓存。
 *
 * 使用方式：
 *   const cache = new McpCatalogCache({ serverId, client });
 *   await cache.warmup();        // 启动时同步预热
 *   cache.getModuleMap();        // 取模块地图（注入 prompt）
 *   cache.getBucket("Uemp");     // 取某模块分桶清单（域内 LLM 选择）
 *   cache.findItem(name);        // 按工具名查 catalog item（LazyMcpActionTool 用）
 */
export class McpCatalogCache {
  readonly serverId: string;
  private readonly client: McpClient;
  private readonly pageSize: number;
  private readonly cacheDir: string;
  private readonly toolIndexPath: string;

  /** 内存中的全量 catalog（warmup 后填充）。 */
  private items: CatalogItem[] = [];
  /** 模块地图（内存缓存）。 */
  private moduleMap: ModuleMap | null = null;
  /** 是否已就绪（warmup 成功）。 */
  private ready = false;
  /** 工具名 → CatalogItem 索引（findItem 用）。 */
  private itemIndex = new Map<string, CatalogItem>();

  constructor(opts: McpCatalogCacheOptions) {
    this.serverId = opts.serverId;
    this.client = opts.client;
    this.pageSize = opts.pageSize ?? 200;
    const root = opts.cacheRoot ?? "data/mcp-catalog-cache";
    this.cacheDir = join(root, opts.serverId);
    this.toolIndexPath = opts.toolIndexPath ?? "data/relos-mock/tool-index.json";
  }

  /** 是否已就绪。 */
  isReady(): boolean {
    return this.ready;
  }

  /** 取模块地图（注入 systemPrompt 用）。未就绪返回 null。 */
  getModuleMap(): ModuleMap | null {
    return this.moduleMap;
  }

  /** 按工具名查 catalog item（LazyMcpActionTool 用 inputSummary 时查）。 */
  findItem(name: string): CatalogItem | undefined {
    return this.itemIndex.get(name);
  }

  /**
   * 版本感知刷新（R8）：仅当 catalog 版本变化时才走全量拉取。
   *
   * 设计：
   *   - 调 versionProvider.getVersion() 取当前 catalog 版本
   *   - 与本地 version.json 里记录的上次指纹对比
   *   - 相同 → 跳过拉取（仅更新 ready 状态 + 本地缓存加载）
   *   - 不同或任一为 undefined → 走 warmup(force=true) 全量刷新
   *   - 刷新成功后把新指纹写入 version.json
   *
   * 向后兼容：versionProvider 为 NoopVersionProvider（或缺省）时，
   * getVersion() 始终返回 undefined → 永远走全量刷新（与现有行为一致）。
   *
   * @param versionProvider  版本提供器（默认 NoopVersionProvider，全量刷新）
   * @param maxAgeMs         warmup 时的本地缓存最大年龄（透传给 warmup）
   * @returns                true=发生了实际刷新；false=跳过（版本未变）
   */
  async refreshIfChanged(
    versionProvider?: CatalogVersionProvider,
    maxAgeMs = 24 * 60 * 60 * 1000,
  ): Promise<boolean> {
    // 缺省走 NoopVersionProvider（全量刷新，向后兼容）
    const provider = versionProvider;
    const currentVersion = provider ? await provider.getVersion() : undefined;

    // 无版本提供器或无法判断版本 → 走全量刷新（保持原行为）
    if (currentVersion === undefined) {
      await this.warmup(maxAgeMs, true);
      return true;
    }

    // 与本地记录的指纹对比
    const lastVersion = this.readVersionFingerprint();
    if (lastVersion === currentVersion) {
      // 版本未变，跳过拉取；只确保 ready=true（本地缓存若存在则加载）
      if (!this.ready) {
        this.loadLocalCache();
        this.ready = true;
      }
      console.log(
        `[mcp-catalog-cache] ${this.serverId} catalog 版本未变（${currentVersion}），跳过刷新`,
      );
      return false;
    }

    // 版本变化 → 全量刷新
    await this.warmup(maxAgeMs, true);
    // 刷新成功才更新指纹（warmup 失败时不覆盖）
    if (this.ready) {
      this.writeVersionFingerprint(currentVersion);
    }
    return true;
  }

  /** 读取本地版本指纹。无文件返回 undefined。 */
  private readVersionFingerprint(): string | undefined {
    const path = join(this.cacheDir, VERSION_FINGERPRINT_FILE);
    if (!existsSync(path)) return undefined;
    try {
      const data = JSON.parse(readFileSync(path, "utf8")) as VersionFingerprintFile;
      return data.fingerprint;
    } catch {
      return undefined;
    }
  }

  /** 写入版本指纹（刷新成功后调用）。 */
  private writeVersionFingerprint(fingerprint: string): void {
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      const data: VersionFingerprintFile = {
        version: "1.0",
        fingerprint,
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(join(this.cacheDir, VERSION_FINGERPRINT_FILE), JSON.stringify(data, null, 2));
    } catch {
      // 写入失败不阻塞主流程
    }
  }

  /** 取某模块的分桶清单（域内 LLM 选择用）。未就绪或无该模块返回空数组。 */
  getBucket(moduleName: string): BucketItem[] {
    if (!this.ready) return [];
    const path = join(this.cacheDir, "by-module", `${moduleName}.json`);
    if (!existsSync(path)) return [];
    try {
      const raw = readFileSync(path, "utf8");
      const data = JSON.parse(raw) as BucketFile;
      return data.items ?? [];
    } catch {
      return [];
    }
  }

  /** 取全部分桶的工具清单（EmbeddingToolRouter 构建向量索引用）。 */
  getAllBuckets(): BucketItem[] {
    if (!this.ready) return [];
    const dir = join(this.cacheDir, "by-module");
    if (!existsSync(dir)) return [];
    const out: BucketItem[] = [];
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = readFileSync(join(dir, file), "utf8");
        const data = JSON.parse(raw) as BucketFile;
        out.push(...(data.items ?? []));
      } catch {
        // 单文件损坏跳过
      }
    }
    return out;
  }

  /**
   * 追加一条 semantic → toolName 映射到 tool-index.json（在线兜底回写）。
   *
   * 供 CatalogSearchResolver 在线命中后调用，下次走 IndexToolResolver 命中。
   * 幂等：toolName 已存在则跳过。
   */
  appendToolEntry(toolName: string, semantic: string): void {
    let existing: ToolIndexFile;
    try {
      if (existsSync(this.toolIndexPath)) {
        const raw = readFileSync(this.toolIndexPath, "utf8");
        existing = JSON.parse(raw) as ToolIndexFile;
      } else {
        // 文件不存在时创建骨架（在线兜底首次回写）
        mkdirSync(dirname(this.toolIndexPath), { recursive: true });
        existing = { version: "1.0", enterprise: "nexusops-mock", tools: [], entries: [] };
      }
      // 已存在则跳过
      if (existing.tools.some((t) => t.name === toolName)) return;
      existing.tools = existing.tools ?? [];
      existing.entries = existing.entries ?? [];
      existing.tools.push({
        name: toolName,
        description: `在线 catalog 兜底发现：${semantic}`,
        semanticTags: [semantic],
      });
      existing.entries.push({
        semantic,
        toolName,
        primary: true,
        source: "derived_catalog",
        confidence: 0.9,
      });
      existing.syncedAt = new Date().toISOString();
      writeFileSync(this.toolIndexPath, JSON.stringify(existing, null, 2));
      console.log(
        `[mcp-catalog-cache] ${this.serverId} 在线兜底回写：${toolName} → ${semantic}`,
      );
    } catch {
      // 回写失败不影响主流程
    }
  }

  /**
   * 启动预热（文档 §5.1 时序）。
   *
   * 策略：
   *   1. 本地缓存存在且未过期 → 直接加载（fast path）
   *   2. 缓存不存在/过期 → 分页拉取 catalog + 派生 + 持久化（slow path）
   *   3. mestar 不可达但有本地缓存 → 用过期缓存（降级）
   *   4. mestar 不可达且无缓存 → 跳过（ready=false，不阻塞 boot）
   *
   * @param maxAgeMs  本地缓存多少毫秒内视为新鲜（缺省 24h）。fast path 的判据。
   * @param force     强制走 slow path（忽略本地缓存年龄，全量重拉）。
   *                  定时刷新场景必须传 true，否则 fast path 会吞掉刷新。
   */
  async warmup(maxAgeMs = 24 * 60 * 60 * 1000, force = false): Promise<void> {
    // 1. 尝试加载本地缓存
    const localLoaded = this.loadLocalCache();
    if (!force && localLoaded) {
      const cacheAge = this.getCacheAge();
      if (cacheAge !== null && cacheAge < maxAgeMs) {
        // 未过期，直接用
        this.ready = true;
        return;
      }
      // 过期，尝试后台刷新（这里同步刷新，失败则用过期缓存）
    }

    // 2. 分页拉取 catalog
    try {
      await this.fetchAndPersist();
      this.ready = true;
    } catch (e) {
      // mestar 不可达
      if (localLoaded) {
        // 有过期缓存，降级使用
        console.warn(
          `[mcp-catalog-cache] ${this.serverId} catalog 拉取失败，使用过期缓存：${e instanceof Error ? e.message : String(e)}`,
        );
        this.ready = true;
      } else {
        // 无缓存，跳过（不阻塞 boot）
        console.warn(
          `[mcp-catalog-cache] ${this.serverId} catalog 拉取失败且无本地缓存，跳过预热：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  /** 从本地缓存加载（module-map.json + by-module/*.json）。 */
  private loadLocalCache(): boolean {
    const mapPath = join(this.cacheDir, "module-map.json");
    if (!existsSync(mapPath)) return false;
    try {
      const raw = readFileSync(mapPath, "utf8");
      this.moduleMap = JSON.parse(raw) as ModuleMap;
      // 加载 by-module 重建 itemIndex（供 findItem 用）
      this.rebuildItemIndexFromBuckets();
      return true;
    } catch {
      return false;
    }
  }

  /** 从 by-module/*.json 重建 itemIndex + items（本地缓存 fast path 用）。 */
  private rebuildItemIndexFromBuckets(): void {
    this.itemIndex.clear();
    this.items = [];
    const dir = join(this.cacheDir, "by-module");
    if (!existsSync(dir)) return;
    // 注意：by-module 只存了 executable 工具的精简字段（BucketItem），
    // 这里只重建 itemIndex 的最小信息（findItem 主要查 inputSummary/domain 等）
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = readFileSync(join(dir, file), "utf8");
        const data = JSON.parse(raw) as BucketFile;
        for (const b of data.items ?? []) {
          // BucketItem → CatalogItem 的最小还原（findItem 只需 name/inputSummary/domain 等）
          this.itemIndex.set(b.name, {
            name: b.name,
            title: b.title,
            displayName: b.displayName,
            description: b.desc,
            kind: "platformController",
            risk: b.risk,
            executable: true,
            semanticTags: b.semanticTags,
            aliases: b.aliases,
            exampleQueries: b.exampleQueries,
            inputSummary: b.inputSummary,
            domain: b.domain,
          });
        }
      } catch {
        // 单文件损坏跳过
      }
    }
  }

  /** 计算缓存年龄（ms）。无 generatedAt 返回 null。 */
  private getCacheAge(): number | null {
    if (!this.moduleMap?.generatedAt) return null;
    const generated = Date.parse(this.moduleMap.generatedAt);
    if (Number.isNaN(generated)) return null;
    return Date.now() - generated;
  }

  /** 分页拉取 catalog + 派生 + 持久化。 */
  private async fetchAndPersist(): Promise<void> {
    const items: CatalogItem[] = [];
    let cursor: string | undefined;
    let total = 0;

    // 分页循环（mestar.catalog.search 用 cursor 翻页）
    do {
      const result = await this.callCatalogSearch({ limit: this.pageSize, cursor });
      const batch = result.items ?? [];
      items.push(...batch);
      total = result.total ?? items.length;
      cursor = result.nextCursor;
      // 安全阀：拉取数量不超过 total + pageSize（防 server 端 bug 死循环）
      if (items.length > total + this.pageSize) break;
    } while (cursor);

    this.items = items;

    // 派生 semanticTags（优先用服务自带，删除 route 依赖）
    for (const item of items) {
      const derived = deriveSemantic(item);
      // 服务自带 tag 优先；若无则用派生结果覆盖
      if (!item.semanticTags || item.semanticTags.length === 0) {
        item.semanticTags = derived;
      }
    }

    // 构建 itemIndex（findItem 用）
    this.itemIndex.clear();
    for (const item of items) {
      this.itemIndex.set(item.name, item);
    }

    // 分桶 + 持久化
    this.buildAndPersistModuleMap(items);
    this.persistBuckets(items);
    this.persistToToolIndex(items);

    console.log(
      `[mcp-catalog-cache] ${this.serverId} 预热完成：${items.length} 个工具，` +
        `${items.filter((i) => i.executable).length} 个可执行，` +
        `${this.moduleMap?.modules.length ?? 0} 个模块，` +
        `${this.moduleMap?.domains.length ?? 0} 个业务域`,
    );
  }

  /** 调用 mestar.catalog.search（封装 MCP callTool）。 */
  private async callCatalogSearch(args: {
    limit: number;
    cursor?: string;
  }): Promise<{ items: CatalogItem[]; total: number; nextCursor?: string }> {
    const result: McpToolCallResult = await this.client.callTool("mestar.catalog.search", {
      limit: args.limit,
      ...(args.cursor ? { cursor: args.cursor } : {}),
    });

    // mestar 返回 structuredContent（catalog.search 的 outputSchema）
    const structured = (result as { structuredContent?: { items?: CatalogItem[]; total?: number; nextCursor?: string } }).structuredContent;
    if (structured && Array.isArray(structured.items)) {
      return {
        items: structured.items,
        total: structured.total ?? structured.items.length,
        nextCursor: structured.nextCursor,
      };
    }

    // 兜底：从 text content 解析（部分 server 可能只返回 text）
    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    try {
      const parsed = JSON.parse(text) as { items?: CatalogItem[]; total?: number; nextCursor?: string };
      return {
        items: parsed.items ?? [],
        total: parsed.total ?? 0,
        nextCursor: parsed.nextCursor,
      };
    } catch {
      return { items: [], total: 0 };
    }
  }

  /** 构建并持久化模块地图（A 缓存，含 domain 聚合统计）。 */
  private buildAndPersistModuleMap(items: CatalogItem[]): void {
    const moduleStats = new Map<string, { count: number; executable: number; sample?: CatalogItem }>();
    const domainStats = new Map<string, { count: number; executable: number }>();

    for (const item of items) {
      // module 统计
      const modName = item.module?.name ?? "Unknown";
      const mStat = moduleStats.get(modName) ?? { count: 0, executable: 0 };
      mStat.count++;
      if (item.executable) mStat.executable++;
      if (!mStat.sample) mStat.sample = item;
      moduleStats.set(modName, mStat);

      // domain 统计（L3：systemPrompt 按 domain 分组用）
      const domName = item.domain ?? "Other";
      const dStat = domainStats.get(domName) ?? { count: 0, executable: 0 };
      dStat.count++;
      if (item.executable) dStat.executable++;
      domainStats.set(domName, dStat);
    }

    const modules: ModuleMapEntry[] = [];
    for (const [name, stat] of moduleStats) {
      modules.push({
        name,
        desc: stat.sample?.displayName ?? stat.sample?.menu?.name ?? stat.sample?.title ?? name,
        toolCount: stat.count,
        executableCount: stat.executable,
      });
    }
    modules.sort((a, b) => b.toolCount - a.toolCount);

    const domains: Array<{ name: string; toolCount: number; executableCount: number }> = [];
    for (const [name, stat] of domainStats) {
      domains.push({ name, toolCount: stat.count, executableCount: stat.executable });
    }
    domains.sort((a, b) => b.toolCount - a.toolCount);

    this.moduleMap = {
      serverId: this.serverId,
      generatedAt: new Date().toISOString(),
      totalTools: items.length,
      totalExecutable: items.filter((i) => i.executable).length,
      modules,
      domains,
    };

    mkdirSync(this.cacheDir, { recursive: true });
    writeFileSync(join(this.cacheDir, "module-map.json"), JSON.stringify(this.moduleMap, null, 2));
  }

  /** 按 module 分桶持久化（C 缓存），只存 executable=true 的工具。 */
  private persistBuckets(items: CatalogItem[]): void {
    const bucketDir = join(this.cacheDir, "by-module");
    mkdirSync(bucketDir, { recursive: true });

    // 按 module 分组
    const groups = new Map<string, BucketItem[]>();
    for (const item of items) {
      if (!item.executable) continue; // 只缓存可执行工具
      const modName = item.module?.name ?? "Unknown";
      const bucket: BucketItem = {
        name: item.name,
        title: item.title,
        ...(item.displayName ? { displayName: item.displayName } : {}),
        desc: item.description,
        triggers: this.inferTriggers(item),
        ...(item.semanticTags && item.semanticTags.length > 0 ? { semanticTags: item.semanticTags } : {}),
        ...(item.aliases && item.aliases.length > 0 ? { aliases: item.aliases } : {}),
        ...(item.exampleQueries && item.exampleQueries.length > 0 ? { exampleQueries: item.exampleQueries } : {}),
        ...(item.inputSummary && item.inputSummary.length > 0 ? { inputSummary: item.inputSummary } : {}),
        ...(item.domain ? { domain: item.domain } : {}),
        risk: item.risk,
      };
      const list = groups.get(modName) ?? [];
      list.push(bucket);
      groups.set(modName, list);
    }

    for (const [modName, list] of groups) {
      const data: BucketFile = {
        serverId: this.serverId,
        module: modName,
        generatedAt: new Date().toISOString(),
        items: list,
      };
      writeFileSync(join(bucketDir, `${modName}.json`), JSON.stringify(data, null, 2));
    }
  }

  /**
   * 追加 mestar 工具到 tool-index.json（B 缓存，IndexToolResolver 命中）。
   *
   * 双 tag 体系（L2.2）：
   *   - tools[].semanticTags：服务原生中文 tag（供 Embedding/LlmToolResolver）
   *   - entries[]：派生的英文 snake_case key（供 IndexToolResolver 精确命中）
   */
  private persistToToolIndex(items: CatalogItem[]): void {
    // 只追加有语义信息且 executable 的工具
    const tagged = items.filter(
      (i) => i.executable && ((i.semanticTags && i.semanticTags.length > 0) || i.exampleQueries),
    );
    if (tagged.length === 0) return;

    // 读取现有 tool-index.json
    let existing: ToolIndexFile;
    try {
      if (existsSync(this.toolIndexPath)) {
        const raw = readFileSync(this.toolIndexPath, "utf8");
        existing = JSON.parse(raw) as ToolIndexFile;
      } else {
        mkdirSync(dirname(this.toolIndexPath), { recursive: true });
        existing = { version: "1.0", enterprise: "nexusops-mock", tools: [], entries: [] };
      }
    } catch {
      existing = { version: "1.0", enterprise: "nexusops-mock", tools: [], entries: [] };
    }

    existing.tools = existing.tools ?? [];
    existing.entries = existing.entries ?? [];

    // 已存在的工具名集合（避免重复追加）
    const existingNames = new Set(existing.tools.map((t) => t.name));
    const existingEntryKeys = new Set(existing.entries.map((e) => `${e.semantic}::${e.toolName}`));

    // 追加 mestar 工具
    let addedTools = 0;
    let addedEntries = 0;
    for (const item of tagged) {
      if (!existingNames.has(item.name)) {
        existing.tools.push({
          name: item.name,
          description: item.displayName ?? item.description,
          whenToUse: {
            triggers: this.inferTriggers(item),
            notFor: [],
          },
          semanticTags: item.semanticTags,
        });
        addedTools++;
      }

      // 多路 entries 写入（提升 IndexToolResolver 命中率）：
      //   ① 英文 domain_subDomain key（原有逻辑）
      //   ② 中文 semanticTags（新增：LLM 传中文业务名词时精确命中）
      //   ③ 中文 displayName（新增：最自然的中文查询入口）
      const semanticKeys = new Set<string>();

      // ① 英文 domain key
      const engKey = deriveEnglishSemantic(item);
      if (engKey) semanticKeys.add(engKey);

      // ② 中文 semanticTags（直接用，不转小写——中文无大小写问题）
      for (const tag of item.semanticTags ?? []) {
        if (tag && tag.length > 0) semanticKeys.add(tag);
      }

      // ③ 中文 displayName / title（作为额外的中文入口）
      const zhName = item.displayName ?? item.title;
      if (zhName && /[\u4e00-\u9fa5]/.test(zhName)) {
        semanticKeys.add(zhName);
      }

      for (const sKey of semanticKeys) {
        const entryKey = `${sKey}::${item.name}`;
        if (!existingEntryKeys.has(entryKey)) {
          existing.entries.push({
            semantic: sKey,
            toolName: item.name,
            primary: true,
            source: "derived_catalog",
            confidence: 0.9,
          });
          existingEntryKeys.add(entryKey);
          addedEntries++;
        }
      }
    }

    existing.syncedAt = new Date().toISOString();
    writeFileSync(this.toolIndexPath, JSON.stringify(existing, null, 2));
    if (addedTools > 0 || addedEntries > 0) {
      console.log(
        `[mcp-catalog-cache] ${this.serverId} 追加 ${addedTools} 个工具 + ${addedEntries} 个 entries 到 tool-index.json`,
      );
    }
  }

  /** 从 catalog item 推断 triggers（给 LLM 看的调用时机提示）。 */
  private inferTriggers(item: CatalogItem): string[] {
    const triggers: string[] = [];
    // 优先用 exampleQueries（中文自然语言，LLM 选择提示最佳）
    if (item.exampleQueries && item.exampleQueries.length > 0) {
      triggers.push(...item.exampleQueries.slice(0, 2));
    }
    // 补充 displayName / aliases
    if (item.displayName) triggers.push(item.displayName);
    if (item.aliases) triggers.push(...item.aliases.slice(0, 2));
    // 去重 + 截断
    const seen = new Set<string>();
    const deduped: string[] = [];
    for (const t of triggers) {
      if (!seen.has(t)) {
        seen.add(t);
        deduped.push(t);
      }
    }
    return deduped.slice(0, 4);
  }
}

// ── tool-index.json 文件结构（双 tag 体系） ──

/** tool-index.json 完整结构（tools 数组 + entries 数组）。 */
export interface ToolIndexFile {
  version: string;
  enterprise?: string;
  syncedAt?: string;
  /** tools 数组：含中文 semanticTags（供 Embedding/LlmToolResolver）。 */
  tools: Array<{
    name: string;
    description?: string;
    whenToUse?: { triggers: string[]; notFor: string[] };
    semanticTags?: string[];
  }>;
  /** entries 数组：英文 semantic key → toolName（供 IndexToolResolver 精确命中）。 */
  entries?: Array<{
    semantic: string;
    toolName: string;
    primary?: boolean;
    paramMap?: Record<string, string>;
    fieldMap?: Record<string, string>;
    /** 条目来源（消费方据此推断 confidence 缺省值）。 */
    source?: EntrySource;
    /** 置信度（写入方自定；缺省时由 source 推断）。 */
    confidence?: number;
  }>;
}
