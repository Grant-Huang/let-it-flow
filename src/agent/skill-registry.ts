/**
 * SkillRegistry（L 层机制 —— 跨会话管理 skill 候选/draft/active 生命周期）。
 *
 * 职责（设计见计划工作流 D3）：
 *   - 跨会话去重：同签名候选只记一条，occurrences 累加
 *   - 已忽略降权：用户忽略的候选下次提示优先级降低（dismissedCount 累加）
 *   - draft→active 升级：draft skill 连续 N 次成功运行（无反信号）转正
 *
 * 存储：本地 JSON（data/skills.json），不入 git（data/ 已在 .gitignore）。
 * 持久化失败不阻断主流程（catch 后降级为内存态）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SkillCandidate } from "./skill-miner.js";
import type { SkillConnector } from "./skill-bridge.js";
import type { ReportTemplateRecord } from "../orchestrator/report-types.js";

/** draft 转正所需连续成功次数。 */
const PROMOTE_SUCCESS_THRESHOLD = 3;
/** 候选被忽略多少次后不再提示。 */
const DISMISS_SUPPRESS_THRESHOLD = 2;

/** 持久化的候选记录。 */
export interface CandidateRecord {
  signature: string;
  occurrences: number;
  /** 用户忽略次数（达阈值后不再提示）。 */
  dismissedCount: number;
  /** 首次发现时间（ISO）。 */
  firstSeen: string;
  /** 最近发现时间（ISO）。 */
  lastSeen: string;
  /** sampleTrace 的工具序列（供 skill-confirm 提取步骤）。 */
  sampleSequence: string[];
}

/** 持久化的 draft/active skill 记录。 */
export interface SkillRecord {
  name: string;
  signature: string;
  status: "draft" | "active";
  /** draft 连续成功次数（达阈值转正）。 */
  consecutiveSuccess: number;
  /** draft 连续失败次数（达阈值降级/删除）。 */
  consecutiveFailure: number;
  createdAt: string;
  /** draft 的步骤序列（JSON，供重建 SkillConnector）。 */
  stepsPayload: unknown;
}

/** registry 持久化文件结构。 */
interface RegistryFile {
  candidates: CandidateRecord[];
  skills: SkillRecord[];
  /** 固化报表模板表（D8 落地，Phase 2 报表固化闭环）。 */
  reportTemplates?: ReportTemplateRecord[];
}

/**
 * SkillRegistry：跨会话管理候选 + draft/active skill。
 *
 * 每个实例对应一个存储文件（缺省 data/skills.json）。
 * 测试可注入自定义路径。
 */
