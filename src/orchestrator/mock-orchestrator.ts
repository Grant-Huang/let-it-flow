/**
 * MockOrchestrator（L2 知识层 —— 本地兜底实现）。
 *
 * 设计见 apps/nexusops/docs/architecture/01-orchestrator-design.md §3。
 * 从本地 JSON 文件加载规则（详见 04-mock-rules-spec.md）。
 *
 * 所有返回的 source 恒为 "mock"，让 LLM 知道当前是模拟知识。
 * 未来 relos 就绪时，新增 RelosOrchestrator 实现，调用方代码零改动。
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  Orchestrator,
  BizContext,
  Methodology,
  EvidenceContract,
  CausalChain,
  RelationObject,
  ToolManifest,
  FactorEntry,
  WhyChain,
} from "./types.js";

/** relation 数据文件结构。 */
interface RelationsFile {
  relations: RelationObject[];
}

/** methodology 文件结构。 */
interface MethodologiesFile {
  methodologies: Methodology[];
}

/** evidence contract 文件结构。 */
interface ContractsFile {
  contracts: EvidenceContract[];
}

/** syncToolIndex 产物结构。 */
interface ToolIndexEntry {
  semantic: string;
  toolName: string;
  primary?: boolean;
  paramMap?: Record<string, string>;
  fieldMap?: Record<string, string>;
}

interface ToolIndexFile {
  version: string;
  enterprise: string;
  syncedAt: string;
  tools: ToolManifest[];
  /** entries 数组：英文 semantic key → toolName（由 McpCatalogCache.persistToToolIndex 写入）。 */
  entries?: ToolIndexEntry[];
}

/**
 * 从 JSON 文件加载（文件不存在时返回空结构，不抛错 —— 支持降级）。
 */
function loadJson<T>(filePath: string, empty: T): T {
  try {
    if (!existsSync(filePath)) return empty;
    const raw = readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return empty;
  }
}

/**
 * MockOrchestrator：从本地 JSON 文件加载编排知识。
 *
 * 数据目录结构（详见 04-mock-rules-spec.md §1）：
 *   data/relos-mock/
 *   ├── relations.json            # 因果知识
 *   ├── methodologies-full.json   # 完整结构化方法论
 *   ├── methodologies-min.json    # 最小骨架方法论
 *   ├── evidence-contracts.json   # 证据契约
 *   └── tool-index.json           # syncToolIndex 回写产物
 */
export class MockOrchestrator implements Orchestrator {
  private readonly dataDir: string;
  private relations: RelationObject[];
  private methodologies: Methodology[];
  private contracts: EvidenceContract[];

  constructor(dataDir = "data/relos-mock") {
    this.dataDir = dataDir;
    this.relations = loadJson<RelationsFile>(join(dataDir, "relations.json"), { relations: [] }).relations;
    const full = loadJson<MethodologiesFile>(join(dataDir, "methodologies-full.json"), { methodologies: [] }).methodologies;
    const min = loadJson<MethodologiesFile>(join(dataDir, "methodologies-min.json"), { methodologies: [] }).methodologies;
    this.methodologies = [...full, ...min];
    this.contracts = loadJson<ContractsFile>(join(dataDir, "evidence-contracts.json"), { contracts: [] }).contracts;
  }

  async getMethodology(topic: string, _ctx: BizContext): Promise<Methodology | null> {
    const m = this.methodologies.find((m) => m.topic === topic);
    if (!m) return null;
    return { ...m, source: "mock" };
  }

  async getEvidenceContract(conclusion: string, _ctx: BizContext): Promise<EvidenceContract | null> {
    const c = this.contracts.find((c) => c.conclusion === conclusion);
    return c ? { ...c, source: "mock" } : null;
  }

  async getCausalChain(_symptom: string, ctx: BizContext): Promise<CausalChain | null> {
    // 1. 按 ctx.scenarioId / ctx.line 过滤因果规则
    const applicable = this.relations.filter((r) => {
      const type = r.relation_type;
      if (!type.includes("INDICATES") && !type.includes("CAUSES") && !type.includes("FAILURE")) return false;
      const props = r.properties ?? {};
      const scenarioId = ctx.scenarioId;
      const sceneMatch = !props.appliesScenario || props.appliesScenario.length === 0 || !scenarioId
        || props.appliesScenario.includes(scenarioId);
      const line = ctx.line;
      const lineMatch = !props.appliesLine || props.appliesLine.length === 0 || !line
        || props.appliesLine.includes(line);
      return sceneMatch && lineMatch;
    });

    // 2. 过滤掉空链（normal 场景的占位规则 rootCause=null）
    const withContent = applicable.filter((r) => {
      const props = r.properties ?? {};
      return (props.causalLayers?.length ?? 0) > 0 || props.rootCause != null;
    });

    if (withContent.length === 0) return null;

    // 3. 组装成 CausalChain 格式
    return this.buildCausalChain(withContent);
  }

