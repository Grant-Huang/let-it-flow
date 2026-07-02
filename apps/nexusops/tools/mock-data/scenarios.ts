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

// ─────────────────────────────────────────────────────────────────────────────
// 设备域数据：按真实系统来源拆分（MES 运行态 / PLM 可靠性 / IoT 健康 / ML 预测）
// ─────────────────────────────────────────────────────────────────────────────

/** 设备运行态数据（来源：MES）—— 实时状态 + 停机事件清单。 */
const EQUIPMENT_RUNTIME: Record<ScenarioId, Record<LineId, {
  status: "running" | "idle" | "down";
  downtimeEvents: Array<{ reason: string; minutes: number; at: string }>;
}>> = {
  normal: {
    L01: { status: "running", downtimeEvents: [] },
    L02: { status: "running", downtimeEvents: [] },
    L03: { status: "running", downtimeEvents: [] },
  },
  anomaly: {
    L01: {
      status: "running",
      downtimeEvents: [
        { reason: "模具卡死", minutes: 45, at: "2026-06-19T08:00:00Z" },
        { reason: "传感器漂移", minutes: 30, at: "2026-06-19T11:00:00Z" },
        { reason: "换模超时", minutes: 60, at: "2026-06-19T14:00:00Z" },
      ],
    },
    L02: { status: "running", downtimeEvents: [] },
    L03: { status: "running", downtimeEvents: [] },
  },
  crisis: {
    L01: {
      status: "down",
      downtimeEvents: [
        { reason: "主轴轴承断裂", minutes: 240, at: "2026-06-19T02:00:00Z" },
        { reason: "电气控制柜故障", minutes: 120, at: "2026-06-19T06:00:00Z" },
      ],
    },
    L02: { status: "idle", downtimeEvents: [{ reason: "物料缺料待机", minutes: 180, at: "2026-06-19T04:00:00Z" }] },
    L03: { status: "running", downtimeEvents: [] },
  },
};

/** 设备可靠性数据（来源：PLM/EAM）—— MTBF/MTTR，按 30 天窗口聚合。 */
const EQUIPMENT_RELIABILITY: Record<ScenarioId, Record<LineId, {
  mtbfHours: number; mttrMinutes: number;
}>> = {
  normal: {
    L01: { mtbfHours: 480, mttrMinutes: 35 },
    L02: { mtbfHours: 420, mttrMinutes: 40 },
    L03: { mtbfHours: 500, mttrMinutes: 30 },
  },
  anomaly: {
    L01: { mtbfHours: 180, mttrMinutes: 75 },
    L02: { mtbfHours: 350, mttrMinutes: 50 },
    L03: { mtbfHours: 490, mttrMinutes: 32 },
  },
  crisis: {
    L01: { mtbfHours: 60, mttrMinutes: 180 },
    L02: { mtbfHours: 120, mttrMinutes: 90 },
    L03: { mtbfHours: 470, mttrMinutes: 33 },
  },
};

/** 设备健康分（来源：IoT 振动/温度/电流信号融合）—— 0-1 评分，低于 0.7 预警。 */
const EQUIPMENT_HEALTH: Record<ScenarioId, Record<LineId, {
  healthScore: number;
}>> = {
  normal: {
    L01: { healthScore: 0.95 },
    L02: { healthScore: 0.92 },
    L03: { healthScore: 0.96 },
  },
  anomaly: {
    L01: { healthScore: 0.62 },
    L02: { healthScore: 0.85 },
    L03: { healthScore: 0.95 },
  },
  crisis: {
    L01: { healthScore: 0.25 },
    L02: { healthScore: 0.55 },
    L03: { healthScore: 0.94 },
  },
};

