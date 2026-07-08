/**
 * KpiCatalogCache —— KPI 元数据预热缓存（L1 KpiResolver 的数据源）。
 *
 * mestar v0.2.0 暴露了 KPI 体系，含三类工具：
 *   - mestar.kpi.search      —— KPI 目录（可预热）
 *   - mestar.kpi.assess      —— 评估某 KPI 在当前企业的可计算性
 *   - mestar.kpi.guide       —— 给出计算引导（替代方案/估算公式）
 *
 * 本层在 boot 时调用 kpi.search 预热 KPI 目录，产出：
 *   A. 内存索引（KPI id → KpiDescriptor），供 KpiResolver 快速判断"这是不是 KPI 类需求"
 *   B. kpi-catalog.json（持久化，mestar 不可达时降级用）
 *   C. systemPrompt 的 KPI 目录文本（注入 LLM，让它知道"有哪些指标可问"）
 *
 * 降级原则：kpi.search 不可达时使用过期缓存或跳过，不阻塞 boot。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpClient, McpToolCallResult } from "./mcp-client.js";

/** KPI 描述符（kpi.search 返回的单项）。 */
export interface KpiDescriptor {
  /** KPI 标识（如 "oee" / "fpy" / "dpu" / "mtbf"）。 */
  id: string;
  /** 中文显示名（如"设备综合效率"）。 */
  label: string;
  /** 业务域（Equipment / Quality / Production / ...）。 */
  domain?: string;
  /** 计算所需的 MES 数据维度（如 ["设备停机时长","计划工时","合格品数"]）。 */
  requiredDimensions?: string[];
  /** 别名（语义匹配用，如["OEE","设备效率","稼动率综合"]）。 */
  aliases?: string[];
  /** 简介。 */
  description?: string;
  /** 计算公式（人可读，如 "OEE = 可用率 × 性能率 × 良率"）。 */
  formula?: string;
  /** 单位（如 "%" / "次/件"）。 */
  unit?: string;
}

/** kpi-catalog.json 持久化结构。 */
export interface KpiCatalogFile {
  serverId: string;
  generatedAt: string;
  kpis: KpiDescriptor[];
}

/** 构造选项。 */
export interface KpiCatalogCacheOptions {
  serverId: string;
  client: McpClient;
  /** 缓存根目录（缺省 data/mcp-catalog-cache）。 */
  cacheRoot?: string;
}

/**
 * KPI 目录预热缓存。
 *
 * 使用方式：
 *   const kpi = new KpiCatalogCache({ serverId: "mestar", client });
 *   await kpi.warmup();
 *   kpi.findBySemantic("oee");       // 按语义标识查
 *   kpi.findByQuery("设备综合效率");  // 按中文查询查（含别名模糊匹配）
 *   kpi.getPromptCatalog();          // 取 systemPrompt 注入文本
 */
export class KpiCatalogCache {
  readonly serverId: string;
  private readonly client: McpClient;
  private readonly cacheDir: string;
  private readonly cachePath: string;

  /** KPI 目录（warmup 后填充）。 */
  private kpis: KpiDescriptor[] = [];
  /** id → KpiDescriptor 索引。 */
  private idIndex = new Map<string, KpiDescriptor>();
  /** 是否就绪。 */
  private ready = false;

  constructor(opts: KpiCatalogCacheOptions) {
    this.serverId = opts.serverId;
    this.client = opts.client;
    const root = opts.cacheRoot ?? "data/mcp-catalog-cache";
    this.cacheDir = join(root, opts.serverId);
    this.cachePath = join(this.cacheDir, "kpi-catalog.json");
  }

  /** 是否已就绪。 */
  isReady(): boolean {
    return this.ready;
  }

  /** 取全量 KPI 目录。 */
  getKpis(): KpiDescriptor[] {
    return this.kpis;
  }

  /** 按 KPI id 查（精确匹配）。 */
  findById(id: string): KpiDescriptor | undefined {
    return this.idIndex.get(id.toLowerCase());
  }

  /**
   * 按 KPI id 或别名查（语义匹配）。
   * 支持 "oee" / "OEE" / "设备综合效率" / "稼动率综合" 等多种形态。
   */
  findBySemantic(semantic: string): KpiDescriptor | undefined {
    // 防御：semantic 可能为 undefined（LLM 传了空对象）
    if (!semantic || typeof semantic !== "string") return undefined;
    const lower = semantic.toLowerCase();
    // ① id 精确匹配（大小写不敏感）
    const byId = this.idIndex.get(lower);
    if (byId) return byId;
    // ② 别名/label 模糊匹配
    for (const kpi of this.kpis) {
      if (kpi.aliases?.some((a) => typeof a === "string" && a.toLowerCase() === lower)) return kpi;
      if (kpi.label === semantic) return kpi;
    }
    // ③ label 包含关系（中文）
    for (const kpi of this.kpis) {
      const label = kpi.label;
      if (!label || typeof label !== "string") continue;
      if (label.includes(semantic) || semantic.includes(label)) return kpi;
    }
    return undefined;
  }