  async syncToolIndex(manifest: ToolManifest[]): Promise<void> {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const indexPath = join(this.dataDir, "tool-index.json");

      // merge 语义：保留现有文件中非 manifest 来源的 tools + 全部 entries
      // （例如 McpCatalogCache.persistToToolIndex 写入的 mestar 工具 + 双 tag 索引），
      // 避免全量覆盖导致 catalog 预热产物丢失。
      // 顺序无关：无论 sync 与 warmup 谁先谁后，结果一致。
      let existing: ToolIndexFile | null = null;
      try {
        if (existsSync(indexPath)) {
          const raw = readFileSync(indexPath, "utf8");
          existing = JSON.parse(raw) as ToolIndexFile;
        }
      } catch {
        // 损坏文件降级为全量写入
      }

      const manifestNames = new Set(manifest.map((t) => t.name));
      const preservedTools = (existing?.tools ?? []).filter(
        (t) => !manifestNames.has(t.name),
      );

      const data: ToolIndexFile = {
        version: "1.0",
        enterprise: "nexusops-mock",
        syncedAt: new Date().toISOString(),
        tools: [...manifest, ...preservedTools],
        // 原样保留 entries（由 McpCatalogCache 写入，syncToolIndex 不触碰）
        ...(existing?.entries && existing.entries.length > 0
          ? { entries: existing.entries }
          : {}),
      };
      writeFileSync(indexPath, JSON.stringify(data, null, 2), "utf8");
    } catch {
      // 写盘失败不阻断主流程
    }
  }

  /**
   * 把匹配的 RelationObject 列表组装成 CausalChain。
   *
   * 每个 RelationObject 的 properties.causalLayers 是一条 5Why 链，
   * properties.fishbone 是鱼骨图分支。
   */
  private buildCausalChain(relations: RelationObject[]): CausalChain {
    const chains: WhyChain[] = [];
    const fishbone = {
      man: [] as FactorEntry[],
      machine: [] as FactorEntry[],
      material: [] as FactorEntry[],
      method: [] as FactorEntry[],
      environment: [] as FactorEntry[],
      measurement: [] as FactorEntry[],
    };

    let symptom = "";
    let topSuspect: string | undefined;

    for (const rel of relations) {
      const props = rel.properties ?? {};
      if (!symptom && props.symptom) symptom = props.symptom;

      // 5Why 链
      if (props.causalLayers && props.causalLayers.length > 0) {
        chains.push({
          method: "5why",
          layers: props.causalLayers,
          rootCause: props.rootCause ?? "（未明确根因）",
          confidence: rel.confidence,
        });
      }

      // 鱼骨图分支
      if (props.fishbone) {
        const toEntries = (arr?: string[]): FactorEntry[] =>
          (arr ?? []).map((factor) => ({
            factor,
            confidence: rel.confidence,
            evidenceRefs: props.evidenceRefs,
          }));
        fishbone.man.push(...toEntries(props.fishbone.man));
        fishbone.machine.push(...toEntries(props.fishbone.machine));
        fishbone.material.push(...toEntries(props.fishbone.material));
        fishbone.method.push(...toEntries(props.fishbone.method));
        fishbone.environment.push(...toEntries(props.fishbone.environment));
        fishbone.measurement.push(...toEntries(props.fishbone.measurement));
      }
    }

    // 取 machine 分支为首要嫌疑（设备相关因素通常是注塑工艺主因）
    const allBranches = Object.entries(fishbone) as [string, FactorEntry[]][];
    const branchCounts = allBranches
      .filter(([, factors]) => factors.length > 0)
      .map(([dim, factors]) => ({ dim, count: factors.length }))
      .sort((a, b) => b.count - a.count);
    if (branchCounts.length > 0) {
      topSuspect = branchCounts[0]!.dim;
    }

    return {
      symptom: symptom || "（未明确症状）",
      chains,
      fishbone,
      ...(topSuspect ? { topSuspect } : {}),
      source: "mock",
    };
  }
}
