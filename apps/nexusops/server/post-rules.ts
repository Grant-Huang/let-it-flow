/**
 * NexusOps postToolUse 一致性校验规则（G 层内容 —— 应用声明，平台 PostToolUseChain 执行）。
 *
 * 过程侧可信度校验：工具返回后、结果返回 LLM 前，检测：
 *   - inferred 兜底：confidence=inferred 的证据若在本次会话被连续两次以上引用，
 *     注入 warn 提示交叉验证（inferred 是最弱证据，反复用而不交叉验证=硬结论风险）。
 *   - 证据冲突标记：低置信度证据（strength < 0.5）出现时注入 warn，提醒 LLM 降权。
 *
 * 与 preToolUse 的区别：preToolUse 拿不到结果只能按入参阻断；postToolUse 能看到
 * EvidenceEnvelope，做"结果侧"的可信度把关。
 *
 * 注意：postToolUse 的 check 签名只收单次工具结果（无 trace），故"连续引用计数"
 * 用本 chain 内部的会话级计数器维护（每条 chain 对应一个 ReAct run）。
 */
import { PostToolUseChain } from "../../../src/agent/governance.js";
import type { PostToolUseRule } from "../../../src/agent/governance.js";
import {
  isEvidenceEnvelope,
  evidenceStrength,
  type EvidenceEnvelope,
} from "../../../src/core/evidence-envelope.js";

/** 低证据强度阈值（< 此值注入 warn 提醒降权）。 */
const LOW_STRENGTH_THRESHOLD = 0.5;

/** inferred 证据连续引用次数阈值（>= 此值注入 warn）。 */
const INFERRED_REPEAT_THRESHOLD = 2;

/**
 * 构造 NexusOps 的 postToolUse 一致性校验链。
 *
 * 每条 chain 维护自己的会话级状态（inferred 引用计数），
 * 故应在每个 ReAct run 开始时新建一条 chain（而非全局单例）。
 */
export function buildNexusPostToolUseChain(): PostToolUseChain {
  const chain = new PostToolUseChain();

  // 会话级状态：inferred 证据按 source.provenance 计数
  const inferredCounts = new Map<string, number>();

  // 规则 1：inferred 兜底——同来源 inferred 证据被反复引用（>=2 次）需交叉验证
  chain.add({
    id: "warn_inferred_repeat",
    description: `confidence=inferred 的证据被连续引用 >=${INFERRED_REPEAT_THRESHOLD} 次时，提醒交叉验证`,
    check: (_toolName, _args, result) => {
      if (!isEvidenceEnvelope(result)) return { pass: true };
      const env = result as EvidenceEnvelope;
      if (env.confidence !== "inferred") return { pass: true };
      const key = env.source?.provenance ?? "unknown";
      const count = (inferredCounts.get(key) ?? 0) + 1;
      inferredCounts.set(key, count);
      if (count >= INFERRED_REPEAT_THRESHOLD) {
        return {
          pass: false,
          severity: "warn" as const,
          reason: `inferred 证据（${key}）已被引用 ${count} 次而未交叉验证，请用 measured/estimated 数据复核后再下结论`,
        };
      }
      return { pass: true };
    },
  } satisfies PostToolUseRule);

  // 规则 2：低证据强度标记——strength < 0.5 的证据出现时提醒降权
  chain.add({
    id: "warn_low_evidence_strength",
    description: `证据强度 < ${LOW_STRENGTH_THRESHOLD} 时提醒 LLM 降权（freshness×confidence 综合判断）`,
    check: (_toolName, _args, result) => {
      if (!isEvidenceEnvelope(result)) return { pass: true };
      const env = result as EvidenceEnvelope;
      const strength = evidenceStrength(env);
      if (strength < LOW_STRENGTH_THRESHOLD) {
        return {
          pass: false,
          severity: "warn" as const,
          reason: `本条证据强度较低（strength=${strength.toFixed(2)}, freshness=${env.freshness}, confidence=${env.confidence}），下结论前需更强证据支撑`,
        };
      }
      return { pass: true };
    },
  } satisfies PostToolUseRule);

  return chain;
}
