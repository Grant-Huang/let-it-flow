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
import { actionStore } from "./action-store.js";

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

/**
 * 工艺参数 + PFMEA 评分数据。
 *
 * severity/occurrence/detection 采用 AIAG-VDA 第五版 1-10 评分（10 最差），
 * 用于 process.fmea 计算 AP（Action Priority）行动优先级，替代旧 RPN：
 *   - AP = H：必须立即采取行动
 *   - AP = M：应采取行动
 *   - AP = L：可酌情行动
 */
export interface ProcessParameter {
  actual: number;
  standard: number;
  unit: string;
  inSpec: boolean;
  /** FMEA S：失效后果严重度（1-10） */
  severity: number;
  /** FMEA O：失效发生频度（1-10） */
  occurrence: number;
  /** FMEA D：现行控制探测度（1-10，10=几乎探测不到） */
  detection: number;
}

const PROCESS: Record<ScenarioId, Record<LineId, {
  parameters: Record<string, ProcessParameter>;
  deviationScore: number; capability: number;
}>> = {
  normal: {
    L01: {
      parameters: {
        温度: { actual: 185, standard: 185, unit: "℃", inSpec: true, severity: 8, occurrence: 2, detection: 3 },
        压力: { actual: 4.2, standard: 4.2, unit: "MPa", inSpec: true, severity: 7, occurrence: 2, detection: 4 },
        速度: { actual: 1200, standard: 1200, unit: "rpm", inSpec: true, severity: 6, occurrence: 2, detection: 3 },
      },
      deviationScore: 0.05,
      capability: 1.45,
    },
    L02: {
      parameters: {
        温度: { actual: 180, standard: 180, unit: "℃", inSpec: true, severity: 7, occurrence: 2, detection: 3 },
        压力: { actual: 3.8, standard: 3.8, unit: "MPa", inSpec: true, severity: 7, occurrence: 2, detection: 4 },
        速度: { actual: 950, standard: 950, unit: "rpm", inSpec: true, severity: 5, occurrence: 2, detection: 3 },
      },
      deviationScore: 0.08,
      capability: 1.35,
    },
    L03: {
      parameters: {
        温度: { actual: 186, standard: 185, unit: "℃", inSpec: true, severity: 8, occurrence: 2, detection: 3 },
        压力: { actual: 4.0, standard: 4.0, unit: "MPa", inSpec: true, severity: 6, occurrence: 2, detection: 4 },
        速度: { actual: 1100, standard: 1100, unit: "rpm", inSpec: true, severity: 6, occurrence: 2, detection: 3 },
      },
      deviationScore: 0.04,
      capability: 1.5,
    },
  },
  anomaly: {
    L01: {
      parameters: {
        温度: { actual: 197, standard: 185, unit: "℃", inSpec: false, severity: 9, occurrence: 6, detection: 5 },
        压力: { actual: 4.8, standard: 4.2, unit: "MPa", inSpec: false, severity: 8, occurrence: 5, detection: 4 },
        速度: { actual: 1180, standard: 1200, unit: "rpm", inSpec: true, severity: 6, occurrence: 3, detection: 3 },
      },
      deviationScore: 0.42,
      capability: 0.88,
    },
    L02: {
      parameters: {
        温度: { actual: 189, standard: 180, unit: "℃", inSpec: false, severity: 8, occurrence: 5, detection: 4 },
        压力: { actual: 4.1, standard: 3.8, unit: "MPa", inSpec: false, severity: 7, occurrence: 4, detection: 4 },
        速度: { actual: 940, standard: 950, unit: "rpm", inSpec: true, severity: 5, occurrence: 3, detection: 3 },
      },
      deviationScore: 0.18,
      capability: 1.15,
    },
    L03: {
      parameters: {
        温度: { actual: 187, standard: 185, unit: "℃", inSpec: true, severity: 8, occurrence: 3, detection: 3 },
        压力: { actual: 4.0, standard: 4.0, unit: "MPa", inSpec: true, severity: 6, occurrence: 2, detection: 4 },
        速度: { actual: 1095, standard: 1100, unit: "rpm", inSpec: true, severity: 6, occurrence: 2, detection: 3 },
      },
      deviationScore: 0.05,
      capability: 1.5,
    },
  },
  crisis: {
    L01: {
      parameters: {
        温度: { actual: 215, standard: 185, unit: "℃", inSpec: false, severity: 10, occurrence: 8, detection: 6 },
        压力: { actual: 5.6, standard: 4.2, unit: "MPa", inSpec: false, severity: 9, occurrence: 7, detection: 5 },
        速度: { actual: 950, standard: 1200, unit: "rpm", inSpec: false, severity: 8, occurrence: 6, detection: 4 },
      },
      deviationScore: 0.78,
      capability: 0.42,
    },
    L02: {
      parameters: {
        温度: { actual: 198, standard: 180, unit: "℃", inSpec: false, severity: 9, occurrence: 6, detection: 5 },
        压力: { actual: 4.4, standard: 3.8, unit: "MPa", inSpec: false, severity: 7, occurrence: 5, detection: 4 },
        速度: { actual: 900, standard: 950, unit: "rpm", inSpec: false, severity: 6, occurrence: 5, detection: 4 },
      },
      deviationScore: 0.35,
      capability: 0.85,
    },
    L03: {
      parameters: {
        温度: { actual: 188, standard: 185, unit: "℃", inSpec: true, severity: 8, occurrence: 2, detection: 3 },
        压力: { actual: 4.1, standard: 4.0, unit: "MPa", inSpec: true, severity: 6, occurrence: 2, detection: 4 },
        速度: { actual: 1090, standard: 1100, unit: "rpm", inSpec: true, severity: 6, occurrence: 2, detection: 3 },
      },
      deviationScore: 0.06,
      capability: 1.48,
    },
  },
};

