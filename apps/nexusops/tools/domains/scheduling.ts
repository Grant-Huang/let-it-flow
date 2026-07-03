/**
 * 排产计划域工具集（应用层 —— T 内容）。
 *
 * 排产达成率、换模时间、瓶颈资源、产能、CT vs Takt。
 * 数据源：MES（执行）+ ERP（订单）。
 */
import { createQueryTool } from "../mock-data/tool-factory.js";
import { getSchedule, lookupActionOverride, type ScenarioId } from "../mock-data/scenarios.js";
import { DEFAULT_LINE } from "../../config/defaults.js";

export function registerScheduleTools(): import("../../../../src/tools/base.js").FlowConnector[] {
  return [
    // 1. 当前排产
    createQueryTool({
      name: "schedule.current",
      description: "查指定产线当前排产计划（订单/数量/进度）。",
      triggers: ["排产计划", "当前计划", "在产什么", "订单进度"],
      notFor: ["达成率（走 schedule.attainment）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const s = getSchedule(ctx);
        const plannedOverride = lookupActionOverride(ctx, "schedule.plannedQty");
        return {
          orderId: "PO-2026-0619-01",
          product: "产品 A",
          plannedQty: (plannedOverride as number | undefined) ?? 1200,
          completedQty: Math.round(((plannedOverride as number | undefined) ?? 1200) * s.attainment),
          progressPct: s.attainment * 100,
        };
      },
      system: "ERP",
      provenance: (a) => `/erp/schedule/current?line=${(a.line as string) ?? DEFAULT_LINE}`,
      semanticTags: ["schedule_attainment"],
    }),

    // 2. 达成率
    createQueryTool({
      name: "schedule.attainment",
      description: "查今日排产达成率。达成率低需追溯原因（设备/质量/物料）。",
      triggers: ["达成率", "完成率", "排产达成", "计划完成"],
      notFor: ["订单详情（走 schedule.current）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const s = getSchedule(ctx);
        const attainOverride = lookupActionOverride(ctx, "schedule.attainment") as number | undefined;
        const attainment = attainOverride ?? s.attainment;
        return {
          attainment,
          target: 0.95,
          gap: attainment - 0.95,
          status: attainment >= 0.95 ? "on_track" : attainment >= 0.8 ? "at_risk" : "behind",
          ...(attainOverride !== undefined ? { note: "已反映近期排产调整动作的副作用" } : {}),
        };
      },
      system: "MES",
      provenance: (a) => `/mes/schedule/attainment?line=${(a.line as string) ?? DEFAULT_LINE}&today=true`,
      semanticTags: ["schedule_attainment"],
    }),

    // 3. 换模时间
    createQueryTool({
      name: "schedule.changeover",
      description: "查今日换模总时长 + 次数。换模超时是常见的可用率损失来源（SMED 改善点）。",
      triggers: ["换模时间", "SMED", "切换时间", "换模次数", "换型"],
      notFor: ["整体停机（走 equipment.downtime）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const s = getSchedule(ctx);
        return {
          changeoverMinutesToday: s.changeoverMinutesToday,
          baselineMinutes: 60,
          smedTargetMinutes: 30,
          count: s.changeoverMinutesToday > 100 ? 3 : 1,
          smedOpportunity: Math.max(0, s.changeoverMinutesToday - 30 * (s.changeoverMinutesToday > 100 ? 3 : 1)),
        };
      },
      system: "MES",
      provenance: (a) => `/mes/schedule/changeover?line=${(a.line as string) ?? DEFAULT_LINE}&today=true`,
      semanticTags: ["schedule_attainment", "oee_availability"],
    }),

    // 4. 瓶颈资源
    createQueryTool({
      name: "schedule.bottleneck_resource",
      description: "查约束理论视角的瓶颈资源。TOC 改善聚焦瓶颈。",
      triggers: ["瓶颈资源", "TOC", "约束", "卡脖子的工序"],
      notFor: ["瓶颈产线（走 oee.bottleneck）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const s = getSchedule(ctx);
        return {
          bottleneckResource: s.bottleneckResource,
          isDown: s.bottleneckResource.includes("停机"),
          recommendation: s.bottleneckResource === "无"
            ? "无明显瓶颈"
            : `建议聚焦 ${s.bottleneckResource} 的产能释放`,
        };
      },
      system: "MES",
      provenance: (a) => `/mes/schedule/bottleneck?line=${(a.line as string) ?? DEFAULT_LINE}`,
      semanticTags: ["schedule_attainment"],
    }),

    // 5. 产能利用率
    createQueryTool({
      name: "schedule.capacity",
      description: "查产能利用率。超 100% 说明过载（隐性风险），低于 70% 说明闲置。",
      triggers: ["产能利用率", "负荷", "产能", "利用率"],
      notFor: ["达成率（走 schedule.attainment）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const s = getSchedule(ctx);
        return {
          capacityUtilization: s.capacityUtilization,
          status: s.capacityUtilization > 1.0 ? "overloaded" : s.capacityUtilization >= 0.85 ? "high" : "normal",
        };
      },
      system: "ERP",
      provenance: (a) => `/erp/schedule/capacity?line=${(a.line as string) ?? DEFAULT_LINE}&week=current`,
      freshness: "weekly",
      semanticTags: ["schedule_attainment"],
    }),

    // 6. CT vs Takt
    createQueryTool({
      name: "schedule.ct_vs_takt",
      description: "查周期时间（CT）vs 节拍时间（Takt）。CT > Takt 说明跟不上客户需求，是产线平衡核心指标。",
      triggers: ["CT Takt", "周期时间", "节拍", "产线平衡", "跟不上需求"],
      notFor: ["瓶颈资源（走 schedule.bottleneck_resource）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const s = getSchedule(ctx);
        return {
          ctSeconds: s.ctSeconds,
          taktSeconds: s.taktSeconds,
          delta: s.ctSeconds - s.taktSeconds,
          deltaPct: ((s.ctSeconds - s.taktSeconds) / s.taktSeconds) * 100,
          meetsDemand: s.ctSeconds <= s.taktSeconds,
        };
      },
      system: "MES",
      provenance: (a) => `/mes/schedule/ct_vs_takt?line=${(a.line as string) ?? DEFAULT_LINE}`,
      semanticTags: ["schedule_attainment"],
    }),

    // 7. 工单队列
    createQueryTool({
      name: "schedule.queue",
      description: "查待加工单队列（优先级 + 交期）。判断是否需要调整排产顺序。",
      triggers: ["工单队列", "待加工单", "排队", "交期"],
      notFor: ["当前工单（走 schedule.current）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const s = getSchedule(ctx);
        return {
          queue: [
            { orderId: "PO-0619-01", priority: "high", dueIn: "2d", qty: 1200, status: "in_progress" },
            { orderId: "PO-0620-02", priority: "medium", dueIn: "4d", qty: 800, status: "queued" },
            { orderId: "PO-0621-03", priority: "low", dueIn: "7d", qty: 600, status: "queued" },
          ],
          atRiskOrders: s.attainment < 0.8 ? ["PO-0619-01"] : [],
        };
      },
      system: "ERP",
      provenance: (a) => `/erp/schedule/queue?line=${(a.line as string) ?? DEFAULT_LINE}`,
      semanticTags: ["schedule_attainment"],
    }),

    // 8. 排产建议
    createQueryTool({
      name: "schedule.suggest",
      description: "基于当前达成率/瓶颈给出排产调整建议。实际调整需调度员确认。",
      triggers: ["排产建议", "调整排产", "调度建议", "改顺序"],
      notFor: ["直接改单（需 MCP 写入 + HITL）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const s = getSchedule(ctx);
        return {
          suggestions: s.attainment < 0.8
            ? [
                { action: "优先完成 PO-0619-01", impact: "保交期", confidence: 0.85 },
                { action: "推迟低优先级订单", impact: "释放产能", confidence: 0.7 },
              ]
            : [{ action: "维持当前排产", impact: "稳定", confidence: 0.9 }],
          requiresConfirmation: true,
        };
      },
      system: "ERP",
      provenance: (a) => `/erp/schedule/suggest?line=${(a.line as string) ?? DEFAULT_LINE}`,
      confidence: "inferred",
      semanticTags: ["schedule_attainment"],
    }),
  ];
}

export type { ScenarioId };
