/**
 * 人员技能域工具集（应用层 —— T 内容）。
 *
 * 技能矩阵、上岗资质、班次人员配置。
 * 数据源：HR（人事）+ MES（考勤）。
 *
 * 用于班次差异诊断时交叉分析：某班次缺陷/OEE 异常 → 查该班次人员技能等级。
 */
import { createQueryTool } from "../mock-data/tool-factory.js";
import { getPersonnel, type ScenarioId } from "../mock-data/scenarios.js";

export function registerPersonnelTools(): import("../../../../src/tools/base.js").FlowConnector[] {
  return [
    // 1. 技能矩阵
    createQueryTool({
      name: "personnel.skill_matrix",
      description:
        "查指定产线的人员技能矩阵（各岗位各工位的技能等级 L1-L4）。用于班次差异诊断（某班次缺陷高 → 查该班次人员技能）。",
      triggers: ["技能矩阵", "人员技能", "上岗资质", "培训状态", "谁能干"],
      notFor: ["考勤（走 personnel.attendance）", "班次 OEE（走 oee.by_shift）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const p = getPersonnel(ctx);
        return {
          keyPositions: p.keyPositions,
          l3PlusRatio: p.l3PlusRatio,
          qualificationStatus: p.l3PlusRatio >= 0.8 ? "adequate" : p.l3PlusRatio >= 0.6 ? "marginal" : "inadequate",
        };
      },
      system: "HR",
      provenance: (a) => `/hr/personnel/skill_matrix?line=${(a.line as string) ?? "L01"}`,
      freshness: "weekly",
      confidence: "measured",
    }),

    // 2. 班次人员配置
    createQueryTool({
      name: "personnel.by_shift",
      description: "查指定产线各班次的关键人员配置。班次间缺陷/OEE 差异 >5% 时交叉分析人员因素。",
      triggers: ["班次人员", "夜班谁值班", "各班次配置", "班次人员对比"],
      notFor: ["技能详情（走 personnel.skill_matrix）", "班次 OEE（走 oee.by_shift）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const p = getPersonnel(ctx);
        const byShift = ["A", "B", "C"] as const;
        return {
          shiftConfig: byShift.map((shift) => ({
            shift,
            positions: p.keyPositions.filter((pos) => pos.shift === shift),
            headcount: p.keyPositions.filter((pos) => pos.shift === shift).length,
          })),
        };
      },
      system: "HR",
      provenance: (a) => `/hr/personnel/by_shift?line=${(a.line as string) ?? "L01"}`,
      freshness: "weekly",
    }),
  ];
}

export type { ScenarioId };