/**
 * AIAG-VDA 第五版 AP（行动优先级）矩阵判定。
 *
 * 输入 S/O/D（1-10，10 最差），输出 H/M/L：
 *   - H（High）：高优先级，必须采取行动降低风险
 *   - M（Medium）：中优先级，应考虑行动
 *   - L（Low）：低优先级，可保持现状
 *
 * 简化判定（基于 S 主导 + O/D 加权）：
 *   - S≥9 或 (S≥7 且 O≥6 且 D≥5) → H
 *   - S≥7 或 (O≥5 且 D≥4)        → M
 *   - 其余                          → L
 */
export function computeAP(s: number, o: number, d: number): "H" | "M" | "L" {
  if (s >= 9 || (s >= 7 && o >= 6 && d >= 5)) return "H";
  if (s >= 7 || (o >= 5 && d >= 4)) return "M";
  return "L";
}

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

/**
 * 班次维度数据。
 *
 * 班次差异是质量/OEE 波动的常见根因（见 vault 案例索引"缺陷率周期性波动（按班次）"）。
 * 设计：A 班（早班，人员资深）略优，B 班持平，C 班（夜班，含新员工）略差。
 * 各产线的班次差异幅度不同（L01 差异最大，因 SMED 推广中陈师傅班组抵触）。
 */
export type ShiftId = (typeof SHIFTS)[number];

export const SHIFT_DEVIATION: Record<LineId, Record<ShiftId, {
  oeeDelta: number; defectRateDelta: number; changeoverDeltaMin: number;
}>> = {
  L01: {
    A: { oeeDelta: 0.03, defectRateDelta: -0.005, changeoverDeltaMin: -15 },
    B: { oeeDelta: 0.0, defectRateDelta: 0.0, changeoverDeltaMin: 0 },
    C: { oeeDelta: -0.05, defectRateDelta: 0.012, changeoverDeltaMin: 25 },
  },
  L02: {
    A: { oeeDelta: 0.02, defectRateDelta: -0.003, changeoverDeltaMin: -10 },
    B: { oeeDelta: 0.0, defectRateDelta: 0.0, changeoverDeltaMin: 0 },
    C: { oeeDelta: -0.03, defectRateDelta: 0.008, changeoverDeltaMin: 15 },
  },
  L03: {
    A: { oeeDelta: 0.01, defectRateDelta: -0.002, changeoverDeltaMin: -5 },
    B: { oeeDelta: 0.0, defectRateDelta: 0.0, changeoverDeltaMin: 0 },
    C: { oeeDelta: -0.02, defectRateDelta: 0.005, changeoverDeltaMin: 10 },
  },
};

/**
 * 人员技能矩阵数据（与 vault 04-人与组织/培训与技能矩阵.md 对齐）。
 *
 * 用于班次差异诊断时交叉分析：某班次缺陷高 → 查该班次人员技能等级。
 * L1=培训中不可独立，L2=基础需监督，L3=熟练可独立，L4=专家可培训他人。
 */
