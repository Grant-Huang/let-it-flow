/**
 * McpCatalogCache —— 大目录型 MCP server 的预热缓存层（07-mestar-integration-spec.md §5）。
 *
 * 解决问题：mestar 等 catalog 驱动的 MCP server 背后有数千个候选工具，
 * 全量注册会导致 LLM context 爆炸。本层在 boot 时分页拉取全量 catalog，
 * 按 module 分桶缓存，派生 semanticTags，让 ToolResolver 按需定位。
 *
 * 三份产出（见文档 §3）：
 *   A. module-map.json    —— 模块目录（喂 LLM，<2K token）
 *   B. 追加到 tool-index.json —— 语义索引（IndexToolResolver 本地命中）
 *   C. by-module/*.json   —— 分桶清单（LlmToolResolver 域内选择）
 *
 * 降级原则：mestar 不可达时使用过期缓存或跳过，不阻塞 boot。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { McpClient, McpToolCallResult } from "./mcp-client.js";

// ── 数据类型（对齐 mestar catalog.search 返回的 item 结构） ──

/** catalog 单项（精简后，只保留缓存需要的字段）。 */
export interface CatalogItem {
  name: string;
  title: string;
  description: string;
  kind: string;                  // platformController / templateAction
  risk: string;                  // readOnly / businessCritical
  executable: boolean;
  route?: {
    adapter?: string;
    bean?: string;
    method?: string;
    entity?: string;
  };
  menu?: {
    name?: string;
    rel?: string;
  };
  module?: {
    name?: string;
    source?: string;
  };
  /** 派生的语义标签（规则派生或 LLM 派生）。 */
  semanticTags?: string[];
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
}

/** 分桶清单项（C 缓存，精简到 LLM 选择所需字段）。 */
export interface BucketItem {
  name: string;
  title: string;
  desc: string;
  triggers: string[];
  semanticTags?: string[];
  risk: string;
}

/** 分桶清单文件结构。 */
export interface BucketFile {
  serverId: string;
  module: string;
  generatedAt: string;
  items: BucketItem[];
}

// ── 规则派生表（D14：启动时同步派生高频项） ──

/** module.name → semantic 前缀映射。 */
const MODULE_SEMANTIC_PREFIX: Record<string, string> = {
  Uemp: "device_",
  Mbb: "product_",
  Mbs: "product_",
  Ueop: "operation_",
  Ueqc: "quality_",
  Uswm: "material_",
  Umps: "process_",
  Uopp: "opportunity_",
};

/** route.method → semantic 后缀映射。 */
const METHOD_SEMANTIC_SUFFIX: Record<string, string> = {
  select: "query",
  commonSave: "save",
};

/**
 * 中文菜单名 → 英文 snake_case 键（规则派生用）。
 * 覆盖高频业务实体；未覆盖的返回 null（由 LLM 派生补全）。
 */
const MENU_BIZ_KEY: Record<string, string> = {
  设备BOM: "bom",
  设备档案: "profile",
  设备点检: "inspection",
  设备保养: "maintenance",
  设备故障: "failure",
  项目基本档案: "unit",
  产品档案: "product",
  工艺路线: "routing",
  工单: "work_order",
  物料主数据: "material",
  质量检验: "inspection",
  不良记录: "defect",
};

/** 把中文菜单名转换为业务语义键。 */
function transliterateMenuName(menuName?: string, title?: string): string | null {
  const src = menuName ?? title ?? "";
  if (!src) return null;
  // 精确匹配
  if (MENU_BIZ_KEY[src]) return MENU_BIZ_KEY[src];
  // 模糊匹配（包含关系）
  for (const [cn, en] of Object.entries(MENU_BIZ_KEY)) {
    if (src.includes(cn)) return en;
  }
  return null;
}

/**
 * 规则派生 semanticTags（D14 启动时同步）。
 * 只派生 executable=true + readOnly 的查询工具。
 * @returns semantic 数组（空数组表示未派生，标 unknown 待 LLM 补全）
 */
