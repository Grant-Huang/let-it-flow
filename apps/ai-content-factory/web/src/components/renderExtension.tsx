import type { ExtensionEvent } from "@meso.ai/types";
import { ConfirmGateCard, type ConfirmGateData } from "./ConfirmGateCard.js";
import { ClarifyCard, type ClarifyData } from "./ClarifyCard.js";

/**
 * 创建 renderExtension 回调（传给 MessageList.renderExtension）。
 *
 * 处理 podcast 链路的 extension（见 docs/14-podcast-generator-frontend.md §14.5）：
 *  - confirm_gate：节点确认门（fetch/rewrite 执行前确认）
 *  - clarification_required：Guardrail 意图模糊，要求用户补充
 *  - rejected：Guardrail 判定越界，展示拒绝原因
 *  - react_result：ReAct 收尾摘要（return null，避免噪音；与 nexusops 对齐）
 *
 * 风格规范见 docs/24-conversational-streaming-style.md §3.5（符号统一用 ✗ U+2717）。
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

    if (name === "react_result") {
      return null;
    }

    return null;
  };
}
