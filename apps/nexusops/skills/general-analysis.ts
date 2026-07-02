/**
 * skill.general_analysis：通用兜底诊断（应用层 —— L 内容）。
 *
 * 当用户意图未命中任何专用 skill 的 triggers 时，harness 会调它。
 * 遵循"取数→分流→交叉验证→结论"四环节推理范式，
 * 输出完整的 reasoningChain 让用户看到"怎么得出结论的"。
 *
 * 步骤序列：
 *   1. 取数基线：oee.realtime + quality.defect_rate + equipment.health（三域快照）
 *   2. 分流定位：按最大偏离项决定深入取证方向（设备/工艺/质量）
 *   3. 交叉验证：调对应域工具 + 因果链，多源证据互证
 *   4. 组装诊断：diagnosis + reasoningChain + ruledOut + narrateSummary（含产物链接）
 */
import { createSkill } from "../../../src/agent/skill-bridge.js";
import { wrapEvidence, type EvidenceEnvelope } from "../../../src/core/evidence-envelope.js";
import { narrate } from "../../../src/core/narrate.js";

/** 从工具返回结果（ToolResult.output）中解包 EvidenceEnvelope.data。 */
function unpack<T>(env: unknown): T {
  const e = env as EvidenceEnvelope<T>;
  return e.data;
}

interface ReasoningStep {
  step: number;
  action: string;
  tool: string;
  finding: string;
  inference: string;
}

