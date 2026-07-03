/**
 * 能耗优化域工具集（应用层 —— T 内容）。
 *
 * 实时能耗、单位产品能耗、峰谷、成本、碳排放、异常。
 * 数据源：智能采集系统 + ERP（成本）。
 */
import { createQueryTool } from "../mock-data/tool-factory.js";
import { getEnergy, type ScenarioId } from "../mock-data/scenarios.js";
import { ENERGY_EFFICIENCY_GOOD, ENERGY_EFFICIENCY_WARNING, ENERGY_BASELINE_KWH_PER_UNIT } from "../../config/business-thresholds.js";
import { DEFAULT_LINE } from "../../config/defaults.js";

export function registerEnergyTools(): import("../../../../src/tools/base.js").FlowConnector[] {
  return [
    // 1. 实时能耗
    createQueryTool({
      name: "energy.realtime",
      description: "查指定产线实时功率（kW）。能耗异常飙升常伴设备/工艺问题。",
      triggers: ["实时能耗", "功率", "用电", "kW", "耗电"],
      notFor: ["历史趋势（走 energy.by_process）", "成本（走 energy.cost）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const e = getEnergy(ctx);
        return {
          realtimeKw: e.realtimeKw,
          baselineKw: e.baselineKw,
          deltaPct: ((e.realtimeKw - e.baselineKw) / e.baselineKw) * 100,
          anomaly: e.realtimeKw > e.baselineKw * 1.15,
        };
      },
      system: "智能电表",
      provenance: (a) => `/iot/energy/realtime?line=${(a.line as string) ?? DEFAULT_LINE}`,
      semanticTags: ["energy_consumption"],
    }),

    // 2. 按产线对比
    createQueryTool({
      name: "energy.by_line",
      description: "查各产线能耗对比。识别能耗大户。",
      triggers: ["产线能耗对比", "各线用电", "能耗排名"],
      notFor: ["单产线（走 energy.realtime）"],
      inputSchema: { type: "object", properties: {} },
      getData: () => ({
        lines: [
          { line: "L01", kw: 128, baseline: 88 },
          { line: "L02", kw: 82, baseline: 80 },
          { line: "L03", kw: 83, baseline: 84 },
        ],
      }),
      system: "智能电表",
      provenance: () => `/iot/energy/by_line`,
      semanticTags: ["energy_consumption"],
    }),

    // 3. 按工艺分解
    createQueryTool({
      name: "energy.by_process",
      description: "把能耗分解到各工艺阶段（加热/成型/冷却等）。识别耗能工序。",
      triggers: ["能耗分解", "工艺能耗", "哪个工序耗能", "能耗构成"],
      notFor: ["产线对比（走 energy.by_line）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const e = getEnergy(ctx);
        return {
          breakdown: {
            加热: e.realtimeKw * 0.45,
            成型: e.realtimeKw * 0.35,
            冷却: e.realtimeKw * 0.12,
            辅助: e.realtimeKw * 0.08,
          },
          topConsumer: "加热",
        };
      },
      system: "智能电表",
      provenance: (a) => `/iot/energy/by_process?line=${(a.line as string) ?? DEFAULT_LINE}`,
      semanticTags: ["energy_consumption"],
    }),

    // 4. 峰值
    createQueryTool({
      name: "energy.peak",
      description: "查今日峰值功率 + 峰值时段。峰值高影响需量电费。",
      triggers: ["峰值功率", "用电峰值", "需量", "峰值时段"],
      notFor: ["实时（走 energy.realtime）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const e = getEnergy(ctx);
        return {
          peakKw: e.peakKw,
          peakAt: "2026-06-19T10:30:00Z",
          demandLimit: 250,
          demandUtilization: e.peakKw / 250,
        };
      },
      system: "智能电表",
      provenance: (a) => `/iot/energy/peak?line=${(a.line as string) ?? DEFAULT_LINE}&today=true`,
      semanticTags: ["energy_consumption"],
    }),

    // 5. 能耗成本
    createQueryTool({
      name: "energy.cost",
      description: "查今日能耗成本（峰谷电价 + 需量电费）。能耗异常直接拉高单位成本。",
      triggers: ["能耗成本", "电费", "用电成本", "电价"],
      notFor: ["能耗量（走 energy.realtime）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const e = getEnergy(ctx);
        return {
          costTodayCny: e.costToday,
          baselineCostCny: 1820,
          overspendCny: e.costToday - 1820,
          peakValleySavingsOpportunity: Math.round((e.costToday - 1820) * 0.3),
        };
      },
      system: "ERP",
      provenance: (a) => `/erp/energy/cost?line=${(a.line as string) ?? DEFAULT_LINE}&today=true`,
      freshness: "daily",
      semanticTags: ["energy_consumption", "cost_summary"],
    }),

    // 6. 能效（单位产品能耗）
    createQueryTool({
      name: "energy.efficiency",
      description: "查能效（kWh/单位产品）。能效下降常关联工艺漂移或设备低效。",
      triggers: ["能效", "单位能耗", "单耗", "kWh 每件", "能耗效率"],
      notFor: ["总能耗（走 energy.realtime）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const e = getEnergy(ctx);
        return {
          kwhPerUnit: e.carbonKgPerUnit / 0.5,
          baselineKwhPerUnit: ENERGY_BASELINE_KWH_PER_UNIT,
          efficiencyRatio: e.efficiency,
          status: e.efficiency >= ENERGY_EFFICIENCY_GOOD ? "good" : e.efficiency >= ENERGY_EFFICIENCY_WARNING ? "warning" : "poor",
        };
      },
      system: "MES",
      provenance: (a) => `/mes/energy/efficiency?line=${(a.line as string) ?? DEFAULT_LINE}&today=true`,
      semanticTags: ["energy_consumption"],
    }),

    // 7. 碳排放
    createQueryTool({
      name: "energy.carbon",
      description: "查单位产品碳排放（kgCO2/件）。ESG 合规 + 双碳目标追踪。",
      triggers: ["碳排放", "碳足迹", "CO2", "碳排", "ESG"],
      notFor: ["能耗量（走 energy.realtime）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const e = getEnergy(ctx);
        return {
          carbonKgPerUnit: e.carbonKgPerUnit,
          target: 2.5,
          status: e.carbonKgPerUnit <= 2.5 ? "on_track" : "exceeded",
        };
      },
      system: "MES",
      provenance: (a) => `/mes/energy/carbon?line=${(a.line as string) ?? DEFAULT_LINE}&today=true`,
      semanticTags: ["energy_consumption", "carbon_emission"],
    }),

    // 8. 能耗异常检测
    createQueryTool({
      name: "energy.anomaly",
      description: "查能耗异常事件（突增/突降/持续偏高）。常是设备故障的早期信号。",
      triggers: ["能耗异常", "用电突增", "能耗飙升", "异常用电"],
      notFor: ["正常能耗（走 energy.realtime）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const e = getEnergy(ctx);
        const isAnomaly = e.realtimeKw > e.baselineKw * 1.15;
        return {
          anomalyDetected: isAnomaly,
          anomalies: isAnomaly
            ? [{ type: "持续偏高", since: "2026-06-19T06:00:00Z", severity: "high" }]
            : [],
        };
      },
      system: "智能电表",
      provenance: (a) => `/iot/energy/anomaly?line=${(a.line as string) ?? DEFAULT_LINE}&window=24h`,
      semanticTags: ["energy_consumption"],
    }),
  ];
}

export type { ScenarioId };
