/**
 * NexusOps mock 场景数据工厂（应用层 —— T 内容）。
 *
 * 三套场景切换 NexusOps 的全部 mock 工具输出：
 *   normal  — 一切正常，OEE 高、设备健康、质量稳定
 *   anomaly — OEE 异常下滑、设备 MTBF 下降、质量波动（典型诊断场景）
 *   crisis  — 产线停机、批量报废、能耗飙升（危机响应场景）
 *
 * 工具接受 scenarioId 参数（缺省 anomaly，最利于演示 ReAct 诊断）。
 * 所有数据都模拟 MES/MOM/ERP 实测，confidence=measured。
 */
import type { EvidenceEnvelope, Freshness, Confidence } from "../../../../src/core/evidence-envelope.js";

export type ScenarioId = "normal" | "anomaly" | "crisis";

/** 产线 id（mock 范围）。 */
export const LINES = ["L01", "L02", "L03"] as const;
export type LineId = (typeof LINES)[number];

/** 班次。 */
export const SHIFTS = ["A", "B", "C"] as const;

/** 场景上下文：当前激活的场景。 */
export interface ScenarioContext {
  scenarioId: ScenarioId;
  /** 当前查询的产线（缺省 L01）。 */
  line?: LineId;
}

/** 各场景的 OEE 基础数据。 */
const OEE_BASE: Record<ScenarioId, Record<LineId, {
  oee: number; availability: number; performance: number; quality: number;
  target: number; trend7d: number[];
}>> = {
  normal: {
    L01: { oee: 0.82, availability: 0.92, performance: 0.93, quality: 0.96, target: 0.85, trend7d: [0.81, 0.82, 0.83, 0.82, 0.82, 0.83, 0.82] },
    L02: { oee: 0.78, availability: 0.90, performance: 0.90, quality: 0.96, target: 0.85, trend7d: [0.77, 0.78, 0.78, 0.79, 0.78, 0.78, 0.78] },
    L03: { oee: 0.80, availability: 0.91, performance: 0.91, quality: 0.97, target: 0.85, trend7d: [0.79, 0.80, 0.80, 0.80, 0.81, 0.80, 0.80] },
  },
  anomaly: {
    L01: { oee: 0.61, availability: 0.78, performance: 0.85, quality: 0.92, target: 0.85, trend7d: [0.81, 0.79, 0.75, 0.70, 0.66, 0.63, 0.61] },
    L02: { oee: 0.74, availability: 0.88, performance: 0.88, quality: 0.95, target: 0.85, trend7d: [0.77, 0.76, 0.75, 0.75, 0.74, 0.74, 0.74] },
    L03: { oee: 0.79, availability: 0.90, performance: 0.90, quality: 0.97, target: 0.85, trend7d: [0.80, 0.80, 0.79, 0.79, 0.79, 0.79, 0.79] },
  },
  crisis: {
    L01: { oee: 0.34, availability: 0.55, performance: 0.70, quality: 0.88, target: 0.85, trend7d: [0.61, 0.55, 0.48, 0.42, 0.38, 0.35, 0.34] },
    L02: { oee: 0.45, availability: 0.65, performance: 0.75, quality: 0.92, target: 0.85, trend7d: [0.74, 0.68, 0.60, 0.55, 0.50, 0.47, 0.45] },
    L03: { oee: 0.72, availability: 0.86, performance: 0.87, quality: 0.96, target: 0.85, trend7d: [0.79, 0.78, 0.76, 0.75, 0.74, 0.73, 0.72] },
  },
};