export const PERSONNEL: Record<LineId, {
  keyPositions: Array<{ role: string; name: string; shift: ShiftId; level: Record<string, 1 | 2 | 3 | 4> }>;
  l3PlusRatio: number;
}> = {
  L01: {
    keyPositions: [
      { role: "产线长", name: "张工", shift: "A", level: { 注塑操作: 4, 换模: 3, 质量检验: 3, 设备保养: 3 } },
      { role: "工艺工程师", name: "李工", shift: "A", level: { 注塑操作: 3, 换模: 4, 质量检验: 4, 设备保养: 2 } },
      { role: "设备维护", name: "王工", shift: "B", level: { 注塑操作: 2, 换模: 4, 质量检验: 2, 设备保养: 4 } },
      { role: "班长A", name: "陈师傅", shift: "A", level: { 注塑操作: 4, 换模: 2, 质量检验: 3, 设备保养: 2 } },
      { role: "班长B", name: "刘师傅", shift: "C", level: { 注塑操作: 3, 换模: 3, 质量检验: 3, 设备保养: 2 } },
    ],
    l3PlusRatio: 0.72,
  },
  L02: {
    keyPositions: [
      { role: "产线长", name: "赵工", shift: "A", level: { 装配操作: 4, AOI检测: 3, 质量检验: 3, 设备保养: 3 } },
      { role: "装配工程师", name: "孙工", shift: "A", level: { 装配操作: 4, AOI检测: 4, 质量检验: 4, 设备保养: 2 } },
      { role: "设备维护", name: "周工", shift: "B", level: { 装配操作: 2, AOI检测: 3, 质量检验: 2, 设备保养: 4 } },
      { role: "班长A", name: "吴师傅", shift: "A", level: { 装配操作: 4, AOI检测: 3, 质量检验: 3, 设备保养: 2 } },
      { role: "班长B", name: "郑师傅", shift: "C", level: { 装配操作: 3, AOI检测: 2, 质量检验: 2, 设备保养: 2 } },
    ],
    l3PlusRatio: 0.68,
  },
  L03: {
    keyPositions: [
      { role: "产线长", name: "钱工", shift: "A", level: { CNC操作: 4, 清洗: 3, 质量检验: 3, 设备保养: 3 } },
      { role: "班长A", name: "冯师傅", shift: "A", level: { CNC操作: 4, 清洗: 3, 质量检验: 3, 设备保养: 3 } },
      { role: "班长B", name: "褚师傅", shift: "C", level: { CNC操作: 3, 清洗: 3, 质量检验: 2, 设备保养: 2 } },
    ],
    l3PlusRatio: 0.85,
  },
};

/**
 * 成本汇总数据（场景级，按产线）。
 *
 * 整合散落在各域的成本：OEE 损失折算、能耗成本、质量损失成本。
 * 单位：元/日。用于改善优先级的经济性评估。
 */
const COST: Record<ScenarioId, Record<LineId, {
  outputLossUnits: number;
  oeeLossCost: number;
  energyCost: number;
  qualityLossCost: number;
  totalLossCost: number;
}>> = {
  normal: {
    L01: { outputLossUnits: 45, oeeLossCost: 2025, energyCost: 1820, qualityLossCost: 675, totalLossCost: 4520 },
    L02: { outputLossUnits: 70, oeeLossCost: 3150, energyCost: 1680, qualityLossCost: 900, totalLossCost: 5730 },
    L03: { outputLossUnits: 40, oeeLossCost: 1800, energyCost: 1750, qualityLossCost: 540, totalLossCost: 4090 },
  },
  anomaly: {
    L01: { outputLossUnits: 240, oeeLossCost: 10800, energyCost: 2840, qualityLossCost: 2610, totalLossCost: 16250 },
    L02: { outputLossUnits: 110, oeeLossCost: 4950, energyCost: 1720, qualityLossCost: 1125, totalLossCost: 7795 },
    L03: { outputLossUnits: 50, oeeLossCost: 2250, energyCost: 1760, qualityLossCost: 585, totalLossCost: 4595 },
  },
  crisis: {
    L01: { outputLossUnits: 510, oeeLossCost: 22950, energyCost: 4250, qualityLossCost: 8100, totalLossCost: 35300 },
    L02: { outputLossUnits: 280, oeeLossCost: 12600, energyCost: 2100, qualityLossCost: 2700, totalLossCost: 17400 },
    L03: { outputLossUnits: 55, oeeLossCost: 2475, energyCost: 1780, qualityLossCost: 630, totalLossCost: 4885 },
  },
};

