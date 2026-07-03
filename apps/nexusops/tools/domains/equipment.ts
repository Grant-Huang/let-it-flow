/**
 * 设备管理域工具集（应用层 —— T 内容）。
 *
 * 设备健康状态、停机原因、可靠性指标（MTBF/MTTR）、预测性维护。
 * 数据源：MES（运行状态）+ PLM（维护历史）。
 */
import { createQueryTool } from "../mock-data/tool-factory.js";
import {
  getEquipmentRuntime,
  getEquipmentReliability,
  getEquipmentHealth,
  getEquipmentFailureRisk,
  lookupActionOverride,
  type ScenarioId,
} from "../mock-data/scenarios.js";
import { DEFAULT_LINE } from "../../config/defaults.js";

const SYSTEM = "MES";

export function registerEquipmentTools(): import("../../../../src/tools/base.js").FlowConnector[] {
  return [
    // 1. 设备实时状态
    createQueryTool({
      name: "equipment.status",
      description: "查指定产线主设备的实时运行状态（running/idle/down）。停机时第一时间取证。",
      triggers: ["设备状态", "机器开没开", "在运行吗", "设备停了吗"],
      notFor: ["停机原因详情（走 equipment.downtime）", "历史可靠性（走 equipment.mtbf）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const rt = getEquipmentRuntime(ctx);
        const h = getEquipmentHealth(ctx);
        const lineStopped = lookupActionOverride(ctx, "equipment.lineStopped") === true;
        return {
          status: lineStopped ? "down" : rt.status,
          healthScore: h.healthScore,
          line: ctx.line ?? DEFAULT_LINE,
          ...(lineStopped ? { note: "产线已被停线动作（mcp.eam.stop_line）置为 down" } : {}),
        };
      },
      system: SYSTEM,
      provenance: (a) => `/mes/equipment/status?line=${(a.line as string) ?? DEFAULT_LINE}`,
      semanticTags: ["equipment_health", "oee_availability"],
    }),

    // 2. 停机事件 + 原因
    createQueryTool({
      name: "equipment.downtime",
      description: "查指定产线的停机事件清单（含原因/时长/时间戳）。诊断 OEE 可用率损失的核心证据。",
      triggers: ["停机原因", "停机事件", "为什么停机", "故障记录", "可用率为什么低"],
      notFor: ["实时状态（走 equipment.status）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const rt = getEquipmentRuntime(ctx);
        const events = rt.downtimeEvents;
        const totalDowntimeMinutes = events.reduce((s, x) => s + x.minutes, 0);
        return {
          totalDowntimeMinutes,
          eventCount: events.length,
          events,
          topReason: events[0]?.reason ?? "无停机",
        };
      },
      system: SYSTEM,
      provenance: (a) => `/mes/equipment/downtime?line=${(a.line as string) ?? DEFAULT_LINE}&today=true`,
      semanticTags: ["oee_availability", "downtime_events"],
    }),

    // 3. MTBF（平均故障间隔）
    createQueryTool({
      name: "equipment.mtbf",
      description: "查设备的平均故障间隔时间（MTBF）。MTBF 下降说明可靠性恶化，需预测性维护。",
      triggers: ["MTBF", "平均故障间隔", "可靠性", "故障频率"],
      notFor: ["单次故障详情（走 equipment.downtime）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const rel = getEquipmentReliability(ctx);
        return { mtbfHours: rel.mtbfHours, baselineHours: 450, ratio: rel.mtbfHours / 450 };
      },
      system: "PLM",
      provenance: (a) => `/plm/equipment/mtbf?line=${(a.line as string) ?? DEFAULT_LINE}&window=30d`,
      freshness: "weekly",
      semanticTags: ["equipment_reliability"],
    }),

    // 4. MTTR（平均修复时间）
    createQueryTool({
      name: "equipment.mttr",
      description: "查设备的平均修复时间（MTTR）。MTTR 高说明维修响应/备件/技能有问题。",
      triggers: ["MTTR", "平均修复时间", "维修时间", "修复慢"],
      notFor: ["故障频率（走 equipment.mtbf）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const rel = getEquipmentReliability(ctx);
        return { mttrMinutes: rel.mttrMinutes, baselineMinutes: 45, ratio: rel.mttrMinutes / 45 };
      },
      system: "PLM",
      provenance: (a) => `/plm/equipment/mttr?line=${(a.line as string) ?? DEFAULT_LINE}&window=30d`,
      freshness: "weekly",
      semanticTags: ["equipment_reliability"],
    }),

    // 5. 维护日志
    createQueryTool({
      name: "equipment.maintenance_log",
      description: "查设备近期维护日志（保养/维修/点检记录）。判断是否漏保或维护不到位。",
      triggers: ["维护记录", "保养记录", "维修历史", "点检", "上次维护"],
      notFor: ["实时状态（走 equipment.status）"],
      inputSchema: { type: "object", properties: { days: { type: "number", description: "查询天数（缺省 30）" } } },
      getData: (ctx) => {
        const h = getEquipmentHealth(ctx);
        const lowHealth = h.healthScore < 0.7;
        return {
          logs: lowHealth
            ? [
                { date: "2026-06-15", type: "计划保养", note: "更换液压油" },
                { date: "2026-06-10", type: "故障维修", note: "传感器漂移，已校准（疑似复发）" },
              ]
            : [{ date: "2026-06-15", type: "计划保养", note: "常规保养" }],
          overdueInspection: lowHealth,
        };
      },
      system: "PLM",
      provenance: (a) => `/plm/equipment/maintenance?line=${(a.line as string) ?? DEFAULT_LINE}&days=${(a.days as number) ?? 30}`,
      freshness: "weekly",
      semanticTags: ["equipment_reliability"],
    }),

    // 6. 设备健康分
    createQueryTool({
      name: "equipment.health",
      description: "查设备综合健康分（0-1，融合振动/温度/电流/油液等 IoT 信号）。低于 0.7 需预警。",
      triggers: ["设备健康", "健康分", "设备状态综合", "预测性维护预警"],
      notFor: ["运行状态（走 equipment.status）", "停机原因（走 equipment.downtime）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const h = getEquipmentHealth(ctx);
        return {
          healthScore: h.healthScore,
          threshold: 0.7,
          status: h.healthScore >= 0.7 ? "healthy" : h.healthScore >= 0.4 ? "warning" : "critical",
          signals: { vibration: h.healthScore - 0.05, temperature: h.healthScore - 0.1, current: h.healthScore },
        };
      },
      system: "IoT",
      provenance: (a) => `/iot/equipment/health?line=${(a.line as string) ?? DEFAULT_LINE}`,
      caveat: "健康分基于 IoT 信号融合，采样率 1/min",
      semanticTags: ["equipment_health"],
    }),

    // 7. 故障预测（30 天风险）
    createQueryTool({
      name: "equipment.failure_predict",
      description: "查设备未来 30 天故障风险概率（基于历史 MTBF + IoT 趋势 ML 预测）。",
      triggers: ["故障预测", "风险概率", "会不会坏", "何时坏", "预测性维护"],
      notFor: ["当前健康（走 equipment.health）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const fr = getEquipmentFailureRisk(ctx);
        return {
          failureRisk30d: fr.failureRisk30d,
          recommendedAction:
            fr.failureRisk30d > 0.5 ? "建议立即安排预防性维护"
            : fr.failureRisk30d > 0.2 ? "建议下周内安排点检"
            : "按计划保养即可",
          confidence: 0.78,
        };
      },
      system: "ML",
      provenance: (a) => `/ml/equipment/predict?line=${(a.line as string) ?? DEFAULT_LINE}&horizon=30d`,
      freshness: "daily",
      confidence: "estimated",
      semanticTags: ["equipment_reliability"],
    }),

    // 8. 备件库存
    createQueryTool({
      name: "equipment.spare_parts",
      description: "查关键备件库存（影响 MTTR）。缺件会拖长修复时间。",
      triggers: ["备件", "库存", "备件够不够", "MTTR 为什么高"],
      notFor: ["维护记录（走 equipment.maintenance_log）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const h = getEquipmentHealth(ctx);
        const lowHealth = h.healthScore < 0.7;
        return {
          criticalParts: lowHealth
            ? [{ name: "主轴轴承", stock: 0, required: 2, status: "缺件" }, { name: "液压密封件", stock: 5, required: 3, status: "充足" }]
            : [{ name: "主轴轴承", stock: 4, required: 2, status: "充足" }],
        };
      },
      system: "ERP",
      provenance: (a) => `/erp/spare_parts?line=${(a.line as string) ?? DEFAULT_LINE}`,
      freshness: "daily",
      semanticTags: ["equipment_reliability"],
    }),

    // 9. 报警历史
    createQueryTool({
      name: "equipment.alarm_history",
      description: "查设备近期报警历史（报警频次/类型），辅助判断是偶发还是规律性故障。",
      triggers: ["报警记录", "报警历史", "故障码", "异常报警"],
      notFor: ["停机事件（走 equipment.downtime）"],
      inputSchema: { type: "object", properties: { hours: { type: "number", description: "查询小时数（缺省 24）" } } },
      getData: (ctx) => {
        const h = getEquipmentHealth(ctx);
        const lowHealth = h.healthScore < 0.7;
        return {
          alarms24h: lowHealth
            ? [{ code: "E-204", level: "warning", text: "主轴振动超标", count: 18 }, { code: "E-118", level: "info", text: "油温偏高", count: 8 }]
            : [],
          totalAlarms: lowHealth ? 26 : 2,
        };
      },
      system: SYSTEM,
      provenance: (a) => `/mes/equipment/alarms?line=${(a.line as string) ?? DEFAULT_LINE}&hours=${(a.hours as number) ?? 24}`,
      semanticTags: ["equipment_health"],
    }),
  ];
}

export type { ScenarioId };
