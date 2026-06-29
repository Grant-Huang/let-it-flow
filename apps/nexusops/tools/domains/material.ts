/**
 * 物料物流域工具集（应用层 —— T 内容）。
 *
 * WIP 水位、库存、缺料风险、物料流、看板。
 * 数据源：ERP（库存）+ MES（在制品）。
 */
import { createQueryTool } from "../mock-data/tool-factory.js";
import {
  getMaterial,
  lookupActionOverride,
  type ScenarioContext,
  type ScenarioId,
} from "../mock-data/scenarios.js";

/**
 * 应用动作副作用覆盖到物料数据。
 *
 * 闭环逻辑：执行 mcp.erp.material_issue / purchase_request 后，
 * actionStore 写入 sideEffects；读取侧消费之，使"执行→复检"反映变化。
 *
 * - issued：已领料出库到线边 → 库存小时数回升，缺料风险下降
 * - purchasePending：采购申请已提交（尚未到货）→ 缺料风险下降（在途），库存暂不变
 */
function applyMaterialOverrides(ctx: ScenarioContext, base: ReturnType<typeof getMaterial>) {
  const issued = lookupActionOverride(ctx, "material.issued") === true;
  const purchasePending = lookupActionOverride(ctx, "material.purchasePending") === true;

  if (!issued && !purchasePending) return base;

  // 领料出库：线边库存显著回升（按 +20h 模拟一次补料）
  const inventoryBoost = issued ? 20 : 0;
  // 采购在途：缺料风险下降（预计 24h 内到货）
  const riskReduction = purchasePending ? base.shortageRisk * 0.4 : 0;

  const newInventoryHours = base.inventoryHours + inventoryBoost;
  const newShortageRisk = Math.max(0, base.shortageRisk - riskReduction);

  return {
    ...base,
    inventoryHours: newInventoryHours,
    shortageRisk: Number(newShortageRisk.toFixed(4)),
    ...(issued ? { actionApplied: "material_issued" } : {}),
    ...(purchasePending ? { actionApplied: "purchase_pending" } : {}),
  };
}

