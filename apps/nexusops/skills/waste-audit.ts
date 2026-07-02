/**
 * skill.waste_audit：精益七大浪费审计（应用层 —— L 内容）。
 *
 * 替代原 domain 工具 lean.waste_audit。原工具直取 7 个 accessor（跨域耦合），
 * 现改为 7 步 skill，每步 ctx.call 一个 Layer 1 工具。
 *
 * 步骤序列：
 *   1. ctx.call("material.wip_level") → 过量生产/库存浪费
 *   2. ctx.call("equipment.downtime") + ctx.call("schedule.ct_vs_takt") → 等待浪费
 *   3. ctx.call("material.routing") → 运输浪费
 *   4. ctx.call("quality.cp_cpk") + ctx.call("oee.realtime") → 过度加工浪费
 *   5. ctx.call("quality.defect_rate") + ctx.call("quality.scrap") → 缺陷浪费
 *   6. ctx.call("skill.cost_summary") → 成本汇总（skill 套 skill）
 *   7. 组装七大浪费报告
 */
import { createSkill } from "../../../src/agent/skill-bridge.js";
import { wrapEvidence, type EvidenceEnvelope } from "../../../src/core/evidence-envelope.js";

/** 从工具返回结果（ToolResult.output）中解包 EvidenceEnvelope.data。 */
function unpack<T>(env: unknown): T {
  const e = env as EvidenceEnvelope<T>;
  return e.data;
}

interface WasteItem {
  type: string;
  typeEn: string;
  detected: boolean;
  severity: "none" | "low" | "medium" | "high";
  evidence: string;
  lossEstimate: string;
  recommendation: string;
}