/** 设备故障预测（来源：ML 预测性维护模型）—— 未来 30 天故障风险概率。 */
const EQUIPMENT_FAILURE_RISK: Record<ScenarioId, Record<LineId, {
  failureRisk30d: number;
}>> = {
  normal: {
    L01: { failureRisk30d: 0.05 },
    L02: { failureRisk30d: 0.08 },
    L03: { failureRisk30d: 0.04 },
  },
  anomaly: {
    L01: { failureRisk30d: 0.35 },
    L02: { failureRisk30d: 0.15 },
    L03: { failureRisk30d: 0.05 },
  },
  crisis: {
    L01: { failureRisk30d: 0.85 },
    L02: { failureRisk30d: 0.40 },
    L03: { failureRisk30d: 0.06 },
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

// ─────────────────────────────────────────────────────────────────────────────
// 扩展数据域：工序路线 / 考勤 / 疲劳 / SPC 样本
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 工序路线数据（静态主数据，不随场景变化）。
 *
 * 按产线定义工序间路线（有向图），供 VSM 价值流分析、精益七大浪费中的
 * 运输浪费/等待浪费量化使用。来源：IE 部门标准工时表（季度更新）。
 *
 * 字段：
 *   - moveMin：标准搬运时间（分钟）
 *   - waitMin：工序间典型等待时间（排队待加工，分钟）
 *   - method：搬运方式
 */
export const ROUTING: Record<LineId, {
  processes: string[];
  routes: Array<{
    from: string; to: string;
    distanceM: number; moveMin: number; waitMin: number; method: string;
  }>;
}> = {
  L01: {
    processes: ["注塑", "去毛刺", "检验", "包装"],
    routes: [
      { from: "注塑", to: "去毛刺", distanceM: 12, moveMin: 0.8, waitMin: 15, method: "输送线" },
      { from: "去毛刺", to: "检验", distanceM: 8, moveMin: 0.5, waitMin: 25, method: "人工" },
      { from: "检验", to: "包装", distanceM: 6, moveMin: 0.4, waitMin: 10, method: "人工" },
    ],
  },
  L02: {
    processes: ["装配", "AOI检测", "功能测试", "包装"],
    routes: [
      { from: "装配", to: "AOI检测", distanceM: 6, moveMin: 0.3, waitMin: 8, method: "输送线" },
      { from: "AOI检测", to: "功能测试", distanceM: 10, moveMin: 0.6, waitMin: 20, method: "AGV" },
      { from: "功能测试", to: "包装", distanceM: 5, moveMin: 0.3, waitMin: 12, method: "人工" },
    ],
  },
  L03: {
    processes: ["CNC加工", "清洗", "检验", "包装"],
    routes: [
      { from: "CNC加工", to: "清洗", distanceM: 15, moveMin: 1.0, waitMin: 18, method: "悬挂链" },
      { from: "清洗", to: "检验", distanceM: 8, moveMin: 0.5, waitMin: 15, method: "人工" },
      { from: "检验", to: "包装", distanceM: 5, moveMin: 0.3, waitMin: 8, method: "人工" },
    ],
  },
};

/**
 * 考勤数据（按场景 × 产线 × 班次）。
 *
 * 用于班次差异诊断时交叉分析：缺岗 → 技能不足顶岗 → 缺陷率上升。
 * anomaly/crisis 场景 C 班（夜班）加班显著高于其他班。
 *
 * 字段：
 *   - present：实际出勤人数
 *   - overtimeHoursWeek：本周累计加班小时
 *   - leaveType：null=正常出勤，否则记录请假类型
 */
export const ATTENDANCE: Record<ScenarioId, Record<LineId, Record<ShiftId, {
  headcount: number;
  present: number;
  overtimeHoursWeek: number;
  lateMin: number;
  earlyLeaveMin: number;
  leaveType: string | null;
}>>> = {
  normal: {
    L01: {
      A: { headcount: 5, present: 5, overtimeHoursWeek: 4, lateMin: 0, earlyLeaveMin: 0, leaveType: null },
      B: { headcount: 5, present: 5, overtimeHoursWeek: 6, lateMin: 5, earlyLeaveMin: 0, leaveType: null },
      C: { headcount: 4, present: 4, overtimeHoursWeek: 8, lateMin: 0, earlyLeaveMin: 10, leaveType: null },
    },
    L02: {
      A: { headcount: 6, present: 6, overtimeHoursWeek: 3, lateMin: 0, earlyLeaveMin: 0, leaveType: null },
      B: { headcount: 6, present: 6, overtimeHoursWeek: 5, lateMin: 0, earlyLeaveMin: 0, leaveType: null },
      C: { headcount: 5, present: 5, overtimeHoursWeek: 7, lateMin: 10, earlyLeaveMin: 0, leaveType: null },
    },
    L03: {
      A: { headcount: 4, present: 4, overtimeHoursWeek: 2, lateMin: 0, earlyLeaveMin: 0, leaveType: null },
      B: { headcount: 4, present: 4, overtimeHoursWeek: 4, lateMin: 0, earlyLeaveMin: 0, leaveType: null },
      C: { headcount: 3, present: 3, overtimeHoursWeek: 6, lateMin: 5, earlyLeaveMin: 0, leaveType: null },
    },
  },
  anomaly: {
    L01: {
      A: { headcount: 5, present: 5, overtimeHoursWeek: 8, lateMin: 0, earlyLeaveMin: 0, leaveType: null },
      B: { headcount: 5, present: 4, overtimeHoursWeek: 12, lateMin: 15, earlyLeaveMin: 0, leaveType: "1人病假" },
      C: { headcount: 4, present: 3, overtimeHoursWeek: 18, lateMin: 0, earlyLeaveMin: 20, leaveType: "1人调休" },
    },
    L02: {
      A: { headcount: 6, present: 6, overtimeHoursWeek: 6, lateMin: 0, earlyLeaveMin: 0, leaveType: null },
      B: { headcount: 6, present: 6, overtimeHoursWeek: 8, lateMin: 5, earlyLeaveMin: 0, leaveType: null },
      C: { headcount: 5, present: 4, overtimeHoursWeek: 14, lateMin: 20, earlyLeaveMin: 0, leaveType: "1人事假" },
    },
    L03: {
      A: { headcount: 4, present: 4, overtimeHoursWeek: 4, lateMin: 0, earlyLeaveMin: 0, leaveType: null },
      B: { headcount: 4, present: 4, overtimeHoursWeek: 6, lateMin: 0, earlyLeaveMin: 0, leaveType: null },
      C: { headcount: 3, present: 3, overtimeHoursWeek: 10, lateMin: 10, earlyLeaveMin: 0, leaveType: null },
    },
  },
  crisis: {
    L01: {
      A: { headcount: 5, present: 4, overtimeHoursWeek: 16, lateMin: 10, earlyLeaveMin: 0, leaveType: "1人急诊" },
      B: { headcount: 5, present: 3, overtimeHoursWeek: 24, lateMin: 30, earlyLeaveMin: 0, leaveType: "2人过劳请假" },
      C: { headcount: 4, present: 2, overtimeHoursWeek: 32, lateMin: 0, earlyLeaveMin: 40, leaveType: "2人病假" },
    },
    L02: {
      A: { headcount: 6, present: 6, overtimeHoursWeek: 10, lateMin: 0, earlyLeaveMin: 0, leaveType: null },
      B: { headcount: 6, present: 5, overtimeHoursWeek: 15, lateMin: 10, earlyLeaveMin: 0, leaveType: "1人调休" },
      C: { headcount: 5, present: 4, overtimeHoursWeek: 22, lateMin: 25, earlyLeaveMin: 0, leaveType: "1人事假" },
    },
    L03: {
      A: { headcount: 4, present: 4, overtimeHoursWeek: 5, lateMin: 0, earlyLeaveMin: 0, leaveType: null },
      B: { headcount: 4, present: 4, overtimeHoursWeek: 7, lateMin: 0, earlyLeaveMin: 0, leaveType: null },
      C: { headcount: 3, present: 3, overtimeHoursWeek: 12, lateMin: 15, earlyLeaveMin: 0, leaveType: null },
    },
  },
};

/**
 * 疲劳评分数据（按场景 × 产线 × 班次）。
 *
 * 疲劳无法直接测量，用 5 个代理指标加权合成 0-1 评分：
 *   - continuousWorkMin：本班连续工作分钟（扣休息）
 *   - longestStretchMin：最长连续无休息时段
 *   - overtimeHoursWeek → consecutiveNights
 *   - restTakenMin：本班实际休息分钟
 *   - hourlyErrorRates：每小时错误率拐点（连续工作 X 小时后错误率飙升）
 *
 * 加权公式：0.30*连续工作 + 0.25*最长无休息 + 0.20*加班 + 0.15*连续夜班 + 0.10*休息不足
 */
export const FATIGUE: Record<ScenarioId, Record<LineId, Record<ShiftId, {
  fatigueScore: number;
  level: "low" | "medium" | "high" | "critical";
  continuousWorkMin: number;
  longestStretchMin: number;
  overtimeHoursWeek: number;
  consecutiveNights: number;
  restTakenMin: number;
  hourlyErrorRates: Array<{ hour: number; errorRate: number }>;
}>>> = {
  normal: {
    L01: {
      A: { fatigueScore: 0.22, level: "low", continuousWorkMin: 240, longestStretchMin: 120, overtimeHoursWeek: 4, consecutiveNights: 0, restTakenMin: 40, hourlyErrorRates: genHourlyErrors(0.012, 0.018) },
      B: { fatigueScore: 0.35, level: "low", continuousWorkMin: 280, longestStretchMin: 150, overtimeHoursWeek: 6, consecutiveNights: 0, restTakenMin: 30, hourlyErrorRates: genHourlyErrors(0.014, 0.022) },
      C: { fatigueScore: 0.48, level: "medium", continuousWorkMin: 300, longestStretchMin: 180, overtimeHoursWeek: 8, consecutiveNights: 3, restTakenMin: 25, hourlyErrorRates: genHourlyErrors(0.018, 0.028) },
    },
    L02: {
      A: { fatigueScore: 0.20, level: "low", continuousWorkMin: 240, longestStretchMin: 120, overtimeHoursWeek: 3, consecutiveNights: 0, restTakenMin: 40, hourlyErrorRates: genHourlyErrors(0.010, 0.016) },
      B: { fatigueScore: 0.30, level: "low", continuousWorkMin: 260, longestStretchMin: 140, overtimeHoursWeek: 5, consecutiveNights: 0, restTakenMin: 35, hourlyErrorRates: genHourlyErrors(0.012, 0.020) },
      C: { fatigueScore: 0.42, level: "medium", continuousWorkMin: 290, longestStretchMin: 160, overtimeHoursWeek: 7, consecutiveNights: 2, restTakenMin: 30, hourlyErrorRates: genHourlyErrors(0.015, 0.024) },
    },
    L03: {
      A: { fatigueScore: 0.18, level: "low", continuousWorkMin: 220, longestStretchMin: 110, overtimeHoursWeek: 2, consecutiveNights: 0, restTakenMin: 45, hourlyErrorRates: genHourlyErrors(0.008, 0.014) },
      B: { fatigueScore: 0.28, level: "low", continuousWorkMin: 250, longestStretchMin: 130, overtimeHoursWeek: 4, consecutiveNights: 0, restTakenMin: 35, hourlyErrorRates: genHourlyErrors(0.010, 0.018) },
      C: { fatigueScore: 0.40, level: "medium", continuousWorkMin: 280, longestStretchMin: 150, overtimeHoursWeek: 6, consecutiveNights: 2, restTakenMin: 30, hourlyErrorRates: genHourlyErrors(0.013, 0.022) },
    },
  },
  anomaly: {
    L01: {
      A: { fatigueScore: 0.45, level: "medium", continuousWorkMin: 300, longestStretchMin: 180, overtimeHoursWeek: 8, consecutiveNights: 0, restTakenMin: 25, hourlyErrorRates: genHourlyErrors(0.025, 0.045) },
      B: { fatigueScore: 0.62, level: "high", continuousWorkMin: 340, longestStretchMin: 210, overtimeHoursWeek: 12, consecutiveNights: 0, restTakenMin: 20, hourlyErrorRates: genHourlyErrors(0.030, 0.055) },
      C: { fatigueScore: 0.78, level: "high", continuousWorkMin: 380, longestStretchMin: 240, overtimeHoursWeek: 18, consecutiveNights: 5, restTakenMin: 15, hourlyErrorRates: genHourlyErrors(0.035, 0.072) },
    },
    L02: {
      A: { fatigueScore: 0.35, level: "low", continuousWorkMin: 260, longestStretchMin: 140, overtimeHoursWeek: 6, consecutiveNights: 0, restTakenMin: 35, hourlyErrorRates: genHourlyErrors(0.018, 0.030) },
      B: { fatigueScore: 0.48, level: "medium", continuousWorkMin: 290, longestStretchMin: 170, overtimeHoursWeek: 8, consecutiveNights: 0, restTakenMin: 30, hourlyErrorRates: genHourlyErrors(0.022, 0.038) },
      C: { fatigueScore: 0.65, level: "high", continuousWorkMin: 340, longestStretchMin: 200, overtimeHoursWeek: 14, consecutiveNights: 4, restTakenMin: 20, hourlyErrorRates: genHourlyErrors(0.028, 0.052) },
    },
    L03: {
      A: { fatigueScore: 0.28, level: "low", continuousWorkMin: 240, longestStretchMin: 130, overtimeHoursWeek: 4, consecutiveNights: 0, restTakenMin: 40, hourlyErrorRates: genHourlyErrors(0.012, 0.020) },
      B: { fatigueScore: 0.38, level: "low", continuousWorkMin: 270, longestStretchMin: 150, overtimeHoursWeek: 6, consecutiveNights: 0, restTakenMin: 30, hourlyErrorRates: genHourlyErrors(0.015, 0.025) },
      C: { fatigueScore: 0.52, level: "medium", continuousWorkMin: 310, longestStretchMin: 180, overtimeHoursWeek: 10, consecutiveNights: 3, restTakenMin: 25, hourlyErrorRates: genHourlyErrors(0.020, 0.038) },
    },
  },
  crisis: {
    L01: {
      A: { fatigueScore: 0.72, level: "high", continuousWorkMin: 360, longestStretchMin: 240, overtimeHoursWeek: 16, consecutiveNights: 0, restTakenMin: 15, hourlyErrorRates: genHourlyErrors(0.040, 0.085) },
      B: { fatigueScore: 0.88, level: "critical", continuousWorkMin: 420, longestStretchMin: 300, overtimeHoursWeek: 24, consecutiveNights: 0, restTakenMin: 10, hourlyErrorRates: genHourlyErrors(0.055, 0.120) },
      C: { fatigueScore: 0.95, level: "critical", continuousWorkMin: 460, longestStretchMin: 340, overtimeHoursWeek: 32, consecutiveNights: 7, restTakenMin: 5, hourlyErrorRates: genHourlyErrors(0.065, 0.150) },
    },
    L02: {
      A: { fatigueScore: 0.48, level: "medium", continuousWorkMin: 290, longestStretchMin: 170, overtimeHoursWeek: 10, consecutiveNights: 0, restTakenMin: 30, hourlyErrorRates: genHourlyErrors(0.025, 0.045) },
      B: { fatigueScore: 0.62, level: "high", continuousWorkMin: 330, longestStretchMin: 200, overtimeHoursWeek: 15, consecutiveNights: 0, restTakenMin: 20, hourlyErrorRates: genHourlyErrors(0.032, 0.058) },
      C: { fatigueScore: 0.80, level: "high", continuousWorkMin: 380, longestStretchMin: 240, overtimeHoursWeek: 22, consecutiveNights: 5, restTakenMin: 15, hourlyErrorRates: genHourlyErrors(0.042, 0.078) },
    },
    L03: {
      A: { fatigueScore: 0.32, level: "low", continuousWorkMin: 260, longestStretchMin: 140, overtimeHoursWeek: 5, consecutiveNights: 0, restTakenMin: 35, hourlyErrorRates: genHourlyErrors(0.014, 0.024) },
      B: { fatigueScore: 0.42, level: "medium", continuousWorkMin: 290, longestStretchMin: 160, overtimeHoursWeek: 7, consecutiveNights: 0, restTakenMin: 30, hourlyErrorRates: genHourlyErrors(0.018, 0.032) },
      C: { fatigueScore: 0.58, level: "medium", continuousWorkMin: 320, longestStretchMin: 190, overtimeHoursWeek: 12, consecutiveNights: 4, restTakenMin: 20, hourlyErrorRates: genHourlyErrors(0.024, 0.045) },
    },
  },
};

/**
 * SPC 样本数据（按场景 × 产线）。
 *
 * 解决旧版 quality.spc 只有 5 个样本点、单一尺寸的问题。
 * 每组含多关键尺寸 × 30 个连续样本（满足 25+ 标准），anomaly/crisis 场景含漂移趋势。
 * subgroupSize=5 用于 X-bar R 图分组。
 */
export const SPC_SAMPLES: Record<ScenarioId, Record<LineId, {
  dimensions: Array<{
    name: string;
    target: number;
    usl: number;
    lsl: number;
    unit: string;
    samples: number[];
    subgroupSize: number;
  }>;
}>> = {
  normal: {
    L01: {
      dimensions: [
        { name: "外径", target: 10.00, usl: 10.20, lsl: 9.80, unit: "mm", subgroupSize: 5,
          samples: genSpcSamples(10.00, 0.03, 30, 0) },
        { name: "壁厚", target: 2.50, usl: 2.60, lsl: 2.40, unit: "mm", subgroupSize: 5,
          samples: genSpcSamples(2.50, 0.02, 30, 0) },
        { name: "长度", target: 50.00, usl: 50.50, lsl: 49.50, unit: "mm", subgroupSize: 5,
          samples: genSpcSamples(50.00, 0.08, 30, 0) },
      ],
    },
    L02: {
      dimensions: [
        { name: "孔径", target: 8.00, usl: 8.15, lsl: 7.85, unit: "mm", subgroupSize: 5,
          samples: genSpcSamples(8.00, 0.025, 30, 0) },
        { name: "装配间隙", target: 0.10, usl: 0.15, lsl: 0.05, unit: "mm", subgroupSize: 5,
          samples: genSpcSamples(0.10, 0.008, 30, 0) },
      ],
    },
    L03: {
      dimensions: [
        { name: "外径", target: 25.00, usl: 25.10, lsl: 24.90, unit: "mm", subgroupSize: 5,
          samples: genSpcSamples(25.00, 0.015, 30, 0) },
        { name: "表面粗糙度", target: 1.60, usl: 2.00, lsl: 1.20, unit: "μm", subgroupSize: 5,
          samples: genSpcSamples(1.60, 0.08, 30, 0) },
      ],
    },
  },
  anomaly: {
    L01: {
      dimensions: [
        { name: "外径", target: 10.00, usl: 10.20, lsl: 9.80, unit: "mm", subgroupSize: 5,
          samples: genSpcSamples(10.00, 0.04, 30, 0.08) },
        { name: "壁厚", target: 2.50, usl: 2.60, lsl: 2.40, unit: "mm", subgroupSize: 5,
          samples: genSpcSamples(2.50, 0.03, 30, 0.06) },
        { name: "长度", target: 50.00, usl: 50.50, lsl: 49.50, unit: "mm", subgroupSize: 5,
          samples: genSpcSamples(50.00, 0.10, 30, 0.15) },
      ],
    },
    L02: {
      dimensions: [
        { name: "孔径", target: 8.00, usl: 8.15, lsl: 7.85, unit: "mm", subgroupSize: 5,
          samples: genSpcSamples(8.00, 0.03, 30, 0.05) },
        { name: "装配间隙", target: 0.10, usl: 0.15, lsl: 0.05, unit: "mm", subgroupSize: 5,
          samples: genSpcSamples(0.10, 0.010, 30, 0.02) },
      ],
    },
    L03: {
      dimensions: [
        { name: "外径", target: 25.00, usl: 25.10, lsl: 24.90, unit: "mm", subgroupSize: 5,
          samples: genSpcSamples(25.00, 0.018, 30, 0.02) },
        { name: "表面粗糙度", target: 1.60, usl: 2.00, lsl: 1.20, unit: "μm", subgroupSize: 5,
          samples: genSpcSamples(1.60, 0.10, 30, 0.05) },
      ],
    },
  },
  crisis: {
    L01: {
      dimensions: [
        { name: "外径", target: 10.00, usl: 10.20, lsl: 9.80, unit: "mm", subgroupSize: 5,
          samples: genSpcSamples(10.00, 0.06, 30, 0.18) },
        { name: "壁厚", target: 2.50, usl: 2.60, lsl: 2.40, unit: "mm", subgroupSize: 5,
          samples: genSpcSamples(2.50, 0.05, 30, 0.12) },
        { name: "长度", target: 50.00, usl: 50.50, lsl: 49.50, unit: "mm", subgroupSize: 5,
          samples: genSpcSamples(50.00, 0.15, 30, 0.30) },
      ],
    },
    L02: {
      dimensions: [
        { name: "孔径", target: 8.00, usl: 8.15, lsl: 7.85, unit: "mm", subgroupSize: 5,
          samples: genSpcSamples(8.00, 0.04, 30, 0.10) },
        { name: "装配间隙", target: 0.10, usl: 0.15, lsl: 0.05, unit: "mm", subgroupSize: 5,
          samples: genSpcSamples(0.10, 0.015, 30, 0.04) },
      ],
    },
    L03: {
      dimensions: [
        { name: "外径", target: 25.00, usl: 25.10, lsl: 24.90, unit: "mm", subgroupSize: 5,
          samples: genSpcSamples(25.00, 0.022, 30, 0.04) },
        { name: "表面粗糙度", target: 1.60, usl: 2.00, lsl: 1.20, unit: "μm", subgroupSize: 5,
          samples: genSpcSamples(1.60, 0.12, 30, 0.08) },
      ],
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 车间环境数据（来源：EMS/IoT 环境传感器）—— 补全 5M1E 的"环 Environment"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 车间环境数据（按场景 × 产线）。
 *
 * 注塑/CNC 对温湿度敏感：高温致塑料降解、高湿致吸潮气泡。
 * anomaly/crisis 场景 L01 夏季空调故障或除湿机失效，环境成为质量根因之一。
 */
export const ENVIRONMENT: Record<ScenarioId, Record<LineId, {
  tempC: number;        // 车间温度（℃），标准 25±3
  tempStandardC: number;
  humidityPct: number;  // 相对湿度（%），注塑宜 ≤60%
  humidityStandardPct: number;
  cleanlinessIso: number; // 洁净度等级（ISO 7=普通，ISO 8=较差）
  hvacStatus: "ok" | "degraded" | "failed";
}>> = {
  normal: {
    L01: { tempC: 24, tempStandardC: 25, humidityPct: 52, humidityStandardPct: 60, cleanlinessIso: 7, hvacStatus: "ok" },
    L02: { tempC: 24, tempStandardC: 25, humidityPct: 54, humidityStandardPct: 60, cleanlinessIso: 7, hvacStatus: "ok" },
    L03: { tempC: 23, tempStandardC: 25, humidityPct: 50, humidityStandardPct: 60, cleanlinessIso: 7, hvacStatus: "ok" },
  },
  anomaly: {
    L01: { tempC: 31, tempStandardC: 25, humidityPct: 74, humidityStandardPct: 60, cleanlinessIso: 8, hvacStatus: "degraded" },
    L02: { tempC: 26, tempStandardC: 25, humidityPct: 58, humidityStandardPct: 60, cleanlinessIso: 7, hvacStatus: "ok" },
    L03: { tempC: 24, tempStandardC: 25, humidityPct: 52, humidityStandardPct: 60, cleanlinessIso: 7, hvacStatus: "ok" },
  },
  crisis: {
    L01: { tempC: 34, tempStandardC: 25, humidityPct: 82, humidityStandardPct: 60, cleanlinessIso: 8, hvacStatus: "failed" },
    L02: { tempC: 28, tempStandardC: 25, humidityPct: 66, humidityStandardPct: 60, cleanlinessIso: 8, hvacStatus: "degraded" },
    L03: { tempC: 24, tempStandardC: 25, humidityPct: 51, humidityStandardPct: 60, cleanlinessIso: 7, hvacStatus: "ok" },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 测量系统分析数据（来源：QMS 量具 R&R）—— 补全 5M1E 的"测 Measurement"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 测量系统分析（Gage R&R）数据（按场景 × 产线）。
 *
 * R&R% > 10% 表示测量系统不可接受，会导致"假不合格/假合格"。
 * anomaly/crisis 场景 L01 的 CMM 三坐标超校准周期，检验员判定标准不一。
 *
 * 字段：
 *   - rrPct：重复性+再现性占公差百分比（<10% 可接受，10-30% 有条件，>30% 不可接受）
 *   - lastCalibration：上次校准日期
 *   - calibrationDueMonths：校准周期（月）
 */
export const GAGE_RNR: Record<ScenarioId, Record<LineId, {
  rrPct: number;
  repeatabilityPct: number;   // 重复性（同一检验员多次测量差异）
  reproducibilityPct: number; // 再现性（不同检验员之间差异）
  lastCalibration: string;
  calibrationDueMonths: number;
  monthsSinceLastCal: number;
  gages: Array<{ name: string; type: string; status: "ok" | "due" | "overdue" }>;
}>> = {
  normal: {
    L01: {
      rrPct: 7.2, repeatabilityPct: 4.1, reproducibilityPct: 3.1,
      lastCalibration: "2026-03-15", calibrationDueMonths: 6, monthsSinceLastCal: 3,
      gages: [
        { name: "CMM 三坐标 #1", type: "坐标测量机", status: "ok" },
        { name: "千分尺组", type: "通用量具", status: "ok" },
      ],
    },
    L02: {
      rrPct: 8.5, repeatabilityPct: 5.0, reproducibilityPct: 3.5,
      lastCalibration: "2026-02-20", calibrationDueMonths: 6, monthsSinceLastCal: 4,
      gages: [
        { name: "AOI 检测仪 #1", type: "光学检测", status: "ok" },
        { name: "塞规组", type: "极限量规", status: "ok" },
      ],
    },
    L03: {
      rrPct: 6.8, repeatabilityPct: 3.8, reproducibilityPct: 3.0,
      lastCalibration: "2026-04-10", calibrationDueMonths: 6, monthsSinceLastCal: 2,
      gages: [
        { name: "粗糙度仪", type: "表面测量", status: "ok" },
        { name: "千分尺组", type: "通用量具", status: "ok" },
      ],
    },
  },
  anomaly: {
    L01: {
      rrPct: 18.5, repeatabilityPct: 9.2, reproducibilityPct: 9.3,
      lastCalibration: "2025-11-08", calibrationDueMonths: 6, monthsSinceLastCal: 8,
      gages: [
        { name: "CMM 三坐标 #1", type: "坐标测量机", status: "overdue" },
        { name: "千分尺组", type: "通用量具", status: "ok" },
      ],
    },
    L02: {
      rrPct: 11.2, repeatabilityPct: 6.0, reproducibilityPct: 5.2,
      lastCalibration: "2026-01-05", calibrationDueMonths: 6, monthsSinceLastCal: 6,
      gages: [
        { name: "AOI 检测仪 #1", type: "光学检测", status: "due" },
        { name: "塞规组", type: "极限量规", status: "ok" },
      ],
    },
    L03: {
      rrPct: 7.0, repeatabilityPct: 3.9, reproducibilityPct: 3.1,
      lastCalibration: "2026-04-10", calibrationDueMonths: 6, monthsSinceLastCal: 2,
      gages: [
        { name: "粗糙度仪", type: "表面测量", status: "ok" },
        { name: "千分尺组", type: "通用量具", status: "ok" },
      ],
    },
  },
  crisis: {
    L01: {
      rrPct: 32.0, repeatabilityPct: 15.5, reproducibilityPct: 16.5,
      lastCalibration: "2025-09-20", calibrationDueMonths: 6, monthsSinceLastCal: 10,
      gages: [
        { name: "CMM 三坐标 #1", type: "坐标测量机", status: "overdue" },
        { name: "千分尺组", type: "通用量具", status: "overdue" },
      ],
    },
    L02: {
      rrPct: 14.8, repeatabilityPct: 7.8, reproducibilityPct: 7.0,
      lastCalibration: "2025-12-15", calibrationDueMonths: 6, monthsSinceLastCal: 7,
      gages: [
        { name: "AOI 检测仪 #1", type: "光学检测", status: "overdue" },
        { name: "塞规组", type: "极限量规", status: "due" },
      ],
    },
    L03: {
      rrPct: 7.2, repeatabilityPct: 4.0, reproducibilityPct: 3.2,
      lastCalibration: "2026-04-10", calibrationDueMonths: 6, monthsSinceLastCal: 2,
      gages: [
        { name: "粗糙度仪", type: "表面测量", status: "ok" },
        { name: "千分尺组", type: "通用量具", status: "ok" },
      ],
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 供应商链数据（来源：ERP 采购 + SQM 供应商质量）—— 补全物料短缺的供应链深度
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 关键料号供应商数据（按场景 × 产线）。
 *
 * 解决物料短缺诊断停在"库存低"的问题：补充到料号级 + 供应商级，
 * 让 material.shortage / material.supply_risk 能定位"哪个料、哪个供应商、交期漂移多少"。
 *
 * anomaly/crisis 场景 L02 主料供应商交期波动加剧、OTD 下降，是缺料根因。
 *
 * 字段：
 *   - leadTimeDays / actualLeadTimeDays：标准 vs 实际交期（差异=波动）
 *   - otdRate：准时交付率（On-Time Delivery）
 *   - dppm：来料不合格百万分率（Defective Parts Per Million）
 */
export const SUPPLIER: Record<ScenarioId, Record<LineId, {
  criticalParts: Array<{
    partNo: string;
    name: string;
    supplier: string;
    leadTimeDays: number;
    actualLeadTimeDays: number;
    otdRate: number;
    dppm: number;
    safetyStockDays: number;
    soleSourced: boolean;
  }>;
  supplyRiskScore: number;
}>> = {
  normal: {
    L01: {
      criticalParts: [
        { partNo: "P-1001", name: "PP 塑料颗粒", supplier: "华塑材料", leadTimeDays: 7, actualLeadTimeDays: 7.5, otdRate: 0.96, dppm: 800, safetyStockDays: 14, soleSourced: false },
        { partNo: "P-1002", name: "主轴轴承", supplier: "精机轴承", leadTimeDays: 14, actualLeadTimeDays: 15, otdRate: 0.94, dppm: 300, safetyStockDays: 30, soleSourced: true },
      ],
      supplyRiskScore: 0.12,
    },
    L02: {
      criticalParts: [
        { partNo: "P-2001", name: "PCB 板", supplier: "芯电科技", leadTimeDays: 10, actualLeadTimeDays: 10.5, otdRate: 0.95, dppm: 500, safetyStockDays: 21, soleSourced: false },
        { partNo: "P-2002", name: "连接器", supplier: "联接电子", leadTimeDays: 7, actualLeadTimeDays: 7, otdRate: 0.97, dppm: 200, safetyStockDays: 14, soleSourced: false },
      ],
      supplyRiskScore: 0.10,
    },
    L03: {
      criticalParts: [
        { partNo: "P-3001", name: "铝合金棒料", supplier: "轻金材料", leadTimeDays: 12, actualLeadTimeDays: 12, otdRate: 0.96, dppm: 150, safetyStockDays: 30, soleSourced: false },
      ],
      supplyRiskScore: 0.08,
    },
  },
  anomaly: {
    L01: {
      criticalParts: [
        { partNo: "P-1001", name: "PP 塑料颗粒", supplier: "华塑材料", leadTimeDays: 7, actualLeadTimeDays: 11, otdRate: 0.82, dppm: 2400, safetyStockDays: 14, soleSourced: false },
        { partNo: "P-1002", name: "主轴轴承", supplier: "精机轴承", leadTimeDays: 14, actualLeadTimeDays: 18, otdRate: 0.85, dppm: 1200, safetyStockDays: 30, soleSourced: true },
      ],
      supplyRiskScore: 0.38,
    },
    L02: {
      criticalParts: [
        { partNo: "P-2001", name: "PCB 板", supplier: "芯电科技", leadTimeDays: 10, actualLeadTimeDays: 14, otdRate: 0.78, dppm: 1800, safetyStockDays: 21, soleSourced: false },
        { partNo: "P-2002", name: "连接器", supplier: "联接电子", leadTimeDays: 7, actualLeadTimeDays: 9, otdRate: 0.88, dppm: 600, safetyStockDays: 14, soleSourced: false },
      ],
      supplyRiskScore: 0.42,
    },
    L03: {
      criticalParts: [
        { partNo: "P-3001", name: "铝合金棒料", supplier: "轻金材料", leadTimeDays: 12, actualLeadTimeDays: 13, otdRate: 0.93, dppm: 200, safetyStockDays: 30, soleSourced: false },
      ],
      supplyRiskScore: 0.12,
    },
  },
  crisis: {
    L01: {
      criticalParts: [
        { partNo: "P-1001", name: "PP 塑料颗粒", supplier: "华塑材料", leadTimeDays: 7, actualLeadTimeDays: 16, otdRate: 0.62, dppm: 8500, safetyStockDays: 14, soleSourced: false },
        { partNo: "P-1002", name: "主轴轴承", supplier: "精机轴承", leadTimeDays: 14, actualLeadTimeDays: 28, otdRate: 0.55, dppm: 4200, safetyStockDays: 30, soleSourced: true },
      ],
      supplyRiskScore: 0.78,
    },
    L02: {
      criticalParts: [
        { partNo: "P-2001", name: "PCB 板", supplier: "芯电科技", leadTimeDays: 10, actualLeadTimeDays: 21, otdRate: 0.58, dppm: 6200, safetyStockDays: 21, soleSourced: false },
        { partNo: "P-2002", name: "连接器", supplier: "联接电子", leadTimeDays: 7, actualLeadTimeDays: 14, otdRate: 0.72, dppm: 2100, safetyStockDays: 14, soleSourced: false },
      ],
      supplyRiskScore: 0.72,
    },
    L03: {
      criticalParts: [
        { partNo: "P-3001", name: "铝合金棒料", supplier: "轻金材料", leadTimeDays: 12, actualLeadTimeDays: 14, otdRate: 0.90, dppm: 250, safetyStockDays: 30, soleSourced: false },
      ],
      supplyRiskScore: 0.15,
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 设备台账数据（来源：EAM 设备资产管理）—— 把产线级聚合定位到单台设备
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 设备台账（按产线，静态主数据 + 单台健康分）。
 *
 * 解决设备数据停在"产线级聚合"的问题：补充到资产号级，
 * 让 equipment.health 能定位"产线 0.62 中主轴 0.25 是瓶颈"。
 *
 * 单台 healthScore 按场景取值（与 EQUIPMENT_HEALTH 产线级对齐为加权平均）：
 *   - normal：全部健康
 *   - anomaly/crisis：关键设备（主轴/注塑机）恶化，辅助设备基本正常
 *
 * 字段：
 *   - criticality：A=关键（停机致全线停）、B=重要、C=辅助
 *   - ageYears：役龄
 *   - healthScore：单台健康分（产线级是其加权平均）
 */
export const EQUIPMENT_INVENTORY: Record<LineId, {
  machines: Array<{
    assetNo: string;
    name: string;
    criticality: "A" | "B" | "C";
    ageYears: number;
    healthByScenario: Record<ScenarioId, number>;
    lastMaintenance: string;
    nextDueMaintenance: string;
    isBottleneck: boolean;
  }>;
}> = {
  L01: {
    machines: [
      {
        assetNo: "EQ-L01-001", name: "注塑机 #1（主设备）", criticality: "A", ageYears: 7,
        healthByScenario: { normal: 0.95, anomaly: 0.45, crisis: 0.15 },
        lastMaintenance: "2026-04-20", nextDueMaintenance: "2026-07-20", isBottleneck: true,
      },
      {
        assetNo: "EQ-L01-002", name: "主轴（含轴承组）", criticality: "A", ageYears: 5,
        healthByScenario: { normal: 0.96, anomaly: 0.55, crisis: 0.20 },
        lastMaintenance: "2026-03-15", nextDueMaintenance: "2026-06-15", isBottleneck: false,
      },
      {
        assetNo: "EQ-L01-003", name: "自动润滑系统", criticality: "B", ageYears: 4,
        healthByScenario: { normal: 0.94, anomaly: 0.68, crisis: 0.40 },
        lastMaintenance: "2026-05-01", nextDueMaintenance: "2026-08-01", isBottleneck: false,
      },
      {
        assetNo: "EQ-L01-004", name: "去毛刺机器人", criticality: "B", ageYears: 3,
        healthByScenario: { normal: 0.97, anomaly: 0.90, crisis: 0.75 },
        lastMaintenance: "2026-04-10", nextDueMaintenance: "2026-07-10", isBottleneck: false,
      },
      {
        assetNo: "EQ-L01-005", name: "包装输送线", criticality: "C", ageYears: 6,
        healthByScenario: { normal: 0.93, anomaly: 0.88, crisis: 0.80 },
        lastMaintenance: "2026-03-30", nextDueMaintenance: "2026-06-30", isBottleneck: false,
      },
    ],
  },
  L02: {
    machines: [
      {
        assetNo: "EQ-L02-001", name: "装配线主线", criticality: "A", ageYears: 6,
        healthByScenario: { normal: 0.92, anomaly: 0.82, crisis: 0.50 },
        lastMaintenance: "2026-04-25", nextDueMaintenance: "2026-07-25", isBottleneck: true,
      },
      {
        assetNo: "EQ-L02-002", name: "AOI 检测仪 #1", criticality: "A", ageYears: 4,
        healthByScenario: { normal: 0.95, anomaly: 0.85, crisis: 0.55 },
        lastMaintenance: "2026-03-20", nextDueMaintenance: "2026-06-20", isBottleneck: false,
      },
      {
        assetNo: "EQ-L02-003", name: "功能测试台", criticality: "B", ageYears: 5,
        healthByScenario: { normal: 0.94, anomaly: 0.88, crisis: 0.70 },
        lastMaintenance: "2026-04-15", nextDueMaintenance: "2026-07-15", isBottleneck: false,
      },
      {
        assetNo: "EQ-L02-004", name: "AGV 搬运车 #1", criticality: "C", ageYears: 3,
        healthByScenario: { normal: 0.96, anomaly: 0.90, crisis: 0.82 },
        lastMaintenance: "2026-05-05", nextDueMaintenance: "2026-08-05", isBottleneck: false,
      },
    ],
  },
  L03: {
    machines: [
      {
        assetNo: "EQ-L03-001", name: "CNC 加工中心 #1", criticality: "A", ageYears: 8,
        healthByScenario: { normal: 0.94, anomaly: 0.92, crisis: 0.88 },
        lastMaintenance: "2026-04-12", nextDueMaintenance: "2026-07-12", isBottleneck: true,
      },
      {
        assetNo: "EQ-L03-002", name: "清洗机", criticality: "B", ageYears: 5,
        healthByScenario: { normal: 0.95, anomaly: 0.93, crisis: 0.90 },
        lastMaintenance: "2026-03-28", nextDueMaintenance: "2026-06-28", isBottleneck: false,
      },
      {
        assetNo: "EQ-L03-003", name: "悬挂链输送", criticality: "C", ageYears: 7,
        healthByScenario: { normal: 0.93, anomaly: 0.91, crisis: 0.85 },
        lastMaintenance: "2026-04-02", nextDueMaintenance: "2026-07-02", isBottleneck: false,
      },
    ],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// 单位经济性数据（来源：ERP 财务主数据）—— 成本汇算的真实单价依据
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 各产线的单位经济性参数（静态主数据，按产线区分产品类型）。
 *
 * 解决 cost-summary skill 用魔法数字（OEE 损失 45 元/件、报废 75 元/件）的问题：
 * L01 注塑件、L02 电子装配、L03 CNC 件 的单位产值/成本差异巨大。
 * 真实部署后由 ERP 财务模块提供，定期（月度）更新。
 *
 * 字段：
 *   - unitPrice：单件售价（元）
 *   - unitCost：单件制造成本（元，含料+工+费）
 *   - scrapCostPerUnit：报废单件沉没成本
 *   - reworkCostPerUnit：返工单件追加成本
 *   - energyPricePerKwh：电价（元/kWh）
 *   - laborCostPerHour：人工小时费率（元）
 *   - dailyTargetUnits：日目标产量
 */
export const UNIT_ECONOMICS: Record<LineId, {
  productType: string;
  unitPrice: number;
  unitCost: number;
  scrapCostPerUnit: number;
  reworkCostPerUnit: number;
  energyPricePerKwh: number;
  laborCostPerHour: number;
  dailyTargetUnits: number;
}> = {
  L01: {
    productType: "注塑件（PP 塑料外壳）",
    unitPrice: 45,
    unitCost: 28,
    scrapCostPerUnit: 75,    // 报废沉没 = 料 22 + 工费 3 + 处置 50
    reworkCostPerUnit: 18,   // 返工 = 去毛刺/修边 + 复检
    energyPricePerKwh: 0.85,
    laborCostPerHour: 65,
    dailyTargetUnits: 1000,
  },
  L02: {
    productType: "电子装配组件（PCBA）",
    unitPrice: 120,
    unitCost: 78,
    scrapCostPerUnit: 180,   // 含 PCB + 贴片元件沉没
    reworkCostPerUnit: 45,   // 含返修焊 + 复测
    energyPricePerKwh: 0.82,
    laborCostPerHour: 72,
    dailyTargetUnits: 600,
  },
  L03: {
    productType: "CNC 精密件（铝合金结构件）",
    unitPrice: 210,
    unitCost: 135,
    scrapCostPerUnit: 260,   // 含铝合金原料 + 机加工工时
    reworkCostPerUnit: 80,   // 含补加工 + 复检
    energyPricePerKwh: 0.88,
    laborCostPerHour: 85,
    dailyTargetUnits: 400,
  },
};


/** 生成 SPC 样本序列（确定性，无 Math.random，保证可测试）。 */
function genSpcSamples(target: number, sigma: number, count: number, drift: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < count; i++) {
    // 用确定性伪随机（sin 函数）模拟正态分布波动 + 线性漂移
    const noise = Math.sin(i * 1.7 + target) * sigma * 0.6 + Math.sin(i * 3.1) * sigma * 0.4;
    const trend = drift > 0 ? (i / count) * drift : 0;
    result.push(Number((target + noise + trend).toFixed(4)));
  }
  return result;
}

/** 生成每小时错误率（8 小时，确定性趋势上升）。 */
function genHourlyErrors(base: number, peak: number): Array<{ hour: number; errorRate: number }> {
  const result: Array<{ hour: number; errorRate: number }> = [];
  for (let h = 1; h <= 8; h++) {
    const t = (h - 1) / 7;
    const rate = base + (peak - base) * t * t;
    result.push({ hour: h, errorRate: Number(rate.toFixed(4)) });
  }
  return result;
}

/**
 * 生成 N 天趋势序列（确定性，可复现）。
 *
 * 从"今天值"反推历史曲线：根据场景方向插值到"基线值"，
 * 叠加 sin 伪随机波动。让质量/能耗/健康/工艺等单点快照指标获得时间维度。
 *
 * @param current   今天值（序列末位）
 * @param baseline  N 天前的基线值（场景稳定时的正常水平）
 * @param days      天数（默认 7）
 * @param sigma     波动幅度（相对 current 的比例，默认 0.02）
 * @returns 从旧→新的 N 个值，末位 ≈ current
 */
function genTrend(current: number, baseline: number, days = 7, sigma = 0.02): number[] {
  const out: number[] = [];
  for (let i = 0; i < days; i++) {
    const t = i / (days - 1);                       // 0（最旧）→ 1（今天）
    const lin = baseline + (current - baseline) * t; // 线性插值
    const noise = (Math.sin(i * 1.9 + current) * 0.6 + Math.sin(i * 3.3) * 0.4) * sigma * lin;
    out.push(Number((lin + noise).toFixed(4)));
  }
  return out;
}

/**
 * 生成 24 小时每小时序列（确定性，用于功率曲线 / 缺陷率日内分布）。
 *
 * 支持双峰（白班 + 夜班）生产模式：在班次交接处有低谷。
 */
function genHourly24(peak: number, valley: number): number[] {
  const out: number[] = [];
  for (let h = 0; h < 24; h++) {
    // 8-19 点为高负荷（白班+晚班），0-6/22-23 为低谷
    const load = h >= 8 && h <= 19 ? 1 : h >= 6 && h <= 21 ? 0.7 : 0.3;
    const v = valley + (peak - valley) * load;
    const noise = Math.sin(h * 1.3 + peak) * 0.015 * v;
    out.push(Number((v + noise).toFixed(2)));
  }
  return out;
}

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
        environment: ["车间温度 31℃ 超标准 25±3℃（见 ENVIRONMENT.L01.tempC），空调降级运行", "湿度 74% 超注塑宜 ≤60%（见 ENVIRONMENT.L01.humidityPct），塑料颗粒吸潮致气泡缺陷"],
        measurement: ["CMM 三坐标超校准周期 8 个月（标准 6，见 GAGE_RNR.L01.monthsSinceLastCal）", "测量系统 R&R=18.5% > 10% 不可接受（见 GAGE_RNR.L01.rrPct），可能误判合格/不合格"],
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
        environment: ["车间温度 26℃ 略超标准（见 ENVIRONMENT.L02.tempC），影响轻微"],
        measurement: ["AOI 检测仪即将到校准周期（见 GAGE_RNR.L02 gages[0].status=due）"],
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
        environment: ["车间温度 34℃ 严重超标（见 ENVIRONMENT.L01.tempC），空调故障加剧设备热负荷", "湿度 82% 致塑料严重吸潮（见 ENVIRONMENT.L01.humidityPct），是表面气泡缺陷主因之一", "洁净度 ISO 8 不达标（见 ENVIRONMENT.L01.cleanlinessIso）"],
        measurement: ["CMM 三坐标超校准 10 个月（见 GAGE_RNR.L01.monthsSinceLastCal），测量数据可信度存疑", "R&R=32% 远超 30% 红线（见 GAGE_RNR.L01.rrPct），报废判定本身可能失准"],
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
        environment: ["车间温度 28℃ 偏高（见 ENVIRONMENT.L02.tempC），空调降级"],
        measurement: ["AOI 检测仪超校准周期（见 GAGE_RNR.L02 gages[0].status=overdue）"],
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
  // 聚合 4 个系统数据源（MES 运行态 + PLM 可靠性 + IoT 健康 + ML 预测），
  // 供仍按旧接口消费的调用方使用。新工具应直接调下面 4 个细粒度 accessor。
  const line = resolveLine(ctx);
  const s = ctx.scenarioId;
  return {
    ...EQUIPMENT_RUNTIME[s][line],
    ...EQUIPMENT_RELIABILITY[s][line],
    ...EQUIPMENT_HEALTH[s][line],
    ...EQUIPMENT_FAILURE_RISK[s][line],
  };
}
export function getEquipmentRuntime(ctx: ScenarioContext) {
  return EQUIPMENT_RUNTIME[ctx.scenarioId][resolveLine(ctx)];
}
export function getEquipmentReliability(ctx: ScenarioContext) {
  return EQUIPMENT_RELIABILITY[ctx.scenarioId][resolveLine(ctx)];
}
export function getEquipmentHealth(ctx: ScenarioContext) {
  return EQUIPMENT_HEALTH[ctx.scenarioId][resolveLine(ctx)];
}
export function getEquipmentFailureRisk(ctx: ScenarioContext) {
  return EQUIPMENT_FAILURE_RISK[ctx.scenarioId][resolveLine(ctx)];
}
export function getQuality(ctx: ScenarioContext) {
  return QUALITY[ctx.scenarioId][resolveLine(ctx)];
}
export function getProcess(ctx: ScenarioContext) {
  return PROCESS[ctx.scenarioId][resolveLine(ctx)];
}
/** 工艺参数（来源：MES+PLM）—— actual/standard/unit/inSpec + FMEA S/O/D。 */
export function getProcessParameters(ctx: ScenarioContext) {
  const p = PROCESS[ctx.scenarioId][resolveLine(ctx)];
  return { parameters: p.parameters };
}
/** FMEA 评分（来源：FMEA 系统）—— 每参数的 severity/occurrence/detection。 */
export function getFmeaScores(ctx: ScenarioContext) {
  const p = PROCESS[ctx.scenarioId][resolveLine(ctx)];
  const scores: Record<string, { severity: number; occurrence: number; detection: number }> = {};
  for (const [k, v] of Object.entries(p.parameters)) {
    scores[k] = { severity: v.severity, occurrence: v.occurrence, detection: v.detection };
  }
  return { scores };
}
/** 工艺聚合指标（来源：MOM）—— deviationScore / capability。 */
export function getProcessAggregate(ctx: ScenarioContext) {
  const p = PROCESS[ctx.scenarioId][resolveLine(ctx)];
  return { deviationScore: p.deviationScore, capability: p.capability };
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

// ── 时间序列 accessor（从单点快照派生 7d/24h 趋势，补充时间维度深度）──
// 设计：按场景方向（normal 稳定 / anomaly 缓慢恶化 / crisis 急剧恶化）反推基线，
// 让 quality/energy/health/process/material 都具备趋势分析能力。

/** 各场景的趋势"恶化倍数"：normal≈持平，anomaly 缓变，crisis 急变。 */
const SCENE_TREND_FACTOR: Record<ScenarioId, number> = { normal: 1.0, anomaly: 0.55, crisis: 0.30 };

/** 质量 7 天趋势：缺陷率/报废率/Cpk 演化（anomaly/crisis 时恶化）。 */
export function getQualityTrend(ctx: ScenarioContext) {
  const q = getQuality(ctx);
  const f = SCENE_TREND_FACTOR[ctx.scenarioId];
  return {
    defectRateTrend7d: genTrend(q.defectRate, q.defectRate * f, 7, 0.05),
    scrapRateTrend7d: genTrend(q.scrapRate, q.scrapRate * f, 7, 0.06),
    cpkTrend7d: genTrend(q.cpk, Math.min(1.6, q.cpk / f), 7, 0.03),
    defectByHour24: genHourly24(q.defectRate * 1.6, q.defectRate * 0.4),
  };
}

/** 能耗 7 天趋势 + 24h 功率曲线（峰谷比可诊断能耗模式异常）。 */
export function getEnergyTrend(ctx: ScenarioContext) {
  const e = getEnergy(ctx);
  const f = SCENE_TREND_FACTOR[ctx.scenarioId];
  return {
    realtimeKwTrend7d: genTrend(e.realtimeKw, e.baselineKw * (2 - f), 7, 0.04),
    costTodayTrend7d: genTrend(e.costToday, e.costToday * f, 7, 0.03),
    hourlyKw24: genHourly24(e.peakKw * 0.95, e.baselineKw * 0.5),
    peakValleyRatio: Number((e.peakKw / (e.baselineKw * 0.5)).toFixed(2)),
  };
}

/** 设备健康 14 天趋势（让 failure_predict 的 ML 预测有历史退化依据）。 */
export function getEquipmentHealthTrend(ctx: ScenarioContext) {
  const h = EQUIPMENT_HEALTH[ctx.scenarioId][resolveLine(ctx)];
  const baseline = ctx.scenarioId === "normal" ? 0.96 : 0.92;
  return {
    healthScoreTrend14d: genTrend(h.healthScore, baseline, 14, 0.02),
    healthDeclining: h.healthScore < baseline,
  };
}

/** 工艺参数 7 天趋势（每参数漂移曲线，用于偏离率/能力趋势分析）。 */
export function getProcessTrend(ctx: ScenarioContext) {
  const p = getProcess(ctx);
  const f = SCENE_TREND_FACTOR[ctx.scenarioId];
  const parameters: Record<string, { actualTrend7d: number[]; deviationPctTrend7d: number[] }> = {};
  for (const [k, v] of Object.entries(p.parameters)) {
    const actualBase = v.standard * (1 + (v.actual - v.standard) / v.standard * f);
    const actualTrend7d = genTrend(v.actual, actualBase, 7, 0.01);
    const deviationPctTrend7d = actualTrend7d.map((a) => Number(((a - v.standard) / v.standard).toFixed(4)));
    parameters[k] = { actualTrend7d, deviationPctTrend7d };
  }
  return { parameters, deviationScoreTrend7d: genTrend(p.deviationScore, p.deviationScore * f, 7, 0.05) };
}

/** 物料 7 天趋势（WIP 水位 / 库存小时数变化，用于物料流堵塞诊断）。 */
export function getMaterialTrend(ctx: ScenarioContext) {
  const m = getMaterial(ctx);
  const f = SCENE_TREND_FACTOR[ctx.scenarioId];
  return {
    wipLevelTrend7d: genTrend(m.wipLevel, m.wipLevel * (2 - f), 7, 0.05),
    inventoryHoursTrend7d: genTrend(m.inventoryHours, 36, 7, 0.06),
    shortageRiskTrend7d: genTrend(m.shortageRisk, m.shortageRisk * f, 7, 0.08),
  };
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

/** 工序路线（按产线，静态主数据）。 */
export function getRouting(ctx: ScenarioContext) {
  return ROUTING[resolveLine(ctx)];
}

/** 考勤数据（按场景 + 产线 + 班次）。 */
export function getAttendance(ctx: ScenarioContext) {
  return ATTENDANCE[ctx.scenarioId][resolveLine(ctx)];
}

/** 疲劳评分（按场景 + 产线 + 班次）。 */
export function getFatigue(ctx: ScenarioContext) {
  return FATIGUE[ctx.scenarioId][resolveLine(ctx)];
}

/** SPC 样本（按场景 + 产线）。 */
export function getSpcSamples(ctx: ScenarioContext) {
  return SPC_SAMPLES[ctx.scenarioId][resolveLine(ctx)];
}

/** 车间环境数据（来源：EMS/IoT）—— 温湿度/洁净度/HVAC 状态。 */
export function getEnvironment(ctx: ScenarioContext) {
  return ENVIRONMENT[ctx.scenarioId][resolveLine(ctx)];
}

/** 测量系统分析数据（来源：QMS）—— Gage R&R、校准状态。 */
export function getGageRnr(ctx: ScenarioContext) {
  return GAGE_RNR[ctx.scenarioId][resolveLine(ctx)];
}

/** 供应商链数据（来源：ERP+SQM）—— 关键料号供应商交期/OTD/来料质量。 */
export function getSupplier(ctx: ScenarioContext) {
  return SUPPLIER[ctx.scenarioId][resolveLine(ctx)];
}

/**
 * 设备台账数据（来源：EAM）—— 单台设备资产号 + 关键度 + 健康分。
 * 把产线级聚合定位到设备级，healthScore 按当前场景返回单台值。
 */
export function getEquipmentInventory(ctx: ScenarioContext) {
  const inv = EQUIPMENT_INVENTORY[resolveLine(ctx)];
  return {
    machines: inv.machines.map((m) => ({
      assetNo: m.assetNo,
      name: m.name,
      criticality: m.criticality,
      ageYears: m.ageYears,
      healthScore: m.healthByScenario[ctx.scenarioId],
      lastMaintenance: m.lastMaintenance,
      nextDueMaintenance: m.nextDueMaintenance,
      isBottleneck: m.isBottleneck,
    })),
  };
}

/** 单位经济性数据（来源：ERP 财务）—— 各产线单位产值/成本/能耗单价。 */
export function getUnitEconomics(ctx: ScenarioContext) {
  return UNIT_ECONOMICS[resolveLine(ctx)];
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
