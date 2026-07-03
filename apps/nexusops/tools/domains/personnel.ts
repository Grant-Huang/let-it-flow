/**
 * 人员技能域工具集（应用层 —— T 内容）。
 *
 * 技能矩阵、上岗资质、班次人员配置。
 * 数据源：HR（人事）+ MES（考勤）。
 *
 * 用于班次差异诊断时交叉分析：某班次缺陷/OEE 异常 → 查该班次人员技能等级。
 */
import { createQueryTool } from "../mock-data/tool-factory.js";
import {
  getPersonnel,
  getAttendance,
  getFatigue,
  type ScenarioId,
} from "../mock-data/scenarios.js";
import { SKILL_ADEQUATE_RATIO, SKILL_MARGINAL_RATIO, FATIGUE_ALARM_THRESHOLD } from "../../config/business-thresholds.js";
import { DEFAULT_LINE } from "../../config/defaults.js";

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
          qualificationStatus: p.l3PlusRatio >= SKILL_ADEQUATE_RATIO ? "adequate" : p.l3PlusRatio >= SKILL_MARGINAL_RATIO ? "marginal" : "inadequate",
        };
      },
      system: "HR",
      provenance: (a) => `/hr/personnel/skill_matrix?line=${(a.line as string) ?? DEFAULT_LINE}`,
      freshness: "weekly",
      confidence: "measured",
      semanticTags: ["personnel_skill"],
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
      provenance: (a) => `/hr/personnel/by_shift?line=${(a.line as string) ?? DEFAULT_LINE}`,
      freshness: "weekly",
      semanticTags: ["personnel_skill", "shift_deviation"],
    }),

    // 3. 考勤数据
    createQueryTool({
      name: "personnel.attendance",
      description:
        "查各班次出勤率/加班时长/缺岗情况。用于班次差异诊断：缺岗 → 技能不足顶岗 → 缺陷率上升的因果关联。" +
        "数据源：HR 考勤系统 + 门禁，班次级粒度（每班每人一条）。",
      triggers: ["考勤", "出勤率", "加班", "缺岗", "出勤", "请假", "迟到"],
      notFor: ["技能等级（走 personnel.skill_matrix）", "疲劳分析（走 personnel.fatigue）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const att = getAttendance(ctx);
        const byShift = ["A", "B", "C"] as const;
        const summary = byShift.map((shift) => {
          const d = att[shift];
          return {
            shift,
            ...d,
            attendanceRate: Number((d.present / d.headcount).toFixed(4)),
            overtimeStatus: d.overtimeHoursWeek > 15 ? "excessive" : d.overtimeHoursWeek > 8 ? "high" : "normal",
          };
        });
        const totalPresent = summary.reduce((s, x) => s + x.present, 0);
        const totalHeadcount = summary.reduce((s, x) => s + x.headcount, 0);
        const totalOvertime = summary.reduce((s, x) => s + x.overtimeHoursWeek, 0);
        return {
          shifts: summary,
          overallAttendanceRate: Number((totalPresent / totalHeadcount).toFixed(4)),
          avgOvertimeHoursWeek: Number((totalOvertime / 3).toFixed(1)),
          hasShortage: summary.some((s) => s.present < s.headcount),
        };
      },
      system: "HR",
      provenance: (a) => `/hr/personnel/attendance?line=${(a.line as string) ?? DEFAULT_LINE}&today=true`,
      freshness: "daily",
      confidence: "measured",
      semanticTags: ["personnel_skill", "shift_deviation"],
    }),

    // 4. 疲劳评分
    createQueryTool({
      name: "personnel.fatigue",
      description:
        "查各班次疲劳评分（0-1，5 代理指标加权合成）+ 每小时错误率拐点。" +
        "疲劳-质量关联分析的核心工具：疲劳分高 → 交叉 quality.by_shift 看缺陷率是否同步升高。" +
        "评分 >0.7 需预警（调整排班或增休息频次）。",
      triggers: ["疲劳", "疲劳分", "夜班疲劳", "连续工作", "疲劳分析", "过劳"],
      notFor: ["出勤事实（走 personnel.attendance）", "技能等级（走 personnel.skill_matrix）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const fat = getFatigue(ctx);
        const byShift = ["A", "B", "C"] as const;
        const summary = byShift.map((shift) => {
          const d = fat[shift];
          return {
            shift,
            ...d,
            threshold: FATIGUE_ALARM_THRESHOLD,
            recommendation:
              d.level === "critical" ? "立即增援/换班，当前疲劳极高，质量风险严峻"
              : d.level === "high" ? "增加休息频次，评估是否可调整排班"
              : d.level === "medium" ? "关注趋势，保持现有休息制度"
              : "疲劳水平正常",
          };
        });
        const worst = summary.reduce((w, s) => (s.fatigueScore > w.fatigueScore ? s : w));
        const errorRateTrend = worst.hourlyErrorRates;
        const peakErrorRate = errorRateTrend[errorRateTrend.length - 1]?.errorRate ?? 0;
        const baseErrorRate = errorRateTrend[0]?.errorRate ?? 0;
        return {
          shifts: summary,
          worstShift: worst.shift,
          worstScore: worst.fatigueScore,
          errorRateAmplification: Number(((peakErrorRate / Math.max(baseErrorRate, 0.001))).toFixed(2)),
          fatigueQualityLink: worst.fatigueScore > 0.7
            ? `疲劳分 ${worst.fatigueScore.toFixed(2)} 超阈值，${worst.shift} 班末段错误率可达基线 ${((peakErrorRate / Math.max(baseErrorRate, 0.001))).toFixed(1)}x`
            : "疲劳水平可控，未观测到显著错误率放大",
        };
      },
      system: "HR",
      provenance: (a) => `/hr/personnel/fatigue?line=${(a.line as string) ?? DEFAULT_LINE}&today=true`,
      freshness: "shift",
      confidence: "inferred",
      semanticTags: ["personnel_skill", "shift_deviation"],
    }),
  ];
}

export type { ScenarioId };