/** 设备数据。 */
const EQUIPMENT: Record<ScenarioId, Record<LineId, {
  status: "running" | "idle" | "down";
  mtbfHours: number; mttrMinutes: number;
  downtimeEvents: Array<{ reason: string; minutes: number; at: string }>;
  healthScore: number;
  failureRisk30d: number;
}>> = {
  normal: {
    L01: { status: "running", mtbfHours: 480, mttrMinutes: 35, downtimeEvents: [], healthScore: 0.95, failureRisk30d: 0.05 },
    L02: { status: "running", mtbfHours: 420, mttrMinutes: 40, downtimeEvents: [], healthScore: 0.92, failureRisk30d: 0.08 },
    L03: { status: "running", mtbfHours: 500, mttrMinutes: 30, downtimeEvents: [], healthScore: 0.96, failureRisk30d: 0.04 },
  },
  anomaly: {
    L01: {
      status: "running",
      mtbfHours: 180,
      mttrMinutes: 75,
      downtimeEvents: [
        { reason: "模具卡死", minutes: 45, at: "2026-06-19T08:00:00Z" },
        { reason: "传感器漂移", minutes: 30, at: "2026-06-19T11:00:00Z" },
        { reason: "换模超时", minutes: 60, at: "2026-06-19T14:00:00Z" },
      ],
      healthScore: 0.62,
      failureRisk30d: 0.35,
    },
    L02: { status: "running", mtbfHours: 350, mttrMinutes: 50, downtimeEvents: [], healthScore: 0.85, failureRisk30d: 0.15 },
    L03: { status: "running", mtbfHours: 490, mttrMinutes: 32, downtimeEvents: [], healthScore: 0.95, failureRisk30d: 0.05 },
  },
  crisis: {
    L01: {
      status: "down",
      mtbfHours: 60,
      mttrMinutes: 180,
      downtimeEvents: [
        { reason: "主轴轴承断裂", minutes: 240, at: "2026-06-19T02:00:00Z" },
        { reason: "电气控制柜故障", minutes: 120, at: "2026-06-19T06:00:00Z" },
      ],
      healthScore: 0.25,
      failureRisk30d: 0.85,
    },
    L02: { status: "idle", mtbfHours: 120, mttrMinutes: 90, downtimeEvents: [{ reason: "物料缺料待机", minutes: 180, at: "2026-06-19T04:00:00Z" }], healthScore: 0.55, failureRisk30d: 0.40 },
    L03: { status: "running", mtbfHours: 470, mttrMinutes: 33, downtimeEvents: [], healthScore: 0.94, failureRisk30d: 0.06 },
  },
};

/** 质量数据。 */
const QUALITY: Record<ScenarioId, Record<LineId, {
  defectRate: number; fpy: number; scrapRate: number;
  topDefects: Array<{ type: string; count: number; pct: number }>;
  cp: number; cpk: number;
}>> = {
  normal: {
    L01: { defectRate: 0.015, fpy: 0.972, scrapRate: 0.008, topDefects: [{ type: "毛刺", count: 8, pct: 0.4 }], cp: 1.5, cpk: 1.4 },
    L02: { defectRate: 0.020, fpy: 0.965, scrapRate: 0.010, topDefects: [{ type: "尺寸超差", count: 10, pct: 0.5 }], cp: 1.4, cpk: 1.3 },
    L03: { defectRate: 0.012, fpy: 0.978, scrapRate: 0.006, topDefects: [{ type: "划痕", count: 6, pct: 0.3 }], cp: 1.6, cpk: 1.5 },
  },
  anomaly: {
    L01: { defectRate: 0.058, fpy: 0.905, scrapRate: 0.028, topDefects: [
      { type: "尺寸超差", count: 45, pct: 0.42 },
      { type: "表面气泡", count: 28, pct: 0.26 },
      { type: "毛刺", count: 18, pct: 0.17 },
    ], cp: 1.1, cpk: 0.85 },
    L02: { defectRate: 0.025, fpy: 0.958, scrapRate: 0.012, topDefects: [{ type: "尺寸超差", count: 12, pct: 0.5 }], cp: 1.3, cpk: 1.2 },
    L03: { defectRate: 0.013, fpy: 0.977, scrapRate: 0.007, topDefects: [{ type: "划痕", count: 7, pct: 0.3 }], cp: 1.6, cpk: 1.5 },
  },
  crisis: {
    L01: { defectRate: 0.18, fpy: 0.78, scrapRate: 0.095, topDefects: [
      { type: "批量报废（轴承异响致加工面损伤）", count: 180, pct: 0.55 },
      { type: "尺寸严重超差", count: 95, pct: 0.29 },
    ], cp: 0.7, cpk: 0.45 },
    L02: { defectRate: 0.06, fpy: 0.92, scrapRate: 0.030, topDefects: [{ type: "尺寸超差", count: 30, pct: 0.48 }], cp: 1.1, cpk: 0.95 },
    L03: { defectRate: 0.014, fpy: 0.976, scrapRate: 0.007, topDefects: [{ type: "划痕", count: 8, pct: 0.3 }], cp: 1.6, cpk: 1.5 },
  },
};