/**
 * 因果链数据（多视角根因分析的枢纽数据）。
 *
 * 解决"5Why 展开需要因果链 + 鱼骨图需要带证据的 5M1E 分支"问题。
 * CAUSAL_CHAIN 硬编码而非 LLM 推理，保证可测试、可复现。
 *
 * 设计：
 *   - symptom：表层症状（与 quality.defectRate / oee.decompose 等输出对齐）
 *   - chains：5Why 逐层追问链（现象→直接原因→...→根本原因）
 *   - fishbone：5M1E 六分支，每分支带证据引用（指向具体 mock 字段，非空泛描述）
 *
 * normal 场景无显著问题，chains/fishbone 为空（合理：无问题就无根因可溯）。
 */
export interface CausalChainData {
  symptom: string;
  chains: Array<{
    method: "5why";
    layers: string[];
    rootCause: string;
  }>;
  fishbone: {
    man: string[];
    machine: string[];
    material: string[];
    method: string[];
    environment: string[];
    measurement: string[];
  };
}

const CAUSAL_CHAIN: Record<ScenarioId, Record<LineId, CausalChainData>> = {
  normal: {
    L01: emptyChain("L01 工况正常"),
    L02: emptyChain("L02 工况正常"),
    L03: emptyChain("L03 工况正常"),
  },
  anomaly: {
    L01: {
      symptom: "L01 尺寸超差率 5.8%，Cpk 0.85 < 1.0（能力不足）",
      chains: [
        {
          method: "5why",
          layers: [
            "现象：尺寸超差率 5.8%，主缺陷类型为'尺寸超差'（占 42%）",
            "为何尺寸超差？主轴径向跳动 0.03mm 超规（标准 ≤0.02mm）",
            "为何主轴跳动超规？主轴前轴承磨损（间隙增大）",
            "为何轴承磨损加速？自动润滑系统供油不足",
            "根本原因：自动润滑泵滤网堵塞，导致供油不足 → 轴承异常磨损 → 主轴跳动 → 尺寸超差",
          ],
          rootCause: "自动润滑泵滤网堵塞（设备保养类）",
        },
      ],
      fishbone: {
        man: ["C 班夜班缺陷率比 A 班高 0.012（见 SHIFT_DEVIATION.L01.C）", "C 班含新员工未独立（见 PERSONNEL 班长B 郑师傅 level）"],
        machine: ["主轴健康分 0.62 < 0.7 阈值（见 EQUIPMENT.L01.healthScore）", "MTBF 降至 180h（正常 480h，见 EQUIPMENT.L01.mtbfHours）", "停机事件 3 起：模具卡死/传感器漂移/换模超时（见 EQUIPMENT.L01.downtimeEvents）"],
        material: ["近期来料批次切换，但单独不致超差（辅助因素）"],
        method: ["温度 197℃ 超标准 185℃（见 PROCESS.L01.parameters.温度）", "压力 4.8MPa 超标准 4.2MPa（见 PROCESS.L01.parameters.压力）"],
        environment: [],
        measurement: [],
      },
    },
    L02: {
      symptom: "L02 尺寸超差率 2.5%，工艺温度轻微漂移",
      chains: [
        {
          method: "5why",
          layers: [
            "现象：尺寸超差率 2.5%（略高于阈值 2%）",
            "为何尺寸超差？温度 189℃ 略超标准 180℃（工艺漂移）",
            "为何温度漂移？温控 PID 参数未随模具老化调整",
            "为何未调整？模具寿命管理缺定期校准触发点",
            "根本原因：模具寿命管理缺乏基于实际磨损的动态校准机制",
          ],
          rootCause: "模具寿命校准机制缺失（方法类）",
        },
      ],
      fishbone: {
        man: ["人员稳定，L3+ 占比 68%（见 PERSONNEL.L02.l3PlusRatio）"],
        machine: ["设备健康 0.85（尚可，见 EQUIPMENT.L02.healthScore）"],
        material: [],
        method: ["温度 189℃ > 标准 180℃（见 PROCESS.L02.parameters.温度）", "压力 4.1MPa > 标准 3.8MPa（见 PROCESS.L02.parameters.压力）"],
        environment: [],
        measurement: [],
      },
    },
    L03: emptyChain("L03 工况正常"),
  },
  crisis: {
    L01: {
      symptom: "L01 批量报废率 9.5%，主轴轴承断裂致停机 240min",
      chains: [
        {
          method: "5why",
          layers: [
            "现象：批量报废率 9.5%（180 件），主轴轴承断裂停机 240min",
            "为何轴承断裂？轴承长期超负荷运行未及时更换",
            "为何未及时更换？预防性维护周期基于时间而非基于状态",
            "为何基于时间？缺乏振动/温度状态监测的预测性维护体系",
            "根本原因：未建立基于状态的预测性维护（CBM），轴承磨损未被早期发现",
          ],
          rootCause: "预测性维护体系缺失（设备管理体系类）",
        },
        {
          method: "5why",
          layers: [
            "现象：能耗飙升 195kW（基线 88kW，+122%）",
            "为何能耗飙升？设备超负荷运转补偿机械损耗",
            "为何超负荷？主轴轴承磨损增加摩擦阻力",
            "为何磨损未被发现？无振动监测（同上一链）",
            "根本原因：与停机同一根因——预测性维护缺失（强关联）",
          ],
          rootCause: "预测性维护体系缺失（与停机同根因）",
        },
      ],
      fishbone: {
        man: ["停机响应滞后，操作员未识别早期振动征兆"],
        machine: ["主轴轴承断裂（见 EQUIPMENT.L01.downtimeEvents[0]）", "健康分 0.25 严重恶化（见 EQUIPMENT.L01.healthScore）", "电气控制柜故障 120min（见 EQUIPMENT.L01.downtimeEvents[1]）"],
        material: ["来料批次切换（辅助因素）"],
        method: ["温度 215℃ 严重超标准 185℃（见 PROCESS.L01.parameters.温度）", "压力 5.6MPa 严重超标准 4.2MPa（见 PROCESS.L01.parameters.压力）", "速度 950rpm < 标准 1200rpm（见 PROCESS.L01.parameters.速度）"],
        environment: [],
        measurement: [],
      },
    },
    L02: {
      symptom: "L02 缺料停机 180min，inventoryHours=12h 低于安全线",
      chains: [
        {
          method: "5why",
          layers: [
            "现象：缺料停机 180min（见 EQUIPMENT.L02.downtimeEvents）",
            "为何缺料？库存 12h 低于 24h 安全线（见 MATERIAL.L02.inventoryHours）",
            "为何库存低？采购订单未按实际消耗速率提前下单",
            "为何未提前？安全库存公式未考虑供应商交期波动",
            "根本原因：安全库存公式未纳入供应商交期波动参数（物料管理类）",
          ],
          rootCause: "安全库存公式缺供应商交期波动参数（物料管理类）",
        },
      ],
      fishbone: {
        man: ["物料计划员单点依赖，无替补（见 PERSONNEL.L02）"],
        machine: ["设备健康 0.55 偏低（见 EQUIPMENT.L02.healthScore）"],
        material: ["inventoryHours=12h < 24h 安全线（见 MATERIAL.L02.inventoryHours）", "shortageRisk=0.45（见 MATERIAL.L02.shortageRisk）"],
        method: ["安全库存公式未含交期波动参数"],
        environment: [],
        measurement: [],
      },
    },
    L03: emptyChain("L03 工况正常"),
  },
};