export function createGeneralAnalysisSkill() {
  return createSkill({
    name: "skill.general_analysis",
    description:
      "通用运营分析兜底：当用户意图未命中专用 skill（OEE 诊断/停机根因/七大浪费等）时使用。" +
      "四环节推理（取数基线→分流定位→交叉验证→组装诊断），覆盖效率/质量/设备三域，输出完整推理链。" +
      "适合宽泛的'帮我看看/分析一下/诊断'类请求。",
    whenToUse: {
      triggers: ["分析", "诊断", "看看", "情况", "怎么样", "综合分析", "帮我看看", "分析一下", "诊断一下", "了解一下"],
      notFor: [
        "OEE 专项诊断（走 skill.oee_diagnose）",
        "停机根因（走 skill.downtime_root_cause）",
        "七大浪费（走 skill.waste_audit）",
        "DMAIC 项目（走 skill.dmaic）",
        "成本汇总（走 skill.cost_summary）",
      ],
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
      data: {
        diagnosis: "L01综合诊断：OEE=65%，主因设备停机",
        reasoningChain: [{ step: 1, action: "取数基线", tool: "oee.realtime", finding: "...", inference: "..." }],
        confidence: 0.75,
      },
      confidence: "inferred",
    },

    async steps(input) {
      const { step, narrate: skillNarrate, narrateSummary, selfCallId } = input;
      const line = typeof input.line === "string" ? input.line : "L01";
      const scenarioId = typeof input.scenarioId === "string" ? input.scenarioId : "anomaly";
      const baseParams = { line, scenarioId };
      const reasoningChain: ReasoningStep[] = [];
      const ruledOut: string[] = [];

      await skillNarrate(`我开始综合分析（产线 ${line}，场景 ${scenarioId}）。`);

      // ── Step 1: 取数基线 ──────────────────────────────────────────────
      const step1 = await step<{
        oee: number; target: number; availability: number; performance: number; quality: number;
        defectRate: number; cpk: number; healthScore: number;
      }>("取数基线：OEE + 质量 + 设备三域快照", async (ctx) => {
        await narrate(ctx, "正在取 OEE、质量、设备三域基线数据…");
        const oeeEnv = await ctx.call<{ data: { oee: number; target: number; availability: number; performance: number; quality: number } }>(
          "oee.realtime", baseParams,
        );
        const o = unpack<{ oee: number; target: number; availability: number; performance: number; quality: number }>(oeeEnv);
        const qEnv = await ctx.call<{ data: { defectRate: number } }>("quality.defect_rate", baseParams);
        const q = unpack<{ defectRate: number }>(qEnv);
        const cpEnv = await ctx.call<{ data: { cpk: number } }>("quality.cp_cpk", baseParams);
        const cp = unpack<{ cpk: number }>(cpEnv);
        const hEnv = await ctx.call<{ data: { healthScore: number } }>("equipment.health", baseParams);
        const h = unpack<{ healthScore: number }>(hEnv);
        await narrate(
          ctx,
          `基线：OEE=${(o.oee * 100).toFixed(1)}%（目标 ${(o.target * 100).toFixed(1)}%），不良率 ${(q.defectRate * 100).toFixed(1)}%，Cpk=${cp.cpk.toFixed(2)}，设备健康 ${h.healthScore.toFixed(2)}。`,
        );
        return {
          oee: o.oee, target: o.target,
          availability: o.availability, performance: o.performance, quality: o.quality,
          defectRate: q.defectRate, cpk: cp.cpk, healthScore: h.healthScore,
        };
      });

      const oeeGap = step1.target - step1.oee;
      const isOeeAbnormal = oeeGap > 0.05;
      const isQualityAbnormal = step1.defectRate > 0.03 || step1.cpk < 1.0;
      const isEquipmentAbnormal = step1.healthScore < 0.7;

      reasoningChain.push({
        step: 1,
        action: "取数基线：OEE + 质量 + 设备三域快照",
        tool: "oee.realtime + quality.defect_rate + equipment.health",
        finding: `OEE=${(step1.oee * 100).toFixed(1)}%（目标 ${(step1.target * 100).toFixed(1)}%，差 ${(oeeGap * 100).toFixed(1)}pp），不良率 ${(step1.defectRate * 100).toFixed(1)}%，Cpk=${step1.cpk.toFixed(2)}，设备健康 ${step1.healthScore.toFixed(2)}`,
        inference: isOeeAbnormal || isQualityAbnormal || isEquipmentAbnormal
          ? `检测到异常：${[isOeeAbnormal ? "OEE 偏低" : null, isQualityAbnormal ? "质量异常" : null, isEquipmentAbnormal ? "设备健康低" : null].filter(Boolean).join("、")}，需分流定位主因`
          : "三项指标均在正常范围，无需深入",
      });

      if (!isOeeAbnormal && !isQualityAbnormal && !isEquipmentAbnormal) {
        // 正常场景：快速收尾
        ruledOut.push("OEE（达标）", "质量（Cpk≥1.0 且不良率<3%）", "设备（健康分≥0.7）");
        const finalEnvelope = wrapEvidence(
          {
            line, scenarioId,
            diagnosis: `${line} 产线综合状态正常：OEE=${(step1.oee * 100).toFixed(1)}%，Cpk=${step1.cpk.toFixed(2)}，设备健康 ${step1.healthScore.toFixed(2)}，未检测到显著异常`,
            reasoningChain,
            ruledOut,
            confidence: 0.9,
            metrics: { oee: step1.oee, defectRate: step1.defectRate, cpk: step1.cpk, healthScore: step1.healthScore },
            recommendedSkill: null,
          },
          {
            freshness: "realtime", confidence: "measured", system: "MOM",
            provenance: `skill.general_analysis?line=${line}`,
          },
        );
        const rc = reasoningChain;
        await narrateSummary(
          `推理完成（${rc.length} 步）：${rc.map((s) => s.inference).join(" → ")}。\n` +
          `结论：${(finalEnvelope.data as { diagnosis: string }).diagnosis}\n` +
          `详见 [完整诊断](#artifact:${selfCallId})。`,
        );
        return finalEnvelope;
      }

      // ── Step 2: 分流定位 ─────────────────────────────────────────────
      const step2 = await step<{ primaryAxis: "equipment" | "process" | "quality" | "mixed"; rationale: string }>(
        "分流定位：按最大偏离项决定取证方向",
        async (ctx) => {
          // OEE 分解看哪一项损失最大
          const decEnv = await ctx.call<{ data: { availability: number; performance: number; quality: number } }>(
            "oee.decompose", baseParams,
          );
          const dec = unpack<{ availability: number; performance: number; quality: number }>(decEnv);
          const losses = [
            { axis: "availability" as const, val: 1 - dec.availability },
            { axis: "performance" as const, val: 1 - dec.performance },
            { axis: "quality" as const, val: 1 - dec.quality },
          ];
          const biggest = losses.sort((a, b) => b.val - a.val)[0]!;
          const primaryAxis = isEquipmentAbnormal && biggest.axis === "availability"
            ? "equipment"
            : biggest.axis === "quality" && isQualityAbnormal
              ? "quality"
              : biggest.axis === "performance"
                ? "process"
                : "mixed";
          const rationale = `OEE 损失分解：可用率缺 ${(losses[0]!.val * 100).toFixed(1)}pp、性能缺 ${(losses[1]!.val * 100).toFixed(1)}pp、质量缺 ${(losses[2]!.val * 100).toFixed(1)}pp；最大损失项=${biggest.axis}`;
          await narrate(ctx, `分流：${rationale} → 取证方向 ${primaryAxis}。`);
          return { primaryAxis, rationale };
        },
      );

      reasoningChain.push({
        step: 2,
        action: "分流定位：按最大偏离项决定取证方向",
        tool: "oee.decompose",
        finding: step2.rationale,
        inference: `主因指向 ${step2.primaryAxis} 域，下一步深入取证`,
      });

      // ── Step 3: 交叉验证 ─────────────────────────────────────────────
      const step3 = await step<{
        evidenceSummary: string;
        rootCause: string;
        ruledCandidates: string[];
      }>("交叉验证：对应域工具 + 因果链多源互证", async (ctx) => {
        await narrate(ctx, `正在对 ${step2.primaryAxis} 域深入取证 + 因果链交叉验证…`);
        const ruledCandidates: string[] = [];
        let evidenceSummary = "";
        let rootCause = "待定";

        if (step2.primaryAxis === "equipment") {
          const dtEnv = await ctx.call<{ data: { totalDowntimeMinutes: number; eventCount: number } }>("equipment.downtime", baseParams);
          const dt = unpack<{ totalDowntimeMinutes: number; eventCount: number }>(dtEnv);
          const fwEnv = await ctx.call<{ data: { chains: Array<{ rootCause: string; layers: string[] }> } }>("quality.five_why", baseParams);
          const fw = unpack<{ chains: Array<{ rootCause: string; layers: string[] }> }>(fwEnv);
          evidenceSummary = `停机 ${dt.totalDowntimeMinutes}min（${dt.eventCount} 起）`;
          if (fw.chains.length > 0) {
            rootCause = fw.chains[0]!.rootCause;
            evidenceSummary += `；5Why 根因：${rootCause}`;
          }
          // 排除：工艺偏离分低 → 非工艺主因
          const prEnv = await ctx.call<{ data: { deviationScore: number } }>("process.deviation", baseParams);
          const pr = unpack<{ deviationScore: number }>(prEnv);
          if (pr.deviationScore < 0.3) ruledCandidates.push(`工艺偏差（偏离分 ${pr.deviationScore.toFixed(2)} < 0.3 阈值）`);
        } else if (step2.primaryAxis === "quality") {
          const parEnv = await ctx.call<{ data: { topDefects: Array<{ type: string; pct: number }> } }>("quality.pareto", baseParams);
          const par = unpack<{ topDefects: Array<{ type: string; pct: number }> }>(parEnv);
          const topDefect = par.topDefects[0];
          evidenceSummary = `关键缺陷：${topDefect ? `${topDefect.type}（占 ${(topDefect.pct * 100).toFixed(0)}%）` : "无"}`;
          rootCause = topDefect ? `${topDefect.type} 为主要缺陷类型` : "缺陷数据不足";
          // 排除：设备健康正常 → 非设备致质量
          if (step1.healthScore >= 0.7) ruledCandidates.push(`设备致质量（健康分 ${step1.healthScore.toFixed(2)} ≥ 0.7，正常）`);
        } else if (step2.primaryAxis === "process") {
          const prEnv = await ctx.call<{ data: { deviationScore: number; deviations: Array<{ param: string; actual: number; inSpec: boolean }> } }>("process.deviation", baseParams);
          const pr = unpack<{ deviationScore: number; deviations: Array<{ param: string; actual: number; inSpec: boolean }> }>(prEnv);
          const outOfSpec = pr.deviations.filter((d) => !d.inSpec);
          evidenceSummary = `偏离分 ${pr.deviationScore.toFixed(2)}，超规格参数 ${outOfSpec.length} 项：${outOfSpec.map((d) => `${d.param}=${d.actual}`).join(", ")}`;
          rootCause = outOfSpec.length > 0 ? `${outOfSpec[0]!.param} 偏离规格` : "工艺偏离但均在规格内";
        } else {
          // mixed：综合取证
          const costEnv = await ctx.call<{ data: { totalLossCost: number } }>("skill.cost_summary", baseParams);
          const cost = unpack<{ totalLossCost: number }>(costEnv);
          evidenceSummary = `综合损失 ${cost.totalLossCost} 元/日，多域均有贡献`;
          rootCause = "多因素叠加，无单一主因";
        }

        await narrate(ctx, `交叉验证完成：${evidenceSummary}。`);
        return { evidenceSummary, rootCause, ruledCandidates };
      });

      reasoningChain.push({
        step: 3,
        action: "交叉验证：对应域工具 + 因果链多源互证",
        tool: step2.primaryAxis === "equipment" ? "equipment.downtime + quality.five_why + process.deviation"
          : step2.primaryAxis === "quality" ? "quality.pareto"
          : step2.primaryAxis === "process" ? "process.deviation"
          : "skill.cost_summary",
        finding: step3.evidenceSummary,
        inference: step3.rootCause === "待定"
          ? "证据不足以确定根因，建议用专用 skill 深入"
          : `根因指向：${step3.rootCause}`,
      });
      ruledOut.push(...step3.ruledCandidates);

      // ── Step 4: 组装诊断 ─────────────────────────────────────────────
      const confidence = step3.rootCause === "待定" ? 0.4 : step2.primaryAxis === "mixed" ? 0.6 : 0.78;
      const recommendedSkill =
        step2.primaryAxis === "equipment" ? "skill.oee_diagnose"
        : step2.primaryAxis === "quality" ? "skill.oee_diagnose"
        : step2.primaryAxis === "process" ? "skill.oee_diagnose"
        : "skill.cost_summary";

      const finalEnvelope = await step<EvidenceEnvelope>("组装综合诊断报告", async () => {
        const diagnosis = step3.rootCause === "待定"
          ? `${line} 综合分析：检测到异常（OEE=${(step1.oee * 100).toFixed(1)}%）但证据不足以确定单一根因，建议用 ${recommendedSkill} 深入`
          : `${line} 综合诊断：OEE=${(step1.oee * 100).toFixed(1)}%（目标 ${(step1.target * 100).toFixed(1)}%），主因 ${step2.primaryAxis} 域（${step3.rootCause}）`;

        return wrapEvidence(
          {
            line, scenarioId,
            diagnosis,
            reasoningChain,
            ruledOut,
            confidence,
            metrics: {
              oee: step1.oee, oeeTarget: step1.target,
              availability: step1.availability, performance: step1.performance, quality: step1.quality,
              defectRate: step1.defectRate, cpk: step1.cpk, healthScore: step1.healthScore,
            },
            primaryAxis: step2.primaryAxis,
            rootCause: step3.rootCause,
            recommendedSkill,
          },
          {
            freshness: "realtime", confidence: "inferred", system: "MOM",
            provenance: `skill.general_analysis?line=${line}`,
            caveat: `由 oee/quality/equipment/process 工具实时组合，主因轴=${step2.primaryAxis}`,
          },
        );
      });

      const rc = reasoningChain;
      await narrateSummary(
        `推理完成（${rc.length} 步）：${rc.map((s) => s.inference).join(" → ")}。\n` +
        `结论：${(finalEnvelope.data as { diagnosis: string }).diagnosis}（置信度 ${Math.round(confidence * 100)}%）。\n` +
        `详见 [完整诊断](#artifact:${selfCallId})。`,
      );

      return finalEnvelope;
    },
  });
}