export class SkillRegistry {
  private candidates = new Map<string, CandidateRecord>();
  private skills = new Map<string, SkillRecord>();
  private reportTemplates = new Map<string, ReportTemplateRecord>();
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? defaultPath();
    this.load();
  }

  // ── 候选管理 ──

  /**
   * 登记一批新发现的候选（跨会话去重 + occurrences 累加）。
   * 只登记未被反信号否决的候选（vetoed=true 的不登记）。
   */
  registerCandidates(cands: SkillCandidate[]): CandidateRecord[] {
    const now = new Date().toISOString();
    const updated: CandidateRecord[] = [];
    for (const c of cands) {
      if (c.vetoed) continue;
      const existing = this.candidates.get(c.signature);
      if (existing) {
        existing.occurrences += c.occurrences;
        existing.lastSeen = now;
        updated.push(existing);
      } else {
        const rec: CandidateRecord = {
          signature: c.signature,
          occurrences: c.occurrences,
          dismissedCount: 0,
          firstSeen: now,
          lastSeen: now,
          sampleSequence: c.signature.split("→"),
        };
        this.candidates.set(c.signature, rec);
        updated.push(rec);
      }
    }
    if (updated.length > 0) this.save();
    return updated;
  }

  /**
   * 返回"值得提示用户"的候选：
   *   - 未被忽略达阈值（dismissedCount < DISMISS_SUPPRESS_THRESHOLD）
   * 按 occurrences 降序。
   */
  promotableCandidates(): CandidateRecord[] {
    return [...this.candidates.values()]
      .filter((c) => c.dismissedCount < DISMISS_SUPPRESS_THRESHOLD)
      .sort((a, b) => b.occurrences - a.occurrences);
  }

  /** 用户忽略某候选（降权）。 */
  dismissCandidate(signature: string): void {
    const rec = this.candidates.get(signature);
    if (rec) {
      rec.dismissedCount += 1;
      this.save();
    }
  }

  /** 用户确认某候选 → 从候选列表移除（转 draft 由 registerDraftSkill 处理）。 */
  acceptCandidate(signature: string): CandidateRecord | undefined {
    const rec = this.candidates.get(signature);
    if (rec) {
      this.candidates.delete(signature);
      this.save();
    }
    return rec;
  }

  // ── draft/active skill 管理 ──

  /** 登记一个 draft skill（来自 skill-confirm 的 createSkill 产物）。 */
  registerDraftSkill(record: Omit<SkillRecord, "status" | "consecutiveSuccess" | "consecutiveFailure" | "createdAt">): void {
    const now = new Date().toISOString();
    this.skills.set(record.name, {
      ...record,
      status: "draft",
      consecutiveSuccess: 0,
      consecutiveFailure: 0,
      createdAt: now,
    });
    this.save();
  }

  /** 记录一次 draft skill 运行结果（成功则累加 consecutiveSuccess，失败清零并累加 failure）。 */
  recordDraftRun(name: string, success: boolean): { promoted: boolean; demoted: boolean } {
    const rec = this.skills.get(name);
    if (!rec) return { promoted: false, demoted: false };
    if (success) {
      rec.consecutiveSuccess += 1;
      rec.consecutiveFailure = 0;
      if (rec.consecutiveSuccess >= PROMOTE_SUCCESS_THRESHOLD && rec.status === "draft") {
        rec.status = "active";
        this.save();
        return { promoted: true, demoted: false };
      }
    } else {
      rec.consecutiveFailure += 1;
      rec.consecutiveSuccess = 0;
      // 连续失败 3 次 → 删除 draft（降级）
      if (rec.consecutiveFailure >= PROMOTE_SUCCESS_THRESHOLD && rec.status === "draft") {
        this.skills.delete(name);
        this.save();
        return { promoted: false, demoted: true };
      }
    }
    this.save();
    return { promoted: false, demoted: false };
  }

  /** 列出所有 active skill 记录（供 buildNexusSkills 合并）。 */
  activeSkills(): SkillRecord[] {
    return [...this.skills.values()].filter((s) => s.status === "active");
  }

  /** 列出所有 draft skill 记录（影子运行用）。 */
  draftSkills(): SkillRecord[] {
    return [...this.skills.values()].filter((s) => s.status === "draft");
  }

  // ── 报表模板管理（D8 落地） ──

  /**
   * 登记一个固化的报表模板（来自前端"固化"按钮）。
   * 同 reportType 会覆盖（最新覆盖旧的）。
   */
  registerReportTemplate(record: Omit<ReportTemplateRecord, "createdAt" | "updatedAt">): void {
    const now = new Date().toISOString();
    const existing = this.reportTemplates.get(record.reportType);
    this.reportTemplates.set(record.reportType, {
      ...record,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });
    this.save();
  }

  /** 按 reportType 查找 active 模板（用于报表生成时的模板匹配）。 */
  getReportTemplate(reportType: string): ReportTemplateRecord | undefined {
    const rec = this.reportTemplates.get(reportType);
    return rec && rec.status === "active" ? rec : undefined;
  }

  /** 列出所有 active 报表模板。 */
  activeReportTemplates(): ReportTemplateRecord[] {
    return [...this.reportTemplates.values()].filter((t) => t.status === "active");
  }

  /** 列出所有报表模板（含 draft，供管理界面用）。 */
  allReportTemplates(): ReportTemplateRecord[] {
    return [...this.reportTemplates.values()];
  }

  /** 删除一个报表模板。 */
  deleteReportTemplate(reportType: string): void {
    if (this.reportTemplates.delete(reportType)) {
      this.save();
    }
  }

  // ── 持久化 ──

  /** 加载持久化文件（失败降级为空内存态）。 */
  private load(): void {
    try {
      if (!existsSync(this.filePath)) return;
      const raw = readFileSync(this.filePath, "utf8");
      const data = JSON.parse(raw) as RegistryFile;
      for (const c of data.candidates ?? []) this.candidates.set(c.signature, c);
      for (const s of data.skills ?? []) this.skills.set(s.name, s);
      for (const t of data.reportTemplates ?? []) this.reportTemplates.set(t.reportType, t);
    } catch {
      // 持久化失败降级为空内存态
    }
  }

  /** 保存持久化文件（失败不抛错，保内存态）。 */
  private save(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const data: RegistryFile = {
        candidates: [...this.candidates.values()],
        skills: [...this.skills.values()],
        reportTemplates: [...this.reportTemplates.values()],
      };
      writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf8");
    } catch {
      // 持久化失败不阻断主流程
    }
  }
}

/** 缺省存储路径：data/skills.json。 */
function defaultPath(): string {
  const dataDir = process.env.LIF_DATA_DIR ?? join(process.cwd(), "data");
  return join(dataDir, "skills.json");
}

/**
 * 把 SkillConnector 列表与 registry 的 active skill 合并。
 * 手写 skill + registry active skill（去重 by name）。
 * 供 buildNexusSkills 调用。
 */
export function mergeWithRegistrySkills(
  handwritten: SkillConnector[],
  registry: SkillRegistry,
): SkillConnector[] {
  const byName = new Map(handwritten.map((s) => [s.name, s]));
  // registry 的 active skill（若有对应 SkillConnector 重建逻辑，由 skill-confirm 提供）
  // 此处只返回手写 + 占位；实际重建在 D4/D5 完成
  return [...byName.values()];
}
