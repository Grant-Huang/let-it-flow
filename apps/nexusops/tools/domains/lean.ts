/**
 * 精益分析域工具集（应用层 —— T 内容）。
 *
 * 跨域聚合分析：七大浪费审计 + DMAIC 改善项目管理框架。
 * 这两个工具不是新数据源，而是对已有 8 个域数据的"元分析"，
 * 从精益/六西格玛方法论视角重新组织证据。
 *
 * 数据源：内部交叉调用 oee/quality/material/schedule/equipment/cost 各域 accessor。
 */
import { createQueryTool } from "../mock-data/tool-factory.js";
import {
  getOEE,
  getQuality,
  getMaterial,
  getSchedule,
  getEquipment,
  getEnergy,
  getCost,
  getRouting,
  getCausalChain,
  type ScenarioId,
} from "../mock-data/scenarios.js";
import { DEFAULT_LINE } from "../../config/defaults.js";

export function registerLeanTools(): import("../../../../src/tools/base.js").FlowConnector[] {
  return [
    // 1. 精益七大浪费审计
    createQueryTool({
      name: "lean.waste_audit",
      description:
        "精益七大浪费审计：扫描 OEE/质量/物料/排产/工艺/能耗全域数据，识别丰田七大浪费（muda）并量化损失。" +
        "输出每类浪费的严重度 + 证据引用 + 改善建议。这是精益改善课题选题的第一数据源。",
      triggers: ["七大浪费", "浪费分析", "精益浪费", "muda", "浪费审计", "浪费识别"],
      notFor: ["单一指标查询（走各域专用工具）", "DMAIC 项目框架（走 lean.dmaic）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const oee = getOEE(ctx);
        const q = getQuality(ctx);
        const m = getMaterial(ctx);
        const s = getSchedule(ctx);
        const eq = getEquipment(ctx);
        const cost = getCost(ctx);
        const routing = getRouting(ctx);

        const wastes: Array<{
          type: string;
          typeEn: string;
          detected: boolean;
          severity: "none" | "low" | "medium" | "high";
          evidence: string;
          lossEstimate: string;
          recommendation: string;
        }> = [];

        // 1. 过量生产浪费（WIP 超容）
        const overproduction = m.wipLevel > m.wipMax;
        wastes.push({
          type: "过量生产",
          typeEn: "Overproduction",
          detected: overproduction,
          severity: overproduction ? (m.wipLevel > m.wipMax * 1.2 ? "high" : "medium") : "none",
          evidence: `WIP=${m.wipLevel}/${m.wipMax}（${overproduction ? "超容" : "正常"}），见 MATERIAL.${ctx.line ?? DEFAULT_LINE}`,
          lossEstimate: overproduction ? `WIP 积压 ${m.wipLevel - m.wipMax} 件，占用资金 + 隐性库存成本` : "无",
          recommendation: overproduction ? "降低投放节拍，实施限产去库存化" : "维持拉动式生产",
        });

        // 2. 等待浪费（停机 + 缺料排队 + CT>Takt）
        const waitFromDowntime = eq.downtimeEvents.reduce((sum, e) => sum + e.minutes, 0);
        const waitFromQueue = routing.routes.reduce((s, r) => s + r.waitMin, 0);
        const ctTaktGap = Math.max(0, s.ctSeconds - s.taktSeconds);
        const totalWait = waitFromDowntime + waitFromQueue + (ctTaktGap > 0 ? ctTaktGap * 0.5 : 0);
        wastes.push({
          type: "等待",
          typeEn: "Waiting",
          detected: totalWait > 60,
          severity: totalWait > 180 ? "high" : totalWait > 60 ? "medium" : "low",
          evidence: `停机等待 ${waitFromDowntime}min + 工序间排队 ${waitFromQueue}min + CT-Takt 差 ${ctTaktGap}s（见 EQUIPMENT/SCHEDULE/ROUTING）`,
          lossEstimate: `合计等待约 ${Math.round(totalWait)} min/班，折算产能损失`,
          recommendation: totalWait > 180 ? "优先解决停机根因（走 equipment.downtime）+ 减少排队（走 material.flow）" : "等待可控",
        });

        // 3. 运输浪费（搬运距离 + 时间）
        const totalMove = routing.routes.reduce((sum, r) => sum + r.moveMin, 0);
        const totalDist = routing.routes.reduce((sum, r) => sum + r.distanceM, 0);
        wastes.push({
          type: "运输",
          typeEn: "Transport",
          detected: totalDist > 20,
          severity: totalDist > 40 ? "medium" : totalDist > 20 ? "low" : "none",
          evidence: `搬运总距离 ${totalDist}m，搬运时间 ${totalMove}min/件（见 ROUTING.${ctx.line ?? DEFAULT_LINE}）`,
          lossEstimate: `搬运非增值时间 ${totalMove}min/件 × 日产量`,
          recommendation: totalDist > 40 ? "优化产线布局缩短搬运距离，或改用连续流" : "布局合理",
        });

        // 4. 过度加工浪费（参数在 spec 内但偏差大 + 不必要的精度）
        const overProcess = (1 - oee.quality) > 0.05 && q.cpk > 1.33;
        wastes.push({
          type: "过度加工",
          typeEn: "Over-processing",
          detected: overProcess,
          severity: overProcess ? "low" : "none",
          evidence: overProcess
            ? `质量率 ${(oee.quality * 100).toFixed(1)}% 但 Cpk=${q.cpk.toFixed(2)} 过高（过度控制）`
            : "加工精度与需求匹配",
          lossEstimate: overProcess ? "可能的过度控制成本（ tighter tolerance than needed）" : "无",
          recommendation: overProcess ? "评估是否可放宽公差以降低加工成本" : "维持当前加工标准",
        });

        // 5. 库存浪费（WIP + 原材料库存过高）
        const inventoryWaste = m.wipLevel > m.wipMax * 0.8 || m.inventoryHours > 48;
        wastes.push({
          type: "库存",
          typeEn: "Inventory",
          detected: inventoryWaste,
          severity: m.wipLevel > m.wipMax ? "high" : m.wipLevel > m.wipMax * 0.8 ? "medium" : "low",
          evidence: `WIP 利用率 ${((m.wipLevel / m.wipMax) * 100).toFixed(0)}%，库存 ${m.inventoryHours}h（见 MATERIAL）`,
          lossEstimate: inventoryWaste ? `库存掩盖问题，占用资金 + 过期风险` : "库存水平合理",
          recommendation: inventoryWaste ? "实施 JIT 拉动，降低安全库存水位" : "维持当前库存策略",
        });

        // 6. 动作浪费（无直接数据，通过人员技能间接推断）
        wastes.push({
          type: "动作",
          typeEn: "Motion",
          detected: false,
          severity: "none",
          evidence: "无直接动作采集数据（需 IE 时间研究/视频分析），建议人工观测",
          lossEstimate: "需 IE 部门实地测绘量化",
          recommendation: "安排 IE 做工序动作分析（MODAPTS/MTM），识别不必要的弯腰/转身/寻找",
        });

        // 7. 缺陷浪费（不良率 + 报废 + 返工）
        const defectWaste = q.defectRate > 0.03 || q.scrapRate > 0.02;
        wastes.push({
          type: "缺陷",
          typeEn: "Defect",
          detected: defectWaste,
          severity: q.defectRate > 0.05 ? "high" : q.defectRate > 0.03 ? "medium" : "low",
          evidence: `不良率 ${(q.defectRate * 100).toFixed(1)}%，报废率 ${(q.scrapRate * 100).toFixed(1)}%，FPY ${(q.fpy * 100).toFixed(1)}%（见 QUALITY）`,
          lossEstimate: `日报废约 ${Math.round(q.scrapRate * 1000)} 件 + 返工 ${Math.round((1 - q.fpy - q.scrapRate) * 1000)} 件`,
          recommendation: defectWaste ? "走 quality.pareto 识别关键缺陷 → quality.five_why 追根因" : "质量水平可控",
        });

        // 未利用的员工智慧（第八浪费，丰田扩展）
        wastes.push({
          type: "未利用的智慧",
          typeEn: "Unused Talent",
          detected: false,
          severity: "none",
          evidence: "需结合 04-人与组织/ 知识库中阻力记录 + 改善提案系统数据分析",
          lossEstimate: "隐性损失（创新未激发 + 士气下降）",
          recommendation: "建立改善提案制度，激活一线员工智慧",
        });

        const detected = wastes.filter((w) => w.detected);
        const highSeverity = wastes.filter((w) => w.severity === "high");
        const sorted = [...wastes].sort((a, b) => {
          const order = { high: 0, medium: 1, low: 2, none: 3 };
          return order[a.severity] - order[b.severity];
        });

        return {
          line: ctx.line ?? DEFAULT_LINE,
          scenarioId: ctx.scenarioId,
          wastes: sorted,
          detectedCount: detected.length,
          highSeverityCount: highSeverity.length,
          totalLossCostToday: cost.totalLossCost,
          topWaste: sorted[0]?.type ?? "无",
          summary:
            highSeverity.length > 0
              ? `检测到 ${highSeverity.length} 项高危浪费：${highSeverity.map((w) => w.type).join("、")}。日损失成本约 ${cost.totalLossCost} 元`
              : detected.length > 0
                ? `检测到 ${detected.length} 项轻度浪费，建议预防性改善`
                : "七大浪费检测均正常",
          recommendedNextStep: highSeverity.length > 0
            ? "对高危浪费走对应域工具深入分析（equipment.downtime / quality.pareto / material.wip_level）"
            : "维持当前水平，定期复检",
        };
      },
      system: "MOM",
      provenance: (a) => `/mom/lean/waste_audit?line=${(a.line as string) ?? DEFAULT_LINE}`,
      freshness: "daily",
      confidence: "inferred",
      semanticTags: ["waste_audit"],
    }),

    // 2. DMAIC 改善项目管理框架
    createQueryTool({
      name: "lean.dmaic",
      description:
        "DMAIC 改善项目管理框架：按 Define/Measure/Analyze/Improve/Control 五阶段产出改善路线图。" +
        "每阶段关联对应工具和数据，适用于 6Sigma 改善课题的端到端规划。" +
        "输入当前问题的产线，自动组装五阶段行动方案。",
      triggers: ["DMAIC", "6Sigma 项目", "改善项目", "六西格玛", "DMAIC 框架", "改善路线图"],
      notFor: ["七大浪费审计（走 lean.waste_audit）", "单一域诊断（走对应域工具）"],
      inputSchema: { type: "object", properties: {} },
      getData: (ctx) => {
        const q = getQuality(ctx);
        const oee = getOEE(ctx);
        const cost = getCost(ctx);
        const cc = getCausalChain(ctx);
        const s = getSchedule(ctx);
        const eq = getEquipment(ctx);

        const zSt = 3 * q.cpk;
        const zLt = zSt - 1.5;
        const dpmo = Math.round(q.defectRate * 1_000_000);
        const problemStatement = cc.chains.length > 0
          ? cc.symptom
          : `OEE=${(oee.oee * 100).toFixed(1)}%，Cpk=${q.cpk.toFixed(2)}，存在改善空间`;

        return {
          line: ctx.line ?? DEFAULT_LINE,
          scenarioId: ctx.scenarioId,
          projectTitle: `${ctx.line ?? DEFAULT_LINE} 产线改善项目`,
          phases: [
            {
              phase: "D",
              name: "Define（定义）",
              objective: "明确改善课题的范围、目标、财务收益",
              problemStatement,
              goalStatement: `OEE 从 ${(oee.oee * 100).toFixed(1)}% 提升至 ${(oee.target * 100).toFixed(1)}%，Cpk 从 ${q.cpk.toFixed(2)} 提升至 ≥1.33`,
              financialBenefit: `预计日节约 ${Math.round(cost.totalLossCost * 0.3)} 元（假设改善 30% 损失）`,
              tools: ["cost.summary（量化损失）", "schedule.current（定义范围）"],
              status: "ready",
            },
            {
              phase: "M",
              name: "Measure（测量）",
              objective: "量化当前过程的基线表现，建立测量系统",
              baselineMetrics: {
                oee: oee.oee,
                cpk: q.cpk,
                fpy: q.fpy,
                defectRate: q.defectRate,
                scrapRate: q.scrapRate,
                dpmo,
                shortTermSigma: Number(zSt.toFixed(2)),
                longTermSigma: Number(zLt.toFixed(2)),
              },
              measurementSystem: "需验证量具 GR&R（当前无数据，走 quality.inspection 交叉）",
              tools: ["quality.sigma_level", "quality.dpmo", "quality.spc", "quality.cp_cpk"],
              status: "ready",
            },
            {
              phase: "A",
              name: "Analyze（分析）",
              objective: "识别根本原因，建立缺陷与输入变量的因果关系",
              rootCauseAnalysis: cc.chains.length > 0
                ? {
                    method: "5Why + 鱼骨图",
                    rootCause: cc.chains[0]!.rootCause,
                    mechanismPath: cc.chains[0]!.layers.join(" → "),
                    fishboneTopSuspect: cc.fishbone.machine.length >= cc.fishbone.method.length ? "Machine" : "Method",
                  }
                : {
                    method: "待分析（normal 场景无已识别根因）",
                    rootCause: "需收集更多数据后分析",
                  },
              vitalFewDefects: q.topDefects.slice(0, 2),
              tools: ["quality.five_why", "quality.fishbone", "quality.pareto", "process.deviation"],
              status: cc.chains.length > 0 ? "ready" : "blocked_by_data",
            },
            {
              phase: "I",
              name: "Improve（改善）",
              objective: "实施改善方案，验证效果",
              proposedActions: [
                ...(cc.chains.length > 0 ? [{ action: `针对根因"${cc.chains[0]!.rootCause}"实施对策`, tool: "nexus_advise", priority: "high" }] : []),
                ...(eq.healthScore < 0.7 ? [{ action: "设备维护/预测性保养", tool: "mcp.eam.maintenance_order", priority: "high" }] : []),
                ...(q.cpk < 1.0 ? [{ action: "工艺参数回调至标准值", tool: "mcp.process.adjust_parameters", priority: "high" }] : []),
                ...(s.attainment < 0.8 ? [{ action: "排产优化/瓶颈释放", tool: "mcp.mes.schedule_work_order", priority: "medium" }] : []),
              ],
              tools: ["nexus_advise", "mcp.* 动作工具（HITL 确认）"],
              status: "ready",
            },
            {
              phase: "C",
              name: "Control（控制）",
              objective: "建立监控体系，固化改善成果，防止回退",
              controlPlan: {
                spcMonitoring: "对关键尺寸建立 SPC 控制图（走 quality.spc），设 UCL/LCL 报警",
                standardWork: "更新标准作业指导书 + 控制计划（走 process.control_plan）",
                auditFrequency: "每周审核 Cpk 趋势 + 每月评审 OEE 是否达标",
                reactionPlan: "Cpk <1.0 触发紧急复检 + 参数回调",
              },
              targetMetrics: {
                cpk: 1.33,
                oee: oee.target,
                fpy: 0.95,
                sigmaLevel: 4,
              },
              tools: ["quality.spc", "quality.cp_cpk", "process.control_plan", "oee.trend"],
              status: "ready",
            },
          ],
          overallAssessment: {
            currentSigmaLevel: Number(zLt.toFixed(2)),
            targetSigmaLevel: 4,
            gapToTarget: Number(Math.max(0, 4 - zLt).toFixed(2)),
            estimatedProjectDuration: zLt < 2 ? "3-6 个月" : zLt < 3 ? "2-4 个月" : "1-3 个月",
            priority: zLt < 2 ? "critical" : zLt < 3 ? "high" : "medium",
          },
        };
      },
      system: "MOM",
      provenance: (a) => `/mom/lean/dmaic?line=${(a.line as string) ?? DEFAULT_LINE}`,
      freshness: "daily",
      confidence: "inferred",
      semanticTags: ["dmaic", "six_sigma_level"],
    }),
  ];
}

export type { ScenarioId };