export function deriveSemantic(item: CatalogItem): string[] {
  if (!item.executable || item.risk !== "readOnly") return [];
  const prefix = item.module?.name ? MODULE_SEMANTIC_PREFIX[item.module.name] : undefined;
  if (!prefix) return [];
  const suffix = item.route?.method ? (METHOD_SEMANTIC_SUFFIX[item.route.method] ?? "query") : "query";
  const bizKey = transliterateMenuName(item.menu?.name, item.title);
  if (!bizKey) return [];
  return [`${prefix}${bizKey}_${suffix}`];
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

/**
 * catalog 预热缓存。
 *
 * 使用方式：
 *   const cache = new McpCatalogCache({ serverId, client });
 *   await cache.warmup();        // 启动时同步预热
 *   cache.getModuleMap();        // 取模块地图（注入 prompt）
 *   cache.getBucket("Uemp");     // 取某模块分桶清单（域内 LLM 选择）
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
    let existing: {
      version: string;
      enterprise?: string;
      syncedAt?: string;
      tools: Array<{ name: string; description?: string; whenToUse?: { triggers: string[]; notFor: string[] }; semanticTags?: string[] }>;
    };
    try {
      if (existsSync(this.toolIndexPath)) {
        const raw = readFileSync(this.toolIndexPath, "utf8");
        existing = JSON.parse(raw);
      } else {
        // 文件不存在时创建骨架（在线兜底首次回写）
        mkdirSync(dirname(this.toolIndexPath), { recursive: true });
        existing = { version: "1.0", enterprise: "nexusops-mock", tools: [] };
      }
      // 已存在则跳过
      if (existing.tools.some((t) => t.name === toolName)) return;
      existing.tools.push({
        name: toolName,
        description: `在线 catalog 兜底发现：${semantic}`,
        semanticTags: [semantic],
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
   */
  async warmup(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
    // 1. 尝试加载本地缓存
    const localLoaded = this.loadLocalCache();
    if (localLoaded) {
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
      return true;
    } catch {
      return false;
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

    // 派生 semanticTags（规则派生，同步）
    for (const item of items) {
      item.semanticTags = deriveSemantic(item);
    }

    // 分桶 + 持久化
    this.buildAndPersistModuleMap(items);
    this.persistBuckets(items);
    this.persistToToolIndex(items);

    console.log(
      `[mcp-catalog-cache] ${this.serverId} 预热完成：${items.length} 个工具，` +
        `${items.filter((i) => i.executable).length} 个可执行，` +
        `${this.moduleMap?.modules.length ?? 0} 个模块`,
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

  /** 构建并持久化模块地图（A 缓存）。 */
  private buildAndPersistModuleMap(items: CatalogItem[]): void {
    const moduleStats = new Map<string, { count: number; executable: number; sample?: CatalogItem }>();
    for (const item of items) {
      const modName = item.module?.name ?? "Unknown";
      const stat = moduleStats.get(modName) ?? { count: 0, executable: 0 };
      stat.count++;
      if (item.executable) stat.executable++;
      if (!stat.sample) stat.sample = item;
      moduleStats.set(modName, stat);
    }

    const modules: ModuleMapEntry[] = [];
    for (const [name, stat] of moduleStats) {
      modules.push({
        name,
        desc: stat.sample?.menu?.name ?? stat.sample?.title ?? name,
        toolCount: stat.count,
        executableCount: stat.executable,
      });
    }
    // 按工具数降序
    modules.sort((a, b) => b.toolCount - a.toolCount);

    this.moduleMap = {
      serverId: this.serverId,
      generatedAt: new Date().toISOString(),
      totalTools: items.length,
      totalExecutable: items.filter((i) => i.executable).length,
      modules,
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
        desc: item.description,
        triggers: this.inferTriggers(item),
        ...(item.semanticTags && item.semanticTags.length > 0 ? { semanticTags: item.semanticTags } : {}),
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

  /** 追加 mestar 工具到 tool-index.json（B 缓存，IndexToolResolver 命中）。 */
  private persistToToolIndex(items: CatalogItem[]): void {
    // 只追加有 semanticTags 且 executable 的工具
    const tagged = items.filter(
      (i) => i.executable && i.semanticTags && i.semanticTags.length > 0,
    );
    if (tagged.length === 0) return;

    // 读取现有 tool-index.json
    let existing: { version: string; enterprise?: string; syncedAt?: string; tools: Array<{ name: string; description?: string; whenToUse?: { triggers: string[]; notFor: string[] }; semanticTags?: string[] }> };
    try {
      if (existsSync(this.toolIndexPath)) {
        const raw = readFileSync(this.toolIndexPath, "utf8");
        existing = JSON.parse(raw);
      } else {
        // 文件不存在，创建骨架
        mkdirSync(dirname(this.toolIndexPath), { recursive: true });
        existing = { version: "1.0", enterprise: "nexusops-mock", tools: [] };
      }
    } catch {
      existing = { version: "1.0", enterprise: "nexusops-mock", tools: [] };
    }

    // 已存在的工具名集合（避免重复追加）
    const existingNames = new Set(existing.tools.map((t) => t.name));

    // 追加 mestar 工具
    let added = 0;
    for (const item of tagged) {
      if (existingNames.has(item.name)) continue;
      existing.tools.push({
        name: item.name,
        description: item.description,
        whenToUse: {
          triggers: this.inferTriggers(item),
          notFor: [],
        },
        semanticTags: item.semanticTags,
      });
      added++;
    }

    existing.syncedAt = new Date().toISOString();
    writeFileSync(this.toolIndexPath, JSON.stringify(existing, null, 2));
    if (added > 0) {
      console.log(`[mcp-catalog-cache] ${this.serverId} 追加 ${added} 个工具到 tool-index.json`);
    }
  }

  /** 从 catalog item 推断 triggers（给 LLM 看的调用时机提示）。 */
  private inferTriggers(item: CatalogItem): string[] {
    const triggers: string[] = [];
    if (item.menu?.name) triggers.push(item.menu.name);
    if (item.title && item.title !== item.menu?.name) triggers.push(item.title);
    if (item.module?.name) triggers.push(item.module.name);
    // 取 description 前 40 字符作为补充
    if (item.description) triggers.push(item.description.slice(0, 40));
    return triggers.slice(0, 4); // 最多 4 个 trigger
  }
}