/** 工厂：normal 场景的空因果链（无问题则无根因）。 */
function emptyChain(reason: string): CausalChainData {
  return {
    symptom: reason,
    chains: [],
    fishbone: { man: [], machine: [], material: [], method: [], environment: [], measurement: [] },
  };
}

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

/** 班次维度 OEE：基准 + 班次偏移。 */
export function getOEEByShift(ctx: ScenarioContext) {
  const line = resolveLine(ctx);
  const base = OEE_BASE[ctx.scenarioId][line];
  return SHIFTS.map((shift) => {
    const dev = SHIFT_DEVIATION[line][shift];
    const oee = Math.max(0, base.oee + dev.oeeDelta);
    return {
      shift,
      oee: Number(oee.toFixed(4)),
      samples: shift === "A" ? 320 : shift === "B" ? 310 : 280,
    };
  });
}

/** 班次维度缺陷率：基准 + 班次偏移。 */
export function getQualityByShift(ctx: ScenarioContext) {
  const line = resolveLine(ctx);
  const base = QUALITY[ctx.scenarioId][line];
  return SHIFTS.map((shift) => {
    const dev = SHIFT_DEVIATION[line][shift];
    const defectRate = Math.max(0, base.defectRate + dev.defectRateDelta);
    return {
      shift,
      defectRate: Number(defectRate.toFixed(4)),
      fpy: Number(Math.min(0.999, base.fpy - dev.defectRateDelta).toFixed(4)),
    };
  });
}