export function registerMaterialTools(): import("../../../../src/tools/base.js").FlowConnector[] {
  return [
    // 1. WIP 水位
    createQueryTool({
      name: "material.wip_level",
      description: "查在制品（WIP）水位。WIP 过高是精益典型浪费（库存掩盖问题）。",
      triggers: ["WIP", "在制品", "在制品水位", "半成品库存"],
      notFor: ["原材料库存（走 material.inventory）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const m = getMaterial(ctx);
        return {
          wipLevel: m.wipLevel,
          wipMax: m.wipMax,
          utilization: m.wipLevel / m.wipMax,
          status: m.wipLevel > m.wipMax ? "over_capacity" : "normal",
        };
      },
      system: "MES",
      provenance: (a) => `/mes/material/wip?line=${(a.line as string) ?? "L01"}&realtime=true`,
    }),

    // 2. 原材料库存
    createQueryTool({
      name: "material.inventory",
      description: "查原材料库存水位（按小时消耗计）。库存不足会停线。",
      triggers: ["库存", "原材料", "料仓", "库存水位", "还能撑多久"],
      notFor: ["WIP（走 material.wip_level）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const m = applyMaterialOverrides(ctx, getMaterial(ctx));
        return {
          inventoryHours: m.inventoryHours,
          threshold: 24,
          status: m.inventoryHours < 8 ? "critical" : m.inventoryHours < 24 ? "low" : "ok",
        };
      },
      system: "ERP",
      provenance: (a) => `/erp/material/inventory?line=${(a.line as string) ?? "L01"}`,
    }),

    // 3. 缺料风险
    createQueryTool({
      name: "material.shortage",
      description: "查近期缺料风险概率。提前预警避免停线。",
      triggers: ["缺料", "断料", "物料风险", "会不会断料"],
      notFor: ["当前库存（走 material.inventory）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const m = applyMaterialOverrides(ctx, getMaterial(ctx));
        return {
          shortageRisk: m.shortageRisk,
          riskItems: m.shortageRisk > 0.2
            ? [{ item: "原料 X-12", supplier: "供应商 A", eta: "2026-06-20", risk: "高" }]
            : [],
        };
      },
      system: "ERP",
      provenance: (a) => `/erp/material/shortage_risk?line=${(a.line as string) ?? "L01"}&window=48h`,
      freshness: "daily",
    }),

    // 4. 物料流分析
    createQueryTool({
      name: "material.flow",
      description: "查物料在产线的流动时间（流时长）。精益价值流分析（VSM）的核心数据。",
      triggers: ["物料流", "流程时间", "VSM", "价值流", "物流时间"],
      notFor: ["库存量（走 material.inventory）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const m = getMaterial(ctx);
        return {
          flowTimeMinutes: m.wipLevel > m.wipMax ? 180 : 95,
          processingTimeMinutes: 35,
          waitTimeMinutes: m.wipLevel > m.wipMax ? 145 : 60,
          flowEfficiency: 35 / (m.wipLevel > m.wipMax ? 180 : 95),
        };
      },
      system: "MES",
      provenance: (a) => `/mes/material/flow?line=${(a.line as string) ?? "L01"}`,
      freshness: "daily",
    }),

    // 5. 看板状态
    createQueryTool({
      name: "material.kanban",
      description: "查看板状态（拉动系统运行情况）。看板卡积压说明拉动失效。",
      triggers: ["看板", "kanban", "拉动", "看板卡"],
      notFor: ["WIP 水位（走 material.wip_level）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const m = getMaterial(ctx);
        return {
          kanbanCirculating: 48,
          kanbanStuck: m.wipLevel > m.wipMax ? 12 : 2,
          pullSystemHealthy: m.wipLevel <= m.wipMax,
        };
      },
      system: "MES",
      provenance: (a) => `/mes/material/kanban?line=${(a.line as string) ?? "L01"}`,
    }),

    // 6. 供应风险
    createQueryTool({
      name: "material.supply_risk",
      description: "查供应商交付风险（结合历史准时率 + 当前订单）。供应链韧性视角。",
      triggers: ["供应商风险", "供应风险", "交付风险", "供应链"],
      notFor: ["内部库存（走 material.inventory）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const m = getMaterial(ctx);
        return {
          topRiskSuppliers: m.shortageRisk > 0.2
            ? [{ name: "供应商 A", onTimeRate: 0.78, openOrders: 3, risk: "high" }]
            : [],
          averageOnTimeRate: 0.94,
        };
      },
      system: "ERP",
      provenance: (a) => `/erp/material/supply_risk?line=${(a.line as string) ?? "L01"}`,
      freshness: "weekly",
    }),

    // 7. 物料消耗速率
    createQueryTool({
      name: "material.consumption_rate",
      description: "查物料实时消耗速率（件/小时）。用于补货决策 + 缺料预警。",
      triggers: ["消耗速率", "用料速度", "消耗率", "每小时用多少料"],
      notFor: ["库存量（走 material.inventory）"],
      inputSchema: { type: "object", properties: {} },
      getData: () => ({
        unitsPerHour: 60,
        peakRate: 72,
        troughRate: 45,
        stabilityScore: 0.88,
      }),
      system: "MES",
      provenance: (a) => `/mes/material/consumption?line=${(a.line as string) ?? "L01"}&realtime=true`,
    }),

    // 8. 物料建议
    createQueryTool({
      name: "material.suggest",
      description: "基于 WIP/库存/消耗速率给出补货/拉动调整建议。",
      triggers: ["补货建议", "物料建议", "看板调整建议"],
      notFor: ["直接下采购单（需 ERP MCP + HITL）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const m = applyMaterialOverrides(ctx, getMaterial(ctx));
        return {
          suggestions:
            m.inventoryHours < 8
              ? [{ action: "紧急补料（原料 X-12）", impact: "防停线", confidence: 0.92 }]
              : m.wipLevel > m.wipMax
                ? [{ action: "降低投放节拍（限产 WIP）", impact: "去库存化", confidence: 0.8 }]
                : [{ action: "维持拉动", impact: "稳定", confidence: 0.9 }],
          requiresConfirmation: true,
        };
      },
      system: "ERP",
      provenance: (a) => `/erp/material/suggest?line=${(a.line as string) ?? "L01"}`,
      confidence: "inferred",
    }),
  ];
}

export type { ScenarioId };