  /**
   * 取 systemPrompt 注入用的 KPI 目录文本（L3：注入 prompt）。
   *
   * 形如：
   *   - oee（设备综合效率）：可用率 × 性能率 × 良率，需要[设备停机时长,计划工时,合格品数]
   *   - fpy（一次合格率）：...
   */
  getPromptCatalog(): string {
    if (this.kpis.length === 0) return "";
    const lines: string[] = [];
    for (const kpi of this.kpis) {
      const label = kpi.label || kpi.id;
      const parts: string[] = [`${kpi.id}（${label}）`];
      if (kpi.formula) parts.push(`公式=${kpi.formula}`);
      if (kpi.requiredDimensions && kpi.requiredDimensions.length > 0) {
        parts.push(`需要[${kpi.requiredDimensions.join(",")}]`);
      }
      lines.push(`  - ${parts.join("；")}`);
    }
    return lines.join("\n");
  }

  /**
   * 启动预热。
   *
   * 策略：
   *   1. 本地缓存存在且未过期 → 直接加载（fast path）
   *   2. 缓存不存在/过期 → 调 kpi.search 拉取 + 持久化
   *   3. mestar 不可达但有本地缓存 → 用过期缓存降级
   *   4. mestar 不可达且无缓存 → 跳过（ready=false，不阻塞 boot）
   *
   * @param maxAgeMs  本地缓存多少毫秒内视为新鲜（缺省 24h）。
   * @param force     强制全量重拉（定时刷新场景传 true）。
   */
  async warmup(maxAgeMs = 24 * 60 * 60 * 1000, force = false): Promise<void> {
    const localLoaded = this.loadLocalCache();
    if (!force && localLoaded) {
      const age = this.getCacheAge();
      if (age !== null && age < maxAgeMs) {
        this.ready = true;
        return;
      }
    }

    try {
      await this.fetchAndPersist();
      this.ready = true;
    } catch (e) {
      if (localLoaded) {
        console.warn(
          `[kpi-catalog-cache] ${this.serverId} kpi.search 拉取失败，使用过期缓存：${e instanceof Error ? e.message : String(e)}`,
        );
        this.ready = true;
      } else {
        console.warn(
          `[kpi-catalog-cache] ${this.serverId} kpi.search 拉取失败且无本地缓存，跳过预热：${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
  }

  /** 从本地缓存加载。 */
  private loadLocalCache(): boolean {
    if (!existsSync(this.cachePath)) return false;
    try {
      const raw = readFileSync(this.cachePath, "utf8");
      const data = JSON.parse(raw) as KpiCatalogFile;
      this.kpis = data.kpis ?? [];
      this.rebuildIndex();
      return true;
    } catch {
      return false;
    }
  }

  /** 重建 id 索引。 */
  private rebuildIndex(): void {
    this.idIndex.clear();
    for (const kpi of this.kpis) {
      this.idIndex.set(kpi.id.toLowerCase(), kpi);
    }
  }

  /** 计算缓存年龄（ms）。 */
  private getCacheAge(): number | null {
    if (!existsSync(this.cachePath)) return null;
    try {
      const raw = readFileSync(this.cachePath, "utf8");
      const data = JSON.parse(raw) as KpiCatalogFile;
      if (!data.generatedAt) return null;
      const generated = Date.parse(data.generatedAt);
      if (Number.isNaN(generated)) return null;
      return Date.now() - generated;
    } catch {
      return null;
    }
  }

  /** 调 kpi.search 拉取 + 持久化。 */
  private async fetchAndPersist(): Promise<void> {
    const kpis = await this.callKpiSearch();
    this.kpis = kpis;
    this.rebuildIndex();

    const data: KpiCatalogFile = {
      serverId: this.serverId,
      generatedAt: new Date().toISOString(),
      kpis,
    };
    mkdirSync(this.cacheDir, { recursive: true });
    writeFileSync(this.cachePath, JSON.stringify(data, null, 2));

    console.log(`[kpi-catalog-cache] ${this.serverId} 预热完成：${kpis.length} 个 KPI`);
  }

  /** 调用 mestar.kpi.search（封装 MCP callTool）。 */
  private async callKpiSearch(): Promise<KpiDescriptor[]> {
    const result: McpToolCallResult = await this.client.callTool("mestar.kpi.search", {});

    // 优先解析 structuredContent
    const structured = (result as { structuredContent?: { kpis?: KpiDescriptor[]; items?: KpiDescriptor[] } }).structuredContent;
    if (structured) {
      const list = structured.kpis ?? structured.items ?? [];
      if (list.length > 0) return list;
    }

    // 兜底：从 text content 解析
    const text = result.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
    try {
      const parsed = JSON.parse(text) as { kpis?: KpiDescriptor[]; items?: KpiDescriptor[] };
      return parsed.kpis ?? parsed.items ?? [];
    } catch {
      return [];
    }
  }
}