/** 班次维度换模时间：基准 + 班次偏移。 */
export function getChangeoverByShift(ctx: ScenarioContext) {
  const line = resolveLine(ctx);
  const base = SCHEDULE[ctx.scenarioId][line];
  return SHIFTS.map((shift) => {
    const dev = SHIFT_DEVIATION[line][shift];
    return {
      shift,
      changeoverMinutes: Math.max(0, base.changeoverMinutesToday + dev.changeoverDeltaMin),
    };
  });
}

/** 人员技能矩阵（按产线）。 */
export function getPersonnel(ctx: ScenarioContext) {
  return PERSONNEL[resolveLine(ctx)];
}

/** 成本汇总（按场景 + 产线）。 */
export function getCost(ctx: ScenarioContext) {
  return COST[ctx.scenarioId][resolveLine(ctx)];
}

/**
 * 因果链数据（按场景 + 产线）。
 *
 * 5Why/鱼骨图工具的统一数据源。normal 场景 chains/fishbone 为空。
 */
export function getCausalChain(ctx: ScenarioContext): CausalChainData {
  return CAUSAL_CHAIN[ctx.scenarioId][resolveLine(ctx)];
}

/**
 * 工艺 PFMEA 失效模式清单（带 S/O/D + AP 行动优先级）。
 *
 * 从 PROCESS 参数派生：每参数的失效模式 = 该参数偏离致的质量/效率失效。
 * 输出与 AIAG-VDA 第五版对齐（AP 替代旧 RPN）。
 */
export function getProcessFmea(ctx: ScenarioContext) {
  const p = getProcess(ctx);
  const failureModes = Object.entries(p.parameters).map(([param, v]) => {
    const ap = computeAP(v.severity, v.occurrence, v.detection);
    const failureMode =
      param === "温度" ? "温度过高致材料降解/过低致欠固化"
      : param === "压力" ? "压力超标致模具损伤/飞边"
      : param === "速度" ? "速度偏离致节拍失稳/尺寸波动"
      : `${param}偏离致质量失效`;
    const effect = v.inSpec ? "轻微（当前在规格内）" : "显著（当前超规格，已触发缺陷）";
    const control =
      param === "温度" ? "温度报警 + 自动降温（SPC 监控）"
      : param === "压力" ? "压力安全阀 + 超限停机"
      : "速度闭环控制 + 巡检";
    return {
      param,
      failureMode,
      effect,
      severity: v.severity,
      occurrence: v.occurrence,
      detection: v.detection,
      ap,
      control,
      inSpec: v.inSpec,
    };
  });
  return {
    failureModes,
    highRisk: failureModes.filter((m) => m.ap === "H"),
    mediumRisk: failureModes.filter((m) => m.ap === "M"),
    lowRisk: failureModes.filter((m) => m.ap === "L"),
  };
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

/**
 * 查询 mock 动作工具产生的字段覆盖（action→read 因果链可观测）。
 *
 * 延迟导入 actionStore（避免 scenarios ↔ action-store 循环依赖）。
 * 读取工具在 getData 里对关键字段调此函数：若动作工具写过覆盖（如
 * mcp.process.adjust_parameters 写了 temperature=185），读取侧返回新值。
 *
 * @param ctx 场景上下文（line 缺省按 L01）
 * @param field 字段名（与动作工具 sideEffects 的 key 对齐，如 "temperature"）
 * @returns 覆盖值；未覆盖返回 undefined
 */
export function lookupActionOverride(ctx: ScenarioContext, field: string): unknown {
  return actionStore.lookupOverride(ctx.scenarioId, ctx.line, field);
}