/** 工艺参数数据。 */
const PROCESS: Record<ScenarioId, Record<LineId, {
  parameters: Record<string, { actual: number; standard: number; unit: string; inSpec: boolean }>;
  deviationScore: number; capability: number;
}>> = {
  normal: {
    L01: {
      parameters: {
        温度: { actual: 185, standard: 185, unit: "℃", inSpec: true },
        压力: { actual: 4.2, standard: 4.2, unit: "MPa", inSpec: true },
        速度: { actual: 1200, standard: 1200, unit: "rpm", inSpec: true },
      },
      deviationScore: 0.05,
      capability: 1.45,
    },
    L02: { parameters: { 温度: { actual: 182, standard: 180, unit: "℃", inSpec: true } }, deviationScore: 0.08, capability: 1.35 },
    L03: { parameters: { 温度: { actual: 186, standard: 185, unit: "℃", inSpec: true } }, deviationScore: 0.04, capability: 1.5 },
  },
  anomaly: {
    L01: {
      parameters: {
        温度: { actual: 197, standard: 185, unit: "℃", inSpec: false },
        压力: { actual: 4.8, standard: 4.2, unit: "MPa", inSpec: false },
        速度: { actual: 1180, standard: 1200, unit: "rpm", inSpec: true },
      },
      deviationScore: 0.42,
      capability: 0.88,
    },
    L02: { parameters: { 温度: { actual: 183, standard: 180, unit: "℃", inSpec: true } }, deviationScore: 0.12, capability: 1.25 },
    L03: { parameters: { 温度: { actual: 186, standard: 185, unit: "℃", inSpec: true } }, deviationScore: 0.05, capability: 1.5 },
  },
  crisis: {
    L01: {
      parameters: {
        温度: { actual: 215, standard: 185, unit: "℃", inSpec: false },
        压力: { actual: 5.6, standard: 4.2, unit: "MPa", inSpec: false },
        速度: { actual: 950, standard: 1200, unit: "rpm", inSpec: false },
      },
      deviationScore: 0.78,
      capability: 0.42,
    },
    L02: { parameters: { 温度: { actual: 188, standard: 180, unit: "℃", inSpec: true } }, deviationScore: 0.18, capability: 1.1 },
    L03: { parameters: { 温度: { actual: 186, standard: 185, unit: "℃", inSpec: true } }, deviationScore: 0.05, capability: 1.5 },
  },
};

/** 能耗数据。 */
const ENERGY: Record<ScenarioId, Record<LineId, {
  realtimeKw: number; baselineKw: number; peakKw: number;
  costToday: number; efficiency: number; carbonKgPerUnit: number;
}>> = {
  normal: {
    L01: { realtimeKw: 85, baselineKw: 88, peakKw: 110, costToday: 1820, efficiency: 0.92, carbonKgPerUnit: 2.1 },
    L02: { realtimeKw: 78, baselineKw: 80, peakKw: 100, costToday: 1680, efficiency: 0.90, carbonKgPerUnit: 2.3 },
    L03: { realtimeKw: 82, baselineKw: 84, peakKw: 105, costToday: 1750, efficiency: 0.91, carbonKgPerUnit: 2.2 },
  },
  anomaly: {
    L01: { realtimeKw: 128, baselineKw: 88, peakKw: 165, costToday: 2840, efficiency: 0.68, carbonKgPerUnit: 3.8 },
    L02: { realtimeKw: 82, baselineKw: 80, peakKw: 102, costToday: 1720, efficiency: 0.88, carbonKgPerUnit: 2.4 },
    L03: { realtimeKw: 83, baselineKw: 84, peakKw: 106, costToday: 1760, efficiency: 0.91, carbonKgPerUnit: 2.2 },
  },
  crisis: {
    L01: { realtimeKw: 195, baselineKw: 88, peakKw: 240, costToday: 4250, efficiency: 0.42, carbonKgPerUnit: 6.5 },
    L02: { realtimeKw: 95, baselineKw: 80, peakKw: 130, costToday: 2100, efficiency: 0.72, carbonKgPerUnit: 3.1 },
    L03: { realtimeKw: 84, baselineKw: 84, peakKw: 107, costToday: 1780, efficiency: 0.91, carbonKgPerUnit: 2.2 },
  },
};

/** 排产数据。 */
const SCHEDULE: Record<ScenarioId, Record<LineId, {
  attainment: number; changeoverMinutesToday: number; bottleneckResource: string;
  capacityUtilization: number; ctSeconds: number; taktSeconds: number;
}>> = {
  normal: {
    L01: { attainment: 0.96, changeoverMinutesToday: 45, bottleneckResource: "无", capacityUtilization: 0.82, ctSeconds: 58, taktSeconds: 60 },
    L02: { attainment: 0.94, changeoverMinutesToday: 50, bottleneckResource: "无", capacityUtilization: 0.80, ctSeconds: 62, taktSeconds: 60 },
    L03: { attainment: 0.97, changeoverMinutesToday: 40, bottleneckResource: "无", capacityUtilization: 0.83, ctSeconds: 57, taktSeconds: 60 },
  },
  anomaly: {
    L01: { attainment: 0.71, changeoverMinutesToday: 180, bottleneckResource: "注塑机#1", capacityUtilization: 0.95, ctSeconds: 78, taktSeconds: 60 },
    L02: { attainment: 0.90, changeoverMinutesToday: 60, bottleneckResource: "无", capacityUtilization: 0.84, ctSeconds: 64, taktSeconds: 60 },
    L03: { attainment: 0.96, changeoverMinutesToday: 42, bottleneckResource: "无", capacityUtilization: 0.83, ctSeconds: 58, taktSeconds: 60 },
  },
  crisis: {
    L01: { attainment: 0.38, changeoverMinutesToday: 320, bottleneckResource: "注塑机#1（停机）", capacityUtilization: 1.15, ctSeconds: 145, taktSeconds: 60 },
    L02: { attainment: 0.72, changeoverMinutesToday: 120, bottleneckResource: "物料供应", capacityUtilization: 0.92, ctSeconds: 75, taktSeconds: 60 },
    L03: { attainment: 0.95, changeoverMinutesToday: 44, bottleneckResource: "无", capacityUtilization: 0.83, ctSeconds: 58, taktSeconds: 60 },
  },
};

