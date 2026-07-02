/**
 * skill.multi_perspective_rca：多视角根因分析流（应用层 —— L 内容）。
 *
 * 对同一问题并行用 5Why + 鱼骨图 + FMEA 三种方法分析，再交叉印证收敛根因。
 * 解决"单一方法论易漏判"问题：5Why 擅长纵向深挖、鱼骨图擅长横向铺开、
 * FMEA 擅长风险量化，三者交叉印证才提高根因置信度。
 *
 * 步骤序列：
 *   1. ctx.call("oee.realtime") + ctx.call("quality.defect_rate") → 锁定问题表象
 *   2. ctx.call("quality.five_why") + ctx.call("quality.fishbone") + ctx.call("process.fmea") → 三视角并行取证
 *   3. 交叉印证（三视角根因重合度判定）
 *   4. 收敛根因 + 置信度（重合度高=高置信）
 *   5. 封装 EvidenceEnvelope
 */
import { createSkill } from "../../../src/agent/skill-bridge.js";
import { wrapEvidence, type EvidenceEnvelope } from "../../../src/core/evidence-envelope.js";
import { narrate, narrateSummary } from "../../../src/core/narrate.js";

/** 从工具返回结果（ToolResult.output）中解包 EvidenceEnvelope.data。 */
function unpack<T>(env: unknown): T {
  const e = env as EvidenceEnvelope<T>;
  return e.data;
}

/** 从维度名提取归一化域标签，用于交叉印证重合度判定。 */
function normalizeDomain(dim: string): string {
  if (/机|machine|设备/i.test(dim)) return "machine";
  if (/法|method|工艺|参数|流程/i.test(dim)) return "method";
  if (/料|material|物料|库存|来料/i.test(dim)) return "material";
  if (/人|man|人员|培训|技能/i.test(dim)) return "man";
  if (/环|environment|温湿/i.test(dim)) return "environment";
  if (/测|measurement|量具|校准/i.test(dim)) return "measurement";
  return dim;
}

