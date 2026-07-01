import type { ExtensionEvent } from "@meso.ai/types";
import { STREAMING_SYMBOLS } from "@let-it-flow/common-ui";
import { ConfirmGateCard, type ConfirmGateData } from "./ConfirmGateCard.js";
import { ClarifyCard, type ClarifyData } from "./ClarifyCard.js";
import { RecommendationCard, type RecommendationData } from "./RecommendationCard.js";

/**
 * 创建 renderExtension 回调（传给 MessageList.renderExtension）。
 *
 * 处理 NexusOps 链路的 extension：
 *  - confirm_gate：HITL 确认门（write/destructive 工具执行前）
 *  - clarification_required：Guardrail 意图模糊，要求用户补充
 *  - rejected：Guardrail 判定越界，展示拒绝原因
 *  - nexus_recommendations：nexus_advise 产出的结构化建议卡
 *  - precondition_unmet：前置条件未满足（证据不足）
 *  - react_result：ReAct 收尾摘要
 */
export interface RenderExtensionHandlers {
  onConfirm: (decision: "approve" | "reject") => void;
  onClarify: (message: string) => void;
}

export function createRenderExtension(handlers: RenderExtensionHandlers) {
  return (event: ExtensionEvent) => {
    const { name, data } = event.payload;
    const d = (data ?? {}) as Record<string, unknown>;

    if (name === "confirm_gate") {
      return (
        <ConfirmGateCard
          data={d as unknown as ConfirmGateData}
          onApprove={() => handlers.onConfirm("approve")}
          onReject={() => handlers.onConfirm("reject")}
        />
      );
    }

    if (name === "clarification_required") {
      return <ClarifyCard data={d as unknown as ClarifyData} onSubmit={handlers.onClarify} />;
    }

    if (name === "rejected") {
      const reason = typeof d.reason === "string" ? d.reason : "意图越界";
      const suggestRetry = d.suggest_retry === true;
      return (
        <div
          style={{
            margin: "8px 0",
            padding: 16,
            borderRadius: 10,
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-error)",
          }}
        >
          <div style={{ color: "var(--color-error)", fontWeight: 600, marginBottom: 4 }}>
            ✗ 请求被拒绝
          </div>
          <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>{reason}</div>
          {suggestRetry && (
            <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 8 }}>
              建议调整意图后重试
            </div>
          )}
        </div>
      );
    }

    if (name === "nexus_recommendations") {
      return <RecommendationCard data={d as unknown as RecommendationData} />;
    }

    if (name === "precondition_unmet") {
      const finalText = typeof d.finalText === "string" ? d.finalText : "";
      return (
        <div
          style={{
            margin: "8px 0",
            padding: 16,
            borderRadius: 10,
            background: "var(--color-bg-elevated)",
            border: "1px solid var(--color-warning)",
          }}
        >
          <div style={{ color: "var(--color-warning)", fontWeight: 600, marginBottom: 4 }}>
            ⚠ 证据不足，前置条件未满足
          </div>
          <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>
            {finalText || "分析所需的取证数据未齐备，请补充相关信息后重试。"}
          </div>
        </div>
      );
    }

    if (name === "react_result") {
      // react_result 信息已在 ProcessTrace + ExecutionDetails 中完整展示，此处略去避免重复
      // 如果需要显示额外的元信息，可在此添加
      return null;
    }

    return null;
  };
}