/** 物料数据。 */
const MATERIAL: Record<ScenarioId, Record<LineId, {
  wipLevel: number; wipMax: number; inventoryHours: number; shortageRisk: number;
}>> = {
  normal: {
    L01: { wipLevel: 420, wipMax: 600, inventoryHours: 36, shortageRisk: 0.05 },
    L02: { wipLevel: 380, wipMax: 550, inventoryHours: 32, shortageRisk: 0.08 },
    L03: { wipLevel: 450, wipMax: 650, inventoryHours: 40, shortageRisk: 0.04 },
  },
  anomaly: {
    L01: { wipLevel: 720, wipMax: 600, inventoryHours: 18, shortageRisk: 0.32 },
    L02: { wipLevel: 410, wipMax: 550, inventoryHours: 30, shortageRisk: 0.12 },
    L03: { wipLevel: 460, wipMax: 650, inventoryHours: 39, shortageRisk: 0.05 },
  },
  crisis: {
    L01: { wipLevel: 880, wipMax: 600, inventoryHours: 4, shortageRisk: 0.78 },
    L02: { wipLevel: 520, wipMax: 550, inventoryHours: 12, shortageRisk: 0.45 },
    L03: { wipLevel: 465, wipMax: 650, inventoryHours: 38, shortageRisk: 0.06 },
  },
};

// ── accessor helpers ──

export function resolveLine(ctx: ScenarioContext): LineId {
  return ctx.line ?? "L01";
}

export function getOEE(ctx: ScenarioContext) {
  return OEE_BASE[ctx.scenarioId][resolveLine(ctx)];
}
export function getEquipment(ctx: ScenarioContext) {
  return EQUIPMENT[ctx.scenarioId][resolveLine(ctx)];
}
export function getQuality(ctx: ScenarioContext) {
  return QUALITY[ctx.scenarioId][resolveLine(ctx)];
}
export function getProcess(ctx: ScenarioContext) {
  return PROCESS[ctx.scenarioId][resolveLine(ctx)];
}
export function getEnergy(ctx: ScenarioContext) {
  return ENERGY[ctx.scenarioId][resolveLine(ctx)];
}
export function getSchedule(ctx: ScenarioContext) {
  return SCHEDULE[ctx.scenarioId][resolveLine(ctx)];
}
export function getMaterial(ctx: ScenarioContext) {
  return MATERIAL[ctx.scenarioId][resolveLine(ctx)];
}

/** 全产线对比（OEE 域）。 */
export function getOEEAllLines(scenarioId: ScenarioId) {
  return LINES.map((line) => ({ line, ...OEE_BASE[scenarioId][line] }));
}

/**
 * 把 mock 数据包成 EvidenceEnvelope。
 * mock 数据默认 confidence=measured, freshness=realtime（模拟 MES 实测）。
 */
export function mockEvidence<T>(
  data: T,
  opts: { system: string; provenance: string; freshness?: Freshness; confidence?: Confidence; caveat?: string },
): EvidenceEnvelope<T> {
  return {
    data,
    freshness: opts.freshness ?? "realtime",
    capturedAt: new Date().toISOString(),
    confidence: opts.confidence ?? "measured",
    source: { system: opts.system, provenance: opts.provenance },
    ...(opts.caveat ? { caveat: opts.caveat } : {}),
  };
}

/** 从工具参数解析 ScenarioContext。 */
export function ctxFromArgs(args: Record<string, unknown>): ScenarioContext {
  const scenarioId = (args.scenarioId as ScenarioId | undefined) ?? "anomaly";
  const line = args.line as LineId | undefined;
  return { scenarioId, ...(line ? { line } : {}) };
}