export function createMultiPerspectiveRcaSkill() {
  return createSkill({
    name: "skill.multi_perspective_rca",
    description:
      "多视角根因分析流：对同一问题并行用 5Why + 鱼骨图 + FMEA 三种方法分析，再交叉印证收敛根因。封装'多方法论交叉验证'最佳实践，避免单点归因。所有取数走 ctx.call，经过 EvidenceEnvelope 协议。",
    whenToUse: {
      triggers: [
        "多视角分析",
        "多方法交叉验证",
        "5Why 加鱼骨图加 FMEA",
        "根因不确定需多角度",
        "避免单点归因",
        "系统性根因分析",
      ],
      notFor: [
        "单一方法论即可（走对应工具 quality.five_why / quality.fishbone / process.fmea）",
        "OEE 综合诊断（走 skill.oee_diagnose）",
        "设备停机专项（走 skill.downtime_root_cause）",
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
        rootCause: "三视角重合：设备润滑系统（machine 域）",
        confidence: 0.9,
        perspectives: { fiveWhy: "...", fishbone: "...", fmea: "..." },
      },
      confidence: "measured",
    },

    async steps(input) {
      const { step, narrate: skillNarrate, narrateSummary: skillSummary, selfCallId } = input;
      const scenarioId = typeof input.scenarioId === "string" ? input.scenarioId : "anomaly";
      const line = typeof input.line === "string" ? input.line : "L01";
      const baseParams = { scenarioId, line };

      await skillNarrate(`我开始多视角根因分析（场景：${scenarioId}，产线 ${line}）。`);

      // Step 1: 锁定问题表象
      const step1 = await step<{
        symptom: string;
        oee: { oee: number; availability: number; performance: number; quality: number };
        defectRate: number;
      }>("锁定问题表象", async (ctx) => {
        await narrate(ctx, "正在取 OEE 损失分解 + 质量缺陷，锁定问题表象…");
        const oeeEnv = await ctx.call<{ data: { oee: number; availability: number; performance: number; quality: number } }>(
          "oee.realtime",
          baseParams,
        );
        const oee = unpack<{ oee: number; availability: number; performance: number; quality: number }>(oeeEnv);
        const qEnv = await ctx.call<{ data: { defectRate: number } }>("quality.defect_rate", baseParams);
        const q = unpack<{ defectRate: number }>(qEnv);
        const fwEnv = await ctx.call<{ data: { symptom: string; chains: unknown[] } }>("quality.five_why", baseParams);
        const fw = unpack<{ symptom: string; chains: unknown[] }>(fwEnv);
        const symptom = fw.symptom && fw.chains.length > 0
          ? fw.symptom
          : `OEE=${(oee.oee * 100).toFixed(1)}%，缺陷率=${(q.defectRate * 100).toFixed(1)}%`;
        await narrate(
          ctx,
          `问题表象：${symptom}（OEE 三要素：可用 ${(oee.availability * 100).toFixed(0)}% / 性能 ${(oee.performance * 100).toFixed(0)}% / 质量 ${(oee.quality * 100).toFixed(0)}%）。`,
        );
        return { symptom, oee, defectRate: q.defectRate };
      });

      // Step 2: 三视角并行取证
      const step2 = await step<{
        fiveWhy: Array<{ rootCause: string }>;
        fishbone: Array<{ dimension: string; factors: string[] }>;
        fmeaHighRisk: unknown[];
      }>("三视角并行取证（5Why + 鱼骨图 + FMEA）", async (ctx) => {
        await narrate(ctx, "正在并行调 quality.five_why / quality.fishbone / process.fmea…");
        const fwEnv = await ctx.call<{ data: { chains: Array<{ rootCause: string }> } }>("quality.five_why", baseParams);
        const fw = unpack<{ chains: Array<{ rootCause: string }> }>(fwEnv);
        const fbEnv = await ctx.call<{ data: { branches: Array<{ dimension: string; factors: string[] }> } }>("quality.fishbone", baseParams);
        const fb = unpack<{ branches: Array<{ dimension: string; factors: string[] }> }>(fbEnv);
        const fmeaEnv = await ctx.call<{ data: { highRisk: unknown[] } }>("process.fmea", baseParams);
        const fmea = unpack<{ highRisk: unknown[] }>(fmeaEnv);
        const nonEmptyBranches = fb.branches.filter((b) => b.factors.length > 0);
        await narrate(
          ctx,
          `5Why 链 ${fw.chains.length} 条，鱼骨图 ${nonEmptyBranches.length}/6 维度有证据，FMEA 高风险项 ${fmea.highRisk.length} 个。`,
        );
        return { fiveWhy: fw.chains, fishbone: fb.branches, fmeaHighRisk: fmea.highRisk };
      });

      // Step 3: 交叉印证（三视角根因重合度判定）
      const step3 = await step<{
        convergence: string[];
        overlapCount: number;
        primaryDomain: string;
      }>("交叉印证（三视角根因重合度判定）", async (ctx) => {
        await narrate(ctx, "正在交叉印证三视角根因…");

        const fiveWhyDomains = new Set(step2.fiveWhy.map((c) => normalizeDomain(c.rootCause)));

        const branchCounts = step2.fishbone.map((b) => ({
          domain: normalizeDomain(b.dimension),
          count: b.factors.length,
        }));
        const topBranch = branchCounts.sort((a, b) => b.count - a.count)[0];
        const fishboneDomain = topBranch && topBranch.count > 0 ? topBranch.domain : "none";

        const fmeaDomain = step2.fmeaHighRisk.length > 0 ? "method" : "none";

        const convergence: string[] = [];
        if (fiveWhyDomains.has(fishboneDomain)) convergence.push("5Why+鱼骨图");
        if (fishboneDomain === fmeaDomain && fishboneDomain !== "none") convergence.push("鱼骨图+FMEA");
        if (fiveWhyDomains.has(fmeaDomain) && fmeaDomain !== "none") convergence.push("5Why+FMEA");

        const overlapCount = convergence.length;
        const primaryDomain = fishboneDomain;

        await narrate(
          ctx,
          `5Why 收敛域：[${[...fiveWhyDomains].join(", ")}]；鱼骨图主域：${fishboneDomain}；FMEA 域：${fmeaDomain}。重合：${overlapCount}/3。`,
        );
        return { convergence, overlapCount, primaryDomain };
      });

      // Step 4: 收敛根因 + 置信度
      const step4 = await step<{
        rootCause: string;
        confidence: number;
        recommendedNext: string;
      }>("收敛根因 + 置信度", async (ctx) => {
        await narrate(ctx, "正在汇总多视角结论…");
        const root5why = step2.fiveWhy[0]?.rootCause ?? "（5Why 无收敛链，normal 场景）";
        const confidence = step3.overlapCount >= 2 ? 0.9 : step3.overlapCount === 1 ? 0.7 : 0.5;
        const recommendedNext =
          confidence >= 0.9
            ? `三视角重合于 ${step3.primaryDomain} 域，建议直接针对 ${root5why} 立项改善`
            : confidence >= 0.7
              ? "两视角重合，建议补充现场观察后立项"
              : "三视角未重合，需现场复核或多源取证后再下结论";
        const rootCause =
          step3.overlapCount >= 2
            ? `多视角重合根因（${step3.convergence.join("+")}）：${root5why}`
            : `主要根因：${root5why}（重合度 ${step3.overlapCount}/3，置信度偏低）`;
        await narrate(
          ctx,
          `根因：${rootCause}。置信度 ${(confidence * 100).toFixed(0)}%（${step3.overlapCount >= 2 ? "高" : step3.overlapCount === 1 ? "中" : "低"}）。`,
        );
        return { rootCause, confidence, recommendedNext };
      });

      // Step 5: 封装 EvidenceEnvelope
      const reasoningChain = [
        {
          step: 1,
          action: "锁定问题表象",
          tool: "oee.realtime + quality.defect_rate + quality.five_why",
          finding: `表象：${step1.symptom}（OEE=${(step1.oee.oee * 100).toFixed(1)}%，缺陷率=${(step1.defectRate * 100).toFixed(1)}%）`,
          inference: "问题表象已锁定，进入多视角取证",
        },
        {
          step: 2,
          action: "三视角并行取证（5Why + 鱼骨图 + FMEA）",
          tool: "quality.five_why + quality.fishbone + process.fmea",
          finding: `5Why 链 ${step2.fiveWhy.length} 条，鱼骨图 ${step2.fishbone.filter((b) => b.factors.length > 0).length}/6 维度有证据，FMEA 高风险 ${step2.fmeaHighRisk.length} 项`,
          inference: "三视角证据已采集，进入交叉印证",
        },
        {
          step: 3,
          action: "交叉印证（三视角根因重合度判定）",
          tool: "normalizeDomain 重合度计算",
          finding: `5Why 域 ∩ 鱼骨图域 ∩ FMEA 域，重合 ${step3.overlapCount}/3，主域=${step3.primaryDomain}`,
          inference: step3.overlapCount >= 2 ? "三视角高度重合，根因置信度高" : step3.overlapCount === 1 ? "部分重合，置信度中" : "未重合，置信度低",
        },
        {
          step: 4,
          action: "收敛根因 + 置信度",
          tool: "重合度→置信度映射",
          finding: step4.rootCause,
          inference: `置信度 ${(step4.confidence * 100).toFixed(0)}%，建议：${step4.recommendedNext}`,
        },
      ];
      const ruledOut: string[] = [];
      const allDomains = ["man", "machine", "material", "method", "environment", "measurement"];
      const involvedDomains = new Set([
        ...step2.fiveWhy.map((c) => normalizeDomain(c.rootCause)),
        ...step2.fishbone.filter((b) => b.factors.length > 0).map((b) => normalizeDomain(b.dimension)),
      ]);
      allDomains.forEach((d) => {
        if (!involvedDomains.has(d) && d !== step3.primaryDomain) {
          ruledOut.push(`${d} 域（三视角均无证据指向）`);
        }
      });

      const step5 = await step<EvidenceEnvelope>(
        "封装多视角分析 EvidenceEnvelope",
        async (ctx) => {
          await narrate(ctx, "正在封装多视角分析结论…");
          const diagnosis = `${line} 多视角根因：${step4.rootCause}（重合 ${step3.overlapCount}/3）`;
          return wrapEvidence(
            {
              scenarioId,
              line,
              symptom: step1.symptom,
              diagnosis,
              rootCause: step4.rootCause,
              confidence: step4.confidence,
              reasoningChain,
              ruledOut,
              convergence: step3.convergence,
              overlapCount: step3.overlapCount,
              primaryDomain: step3.primaryDomain,
              recommendedNext: step4.recommendedNext,
              perspectives: {
                fiveWhy: step2.fiveWhy,
                fishbone: step2.fishbone,
                fmeaHighRisk: step2.fmeaHighRisk,
              },
              stepsExecuted: 5,
              dataSource: "ctx.call: oee.realtime + quality.* + process.fmea",
            },
            {
              freshness: "realtime",
              confidence: step4.confidence > 0.7 ? "measured" : "estimated",
              system: "MES",
              provenance: "skill.multi_perspective_rca",
              caveat: "多视角交叉印证结论，仍需现场工程师复核",
            },
          );
        },
      );

      await skillSummary(
        `推理完成（${reasoningChain.length} 步）：${reasoningChain.map((s) => s.inference).join(" → ")}。\n` +
        `结论：${step4.rootCause}（置信度 ${(step4.confidence * 100).toFixed(0)}%，重合 ${step3.overlapCount}/3）。\n` +
        `详见 [完整诊断](#artifact:${selfCallId})。`,
      );

      return step5;
    },
  });
}
