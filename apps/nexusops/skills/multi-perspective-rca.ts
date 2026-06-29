/**
 * skill.multi_perspective_rca：多视角根因分析流（应用层 —— L 内容）。
 *
 * 对同一问题并行用 5Why + 鱼骨图 + FMEA 三种方法分析，再交叉印证收敛根因。
 * 解决"单一方法论易漏判"问题：5Why 擅长纵向深挖、鱼骨图擅长横向铺开、
 * FMEA 擅长风险量化，三者交叉印证才提高根因置信度。
 *
 * 步骤序列：
 *   1. 锁定问题表象（读 oee 损失分解 + 质量缺陷）
 *   2. 三视角并行取证（5Why + 鱼骨图 + FMEA）
 *   3. 交叉印证（三视角根因重合度判定）
 *   4. 收敛根因 + 置信度（重合度高=高置信）
 *   5. 封装 EvidenceEnvelope
 */
import { createSkill } from "../../../src/agent/skill-bridge.js";
import {
  getOEE,
  getQuality,
  getCausalChain,
  getProcessFmea,
  ctxFromArgs,
  type ScenarioContext,
} from "../tools/mock-data/scenarios.js";
import { wrapEvidence } from "../../../src/core/evidence-envelope.js";
import { narrate, narrateSummary } from "../../../src/core/narrate.js";

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
      "多视角根因分析流：对同一问题并行用 5Why + 鱼骨图 + FMEA 三种方法分析，再交叉印证收敛根因。封装'多方法论交叉验证'最佳实践，避免单点归因。",
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
      const { step, narrate: skillNarrate, narrateSummary: skillSummary } = input;
      const scenarioId = typeof input.scenarioId === "string" ? input.scenarioId : "anomaly";
      const line = typeof input.line === "string" ? input.line : undefined;
      const sctx: ScenarioContext = ctxFromArgs({ scenarioId, line });

      await skillNarrate(
        `我开始多视角根因分析（场景：${scenarioId}${line ? `，产线 ${line}` : ""}）。`,
      );

      // Step 1: 锁定问题表象
      const step1 = await step<{
        symptom: string;
        oee: ReturnType<typeof getOEE>;
        quality: ReturnType<typeof getQuality>;
      }>("锁定问题表象", async (ctx) => {
        await narrate(ctx, "正在取 OEE 损失分解 + 质量缺陷，锁定问题表象…");
        const oee = getOEE(sctx);
        const q = getQuality(sctx);
        const cc = getCausalChain(sctx);
        const symptom =
          cc.symptom && cc.chains.length > 0
            ? cc.symptom
            : `OEE=${(oee.oee * 100).toFixed(1)}%，缺陷率=${(q.defectRate * 100).toFixed(1)}%`;
        await narrate(
          ctx,
          `问题表象：${symptom}（OEE 三要素：可用 ${(oee.availability * 100).toFixed(0)}% / 性能 ${(oee.performance * 100).toFixed(0)}% / 质量 ${(oee.quality * 100).toFixed(0)}%）。`,
        );
        return { symptom, oee, quality: q };
      });

      // Step 2: 三视角并行取证
      const step2 = await step<{
        fiveWhy: ReturnType<typeof getCausalChain>["chains"];
        fishbone: ReturnType<typeof getCausalChain>["fishbone"];
        fmea: ReturnType<typeof getProcessFmea>;
      }>("三视角并行取证（5Why + 鱼骨图 + FMEA）", async (ctx) => {
        await narrate(ctx, "正在并行调取 5Why 链 / 鱼骨图 5M1E / FMEA 失效模式…");
        const cc = getCausalChain(sctx);
        const fmea = getProcessFmea(sctx);
        await narrate(
          ctx,
          `5Why 链 ${cc.chains.length} 条，鱼骨图 ${Object.values(cc.fishbone).filter((a) => a.length > 0).length}/6 维度有证据，FMEA 高风险项 ${fmea.highRisk.length} 个。`,
        );
        return { fiveWhy: cc.chains, fishbone: cc.fishbone, fmea };
      });

      // Step 3: 交叉印证（三视角根因重合度判定）
      const step3 = await step<{
        convergence: string[];
        overlapCount: number;
        primaryDomain: string;
      }>("交叉印证（三视角根因重合度判定）", async (ctx) => {
        await narrate(ctx, "正在交叉印证三视角根因…");

        // 5Why 收敛的根因域
        const fiveWhyDomains = new Set(
          step2.fiveWhy.map((c) => normalizeDomain(c.rootCause)),
        );

        // 鱼骨图证据最多的维度
        const branchCounts = Object.entries(step2.fishbone).map(([dim, factors]) => ({
          domain: normalizeDomain(dim),
          count: factors.length,
        }));
        const topBranch = branchCounts.sort((a, b) => b.count - a.count)[0];
        const fishboneDomain = topBranch && topBranch.count > 0 ? topBranch.domain : "none";

        // FMEA 高风险项的参数域（温度/压力/速度 → method 域）
        const fmeaDomain = step2.fmea.highRisk.length > 0 ? "method" : "none";

        const convergence: string[] = [];
        if (fiveWhyDomains.has(fishboneDomain)) convergence.push("5Why+鱼骨图");
        if (fishboneDomain === fmeaDomain && fishboneDomain !== "none") convergence.push("鱼骨图+FMEA");
        if (fiveWhyDomains.has(fmeaDomain) && fmeaDomain !== "none") convergence.push("5Why+FMEA");

        const overlapCount = convergence.length;
        const allThree =
          fiveWhyDomains.has(fishboneDomain) && fishboneDomain === fmeaDomain && fishboneDomain !== "none";
        const primaryDomain = allThree ? fishboneDomain : fishboneDomain;

        await narrate(
          ctx,
          `5Why 收敛域：[${[...fiveWhyDomains].join(", ")}]；鱼骨图主域：${fishboneDomain}；FMEA 域：${fmeaDomain}。重合：${overlapCount}/3${allThree ? "（三视角全重合）" : ""}。`,
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
        const confidence =
          step3.overlapCount >= 2
            ? 0.9
            : step3.overlapCount === 1
              ? 0.7
              : 0.5;
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
      const step5 = await step<ReturnType<typeof wrapEvidence>>(
        "封装多视角分析 EvidenceEnvelope",
        async (ctx) => {
          await narrate(ctx, "正在封装多视角分析结论…");
          return wrapEvidence(
            {
              scenarioId: sctx.scenarioId,
              line: sctx.line ?? "L01",
              symptom: step1.symptom,
              rootCause: step4.rootCause,
              confidence: step4.confidence,
              convergence: step3.convergence,
              overlapCount: step3.overlapCount,
              primaryDomain: step3.primaryDomain,
              recommendedNext: step4.recommendedNext,
              perspectives: {
                fiveWhy: step2.fiveWhy,
                fishbone: step2.fishbone,
                fmeaHighRisk: step2.fmea.highRisk,
              },
              stepsExecuted: 5,
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
        `多视角分析完成：${step4.rootCause}（置信度 ${(step4.confidence * 100).toFixed(0)}%，重合 ${step3.overlapCount}/3）。`,
      );

      return step5;
    },
  });
}