export function createWasteAuditSkill() {
  return createSkill({
    name: "skill.waste_audit",
    description:
      "精益七大浪费审计：通过 ctx.call 串联 OEE/质量/物料/排产/工艺/能耗全域工具，识别丰田七大浪费（muda）并量化损失。输出每类浪费的严重度 + 证据引用 + 改善建议。这是精益改善课题选题的第一数据源。",
    whenToUse: {
      triggers: ["七大浪费", "浪费分析", "精益浪费", "muda", "浪费审计", "浪费识别"],
      notFor: ["单一指标查询（走各域专用工具）", "DMAIC 项目框架（走 skill.dmaic）"],
    },
    inputSchema: {
      type: "object",
      properties: {
        scenarioId: { type: "string", enum: ["normal", "anomaly", "crisis"] },
        line: { type: "string", enum: ["L01", "L02", "L03"] },
      },
    },
    outputSchema: {
      type: "object",
      properties: { data: { type: "object" }, confidence: { type: "string" } },
    },
    outputExample: {
      data: { detectedCount: 3, highSeverityCount: 1, topWaste: "缺陷" },
      confidence: "inferred",
    },

    async steps(input) {
      const { step, narrateSummary: skillSummary, selfCallId } = input;
      const line = typeof input.line === "string" ? input.line : "L01";
      const scenarioId = typeof input.scenarioId === "string" ? input.scenarioId : "anomaly";
      const baseParams = { line, scenarioId };
      const wastes: WasteItem[] = [];

      // Step 1: 过量生产 + 库存浪费（WIP 数据）
      const step1 = await step<{ wipLevel: number; wipMax: number; inventoryHours: number }>(
        "取 WIP 评估过量生产/库存浪费",
        async (ctx) => {
          const env = await ctx.call<{ data: { wipLevel: number; wipMax: number; inventoryHours: number } }>(
            "material.wip_level",
            baseParams,
          );
          return unpack<{ wipLevel: number; wipMax: number; inventoryHours: number }>(env);
        },
      );
      const overproduction = step1.wipLevel > step1.wipMax;
      wastes.push({
        type: "过量生产",
        typeEn: "Overproduction",
        detected: overproduction,
        severity: overproduction ? (step1.wipLevel > step1.wipMax * 1.2 ? "high" : "medium") : "none",
        evidence: `WIP=${step1.wipLevel}/${step1.wipMax}（${overproduction ? "超容" : "正常"}），见 material.wip_level`,
        lossEstimate: overproduction ? `WIP 积压 ${step1.wipLevel - step1.wipMax} 件，占用资金 + 隐性库存成本` : "无",
        recommendation: overproduction ? "降低投放节拍，实施限产去库存化" : "维持拉动式生产",
      });
      const inventoryWaste = step1.wipLevel > step1.wipMax * 0.8 || step1.inventoryHours > 48;
      wastes.push({
        type: "库存",
        typeEn: "Inventory",
        detected: inventoryWaste,
        severity: step1.wipLevel > step1.wipMax ? "high" : step1.wipLevel > step1.wipMax * 0.8 ? "medium" : "low",
        evidence: `WIP 利用率 ${((step1.wipLevel / step1.wipMax) * 100).toFixed(0)}%，库存 ${step1.inventoryHours}h（见 material.wip_level）`,
        lossEstimate: inventoryWaste ? "库存掩盖问题，占用资金 + 过期风险" : "库存水平合理",
        recommendation: inventoryWaste ? "实施 JIT 拉动，降低安全库存水位" : "维持当前库存策略",
      });

      // Step 2: 等待浪费（停机 + CT>Takt）
      const step2 = await step<{ waitFromDowntime: number; ctTaktGap: number }>(
        "取停机与 CT/Takt 评估等待浪费",
        async (ctx) => {
          const dtEnv = await ctx.call<{ data: { totalDowntimeMinutes: number } }>("equipment.downtime", baseParams);
          const dt = unpack<{ totalDowntimeMinutes: number }>(dtEnv);
          const ctEnv = await ctx.call<{ data: { ctSeconds: number; taktSeconds: number } }>("schedule.ct_vs_takt", baseParams);
          const ct = unpack<{ ctSeconds: number; taktSeconds: number }>(ctEnv);
          return { waitFromDowntime: dt.totalDowntimeMinutes, ctTaktGap: Math.max(0, ct.ctSeconds - ct.taktSeconds) };
        },
      );
      const totalWait = step2.waitFromDowntime + (step2.ctTaktGap > 0 ? step2.ctTaktGap * 0.5 : 0);
      wastes.push({
        type: "等待",
        typeEn: "Waiting",
        detected: totalWait > 60,
        severity: totalWait > 180 ? "high" : totalWait > 60 ? "medium" : "low",
        evidence: `停机等待 ${step2.waitFromDowntime}min + CT-Takt 差 ${step2.ctTaktGap}s（见 equipment.downtime / schedule.ct_vs_takt）`,
        lossEstimate: `合计等待约 ${Math.round(totalWait)} min/班，折算产能损失`,
        recommendation: totalWait > 180 ? "优先解决停机根因（走 equipment.downtime）+ 减少排队（走 material.flow）" : "等待可控",
      });

      // Step 3: 运输浪费（routing 数据）
      const step3 = await step<{ totalMove: number; totalDist: number }>(
        "取工序路线评估运输浪费",
        async (ctx) => {
          const env = await ctx.call<{ data: { routes: Array<{ distanceM: number; moveMin: number }> } }>(
            "material.routing",
            baseParams,
          );
          const r = unpack<{ routes: Array<{ distanceM: number; moveMin: number }> }>(env);
          return {
            totalMove: r.routes.reduce((s, x) => s + x.moveMin, 0),
            totalDist: r.routes.reduce((s, x) => s + x.distanceM, 0),
          };
        },
      );
      wastes.push({
        type: "运输",
        typeEn: "Transport",
        detected: step3.totalDist > 20,
        severity: step3.totalDist > 40 ? "medium" : step3.totalDist > 20 ? "low" : "none",
        evidence: `搬运总距离 ${step3.totalDist}m，搬运时间 ${step3.totalMove}min/件（见 material.routing）`,
        lossEstimate: `搬运非增值时间 ${step3.totalMove}min/件 × 日产量`,
        recommendation: step3.totalDist > 40 ? "优化产线布局缩短搬运距离，或改用连续流" : "布局合理",
      });

      // Step 4: 过度加工浪费（Cpk + OEE）
      const step4 = await step<{ overProcess: boolean; cpk: number; quality: number }>(
        "取 Cpk 与 OEE 评估过度加工浪费",
        async (ctx) => {
          const cpEnv = await ctx.call<{ data: { cpk: number } }>("quality.cp_cpk", baseParams);
          const cp = unpack<{ cpk: number }>(cpEnv);
          const oeeEnv = await ctx.call<{ data: { quality: number } }>("oee.realtime", baseParams);
          const o = unpack<{ quality: number }>(oeeEnv);
          return { overProcess: 1 - o.quality > 0.05 && cp.cpk > 1.33, cpk: cp.cpk, quality: o.quality };
        },
      );
      wastes.push({
        type: "过度加工",
        typeEn: "Over-processing",
        detected: step4.overProcess,
        severity: step4.overProcess ? "low" : "none",
        evidence: step4.overProcess
          ? `质量率 ${(step4.quality * 100).toFixed(1)}% 但 Cpk=${step4.cpk.toFixed(2)} 过高（过度控制）`
          : "加工精度与需求匹配",
        lossEstimate: step4.overProcess ? "可能的过度控制成本（tighter tolerance than needed）" : "无",
        recommendation: step4.overProcess ? "评估是否可放宽公差以降低加工成本" : "维持当前加工标准",
      });

      // Step 5: 缺陷浪费（不良率 + 报废）
      const step5 = await step<{ defectRate: number; scrapRate: number; fpy: number }>(
        "取缺陷率与报废评估缺陷浪费",
        async (ctx) => {
          const drEnv = await ctx.call<{ data: { defectRate: number; fpy: number } }>("quality.defect_rate", baseParams);
          const dr = unpack<{ defectRate: number; fpy: number }>(drEnv);
          const scEnv = await ctx.call<{ data: { scrapRate: number } }>("quality.scrap", baseParams);
          const sc = unpack<{ scrapRate: number }>(scEnv);
          return { defectRate: dr.defectRate, scrapRate: sc.scrapRate, fpy: dr.fpy };
        },
      );
      const defectWaste = step5.defectRate > 0.03 || step5.scrapRate > 0.02;
      wastes.push({
        type: "缺陷",
        typeEn: "Defect",
        detected: defectWaste,
        severity: step5.defectRate > 0.05 ? "high" : step5.defectRate > 0.03 ? "medium" : "low",
        evidence: `不良率 ${(step5.defectRate * 100).toFixed(1)}%，报废率 ${(step5.scrapRate * 100).toFixed(1)}%，FPY ${(step5.fpy * 100).toFixed(1)}%（见 quality.defect_rate / quality.scrap）`,
        lossEstimate: `日报废约 ${Math.round(step5.scrapRate * 1000)} 件 + 返工 ${Math.round((1 - step5.fpy - step5.scrapRate) * 1000)} 件`,
        recommendation: defectWaste ? "走 quality.pareto 识别关键缺陷 → quality.five_why 追根因" : "质量水平可控",
      });

      // 动作浪费（无直接数据源，固定描述）
      wastes.push({
        type: "动作",
        typeEn: "Motion",
        detected: false,
        severity: "none",
        evidence: "无直接动作采集数据（需 IE 时间研究/视频分析），建议人工观测",
        lossEstimate: "需 IE 部门实地测绘量化",
        recommendation: "安排 IE 做工序动作分析（MODAPTS/MTM），识别不必要的弯腰/转身/寻找",
      });

      // 未利用的员工智慧（第八浪费）
      wastes.push({
        type: "未利用的智慧",
        typeEn: "Unused Talent",
        detected: false,
        severity: "none",
        evidence: "需结合 04-人与组织/ 知识库中阻力记录 + 改善提案系统数据分析",
        lossEstimate: "隐性损失（创新未激发 + 士气下降）",
        recommendation: "建立改善提案制度，激活一线员工智慧",
      });

      // Step 6: 成本汇总（skill 套 skill）
      const step6 = await step<{ totalLossCost: number }>("取成本汇总", async (ctx) => {
        const env = await ctx.call<{ data: { totalLossCost: number } }>("skill.cost_summary", baseParams);
        const c = unpack<{ totalLossCost: number }>(env);
        return { totalLossCost: c.totalLossCost };
      });

      // Step 7: 组装报告
      const step7 = await step<EvidenceEnvelope>("组装七大浪费报告", async () => {
        const detected = wastes.filter((w) => w.detected);
        const highSeverity = wastes.filter((w) => w.severity === "high");
        const sorted = [...wastes].sort((a, b) => {
          const order = { high: 0, medium: 1, low: 2, none: 3 };
          return order[a.severity] - order[b.severity];
        });
        const reasoningChain = sorted.filter((w) => w.detected).map((w, i) => ({
          step: i + 1,
          action: `扫描 ${w.type} 浪费`,
          tool: w.type === "过量生产" || w.type === "库存" ? "material.wip_level"
            : w.type === "等待" ? "equipment.downtime + schedule.ct_vs_takt"
            : w.type === "运输" ? "material.routing"
            : w.type === "过度加工" ? "quality.cp_cpk + oee.realtime"
            : w.type === "缺陷" ? "quality.defect_rate + quality.scrap"
            : "（无直接数据源）",
          finding: w.evidence,
          inference: `${w.severity === "high" ? "高危" : w.severity === "medium" ? "中等" : "轻度"}：${w.lossEstimate}`,
        }));
        const ruledOut = sorted.filter((w) => !w.detected).map((w) => `${w.type}（${w.evidence}）`);
        const summary =
          highSeverity.length > 0
            ? `检测到 ${highSeverity.length} 项高危浪费：${highSeverity.map((w) => w.type).join("、")}。日损失成本约 ${step6.totalLossCost} 元`
            : detected.length > 0
              ? `检测到 ${detected.length} 项轻度浪费，建议预防性改善`
              : "七大浪费检测均正常";
        const diagnosis = `${line} 七大浪费：${summary}`;
        return wrapEvidence(
          {
            line,
            scenarioId,
            diagnosis,
            wastes: sorted,
            detectedCount: detected.length,
            highSeverityCount: highSeverity.length,
            totalLossCostToday: step6.totalLossCost,
            topWaste: sorted[0]?.type ?? "无",
            summary,
            reasoningChain,
            ruledOut,
            confidence: 0.8,
            recommendedNextStep:
              highSeverity.length > 0
                ? "对高危浪费走对应域工具深入分析（equipment.downtime / quality.pareto / material.wip_level）"
                : "维持当前水平，定期复检",
          },
          {
            freshness: "daily",
            confidence: "inferred",
            system: "MOM",
            provenance: `skill.waste_audit?line=${line}`,
            caveat: "由 material/equipment/schedule/quality/oee 工具实时组合",
          },
        );
      });

      const wasteData = step7.data as { summary?: string; detectedCount?: number; highSeverityCount?: number };
      await skillSummary(
        `推理完成（${(step7.data as { reasoningChain?: unknown[] }).reasoningChain?.length ?? 0} 步扫描七大浪费）。\n` +
        `结论：${wasteData.summary ?? "完成"}。\n` +
        `详见 [完整浪费审计](#artifact:${selfCallId})。`,
      );

      return step7;
    },
  });
}
