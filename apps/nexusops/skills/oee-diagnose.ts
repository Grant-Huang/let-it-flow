/**
 * skill.oee_diagnose：标准 OEE 诊断流（应用层 —— L 内容）。
 *
 * 沉淀自真实 ReAct 轨迹：OEE 低于目标时的系统性 5 步诊断。
 * 主 ReAct 循环可像调普通工具一样调此 skill，一键完成标准诊断取证。
 *
 * 步骤序列：
 *   1. 取实时 OEE + 损失分解
 *   2. 按最大损失项分流（可用/性能/质量）
 *   3. 取对应域的根因证据
 *   4. 交叉验证（5M1E 框架）
 *   5. 汇总成诊断结论
 */
import { createSkill } from "../../../src/agent/skill-bridge.js";
import { getOEE, getEquipment, getQuality, getProcess, ctxFromArgs, type ScenarioContext } from "../tools/mock-data/scenarios.js";
import { wrapEvidence } from "../../../src/core/evidence-envelope.js";
import type { SkillStep } from "../../../src/agent/skill-bridge.js";
import type { ExecutionContext } from "../../../src/tools/base.js";

export function createOeeDiagnoseSkill() {
  const steps: SkillStep[] = [
    {
      description: "取实时 OEE + 损失分解",
      execute: async (_ctx, params, _prior) => {
        const args = params;
        const sctx = ctxFromArgs(args);
        const oee = getOEE(sctx);
        return {
          step: 1,
          oee,
          biggestLoss:
            oee.availability < oee.performance && oee.availability < oee.quality
              ? "availability"
              : oee.performance < oee.quality
                ? "performance"
                : "quality",
        };
      },
    },
    {
      description: "按最大损失项分流取证",
      execute: async (_ctx, params, prior) => {
        const args = params;
        const sctx = ctxFromArgs(args);
        const step1 = prior[0] as { biggestLoss: string };
        const loss = step1.biggestLoss;
        let evidence: Record<string, unknown> = { lossType: loss };
        if (loss === "availability") {
          const eq = getEquipment(sctx);
          evidence = { ...evidence, downtimeEvents: eq.downtimeEvents, mtbfHours: eq.mtbfHours, healthScore: eq.healthScore };
        } else if (loss === "performance") {
          const pr = getProcess(sctx);
          evidence = { ...evidence, deviations: Object.entries(pr.parameters).filter(([, v]) => !(v as { inSpec: boolean }).inSpec), deviationScore: pr.deviationScore };
        } else {
          const q = getQuality(sctx);
          evidence = { ...evidence, topDefects: q.topDefects, cpk: q.cpk, defectRate: q.defectRate };
        }
        return { step: 2, evidence };
      },
    },
    {
      description: "交叉验证（5M1E 视角）",
      execute: async (_ctx, params, prior) => {
        const args = params;
        const sctx = ctxFromArgs(args);
        const step2 = prior[1] as { evidence: Record<string, unknown> };
        // 无论主损失项，都附带设备健康 + 工艺偏差做交叉验证
        const eq = getEquipment(sctx);
        const pr = getProcess(sctx);
        return {
          step: 3,
          crossCheck: {
            equipmentHealth: eq.healthScore,
            processDeviation: pr.deviationScore,
            suspiciousDevice: eq.healthScore < 0.7,
            suspiciousProcess: pr.deviationScore > 0.3,
          },
          primaryEvidence: step2.evidence,
        };
      },
    },
    {
      description: "综合诊断结论",
      execute: async (_ctx, params, prior) => {
        const step3 = prior[2] as { crossCheck: Record<string, unknown>; primaryEvidence: Record<string, unknown> };
        const cc = step3.crossCheck;
        const rootCause =
          cc.suspiciousDevice && cc.suspiciousProcess
            ? "设备健康下降 + 工艺参数漂移（强关联，建议先治设备）"
            : cc.suspiciousDevice
              ? "设备健康下降（振动/温度异常），传导至质量/性能"
              : cc.suspiciousProcess
                ? "工艺参数漂移（温度/压力偏离标准）"
                : "无单一明显根因，需进一步现场排查";
        return {
          step: 4,
          diagnosis: rootCause,
          confidence: cc.suspiciousDevice || cc.suspiciousProcess ? 0.8 : 0.5,
          evidenceChain: step3.primaryEvidence,
        };
      },
    },
    {
      description: "包成诊断 EvidenceEnvelope",
      execute: async (_ctx, params, prior) => {
        const args = params;
        const sctx: ScenarioContext = ctxFromArgs(args);
        const step1 = prior[0] as { oee: { oee: number } };
        const step4 = prior[3] as { diagnosis: string; confidence: number; evidenceChain: Record<string, unknown> };
        return wrapEvidence(
          {
            scenarioId: sctx.scenarioId,
            line: sctx.line ?? "L01",
            currentOEE: step1.oee.oee,
            diagnosis: step4.diagnosis,
            confidence: step4.confidence,
            evidenceChain: step4.evidenceChain,
            stepsExecuted: 5,
          },
          {
            freshness: "realtime",
            confidence: step4.confidence > 0.7 ? "measured" : "estimated",
            system: "MES",
            provenance: "skill.oee_diagnose",
            caveat: "标准化诊断流，结论需现场工程师复核",
          },
        );
      },
    },
  ];

  return createSkill({
    name: "skill.oee_diagnose",
    description:
      "标准 OEE 诊断流：当某产线 OEE 低于目标时，一键完成 5 步诊断（取数→损失分解→根因取证→交叉验证→结论）。封装了已验证的最佳实践诊断轨迹。",
    whenToUse: {
      triggers: [
        "OEE 低需系统性诊断",
        "OEE 为什么低",
        "产线效率下滑的根因",
        "需要标准化 OEE 诊断",
      ],
      notFor: [
        "只看实时 OEE（走 oee.realtime）",
        "已知根因只需执行（直接调对应工具）",
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
      properties: {
        data: { type: "object" },
        confidence: { type: "string" },
      },
    },
    outputExample: {
      data: { diagnosis: "设备健康下降...", confidence: 0.8 },
      confidence: "measured",
    },
    steps,
  });
}

// skill 步骤通过 SkillStep.execute(ctx, params, priorResults) 拿到输入参数

