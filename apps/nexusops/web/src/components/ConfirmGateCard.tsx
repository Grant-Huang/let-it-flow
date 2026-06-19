import { useState } from "react";

/**
 * confirm_gate 确认门卡片。
 *
 * ReAct harness 的 write/destructive 工具执行前通过 extension(confirm_gate) 暂停，
 * 等待用户 POST /confirm（approve/reject/modify）。
 */
export interface ConfirmGateData {
  gate_id: string;
  node_id: string;
  run_id: string;
  prompt: string;
  options: string[];
  detail?: Record<string, unknown>;
}

export interface ConfirmGateCardProps {
  data: ConfirmGateData;
  onApprove: () => void;
  onReject: () => void;
}

export function ConfirmGateCard({ data, onApprove, onReject }: ConfirmGateCardProps) {
  const [busy, setBusy] = useState(false);

  const act = (fn: () => void) => () => {
    if (busy) return;
    setBusy(true);
    fn();
  };

  return (
    <div
      style={{
        margin: "8px 0",
        padding: 16,
        borderRadius: 10,
        background: "var(--color-bg-elevated)",
        border: "1px solid var(--color-border)",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ color: "var(--color-warning)" }}>⚠</span>
        {data.prompt}
      </div>

      {data.detail && (
        <div style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: 12 }}>
          <DetailRows detail={data.detail} />
        </div>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <button
          onClick={act(onApprove)}
          disabled={busy}
          style={btnStyle("primary")}
        >
          批准
        </button>
        <button
          onClick={act(onReject)}
          disabled={busy}
          style={btnStyle("danger")}
        >
          拒绝
        </button>
      </div>
    </div>
  );
}

function DetailRows({ detail }: { detail: Record<string, unknown> }) {
  const entries = Object.entries(detail).filter(([, v]) => v != null);
  if (entries.length === 0) return null;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      {entries.map(([k, v]) => (
        <div key={k}>
          <span style={{ color: "var(--color-text-muted)" }}>{k}: </span>
          <span>{Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
        </div>
      ))}
    </div>
  );
}

function btnStyle(kind: "primary" | "danger"): React.CSSProperties {
  const bg = kind === "primary" ? "var(--color-accent)" : "var(--color-error)";
  return {
    padding: "6px 16px",
    borderRadius: 8,
    border: "none",
    background: bg,
    color: "#fff",
    fontSize: 13,
    fontWeight: 500,
    cursor: "pointer",
    opacity: undefined,
  };
}
