import { useState } from "react";

/**
 * clarification_required 澄清卡片。
 *
 * Guardrail 判定意图模糊时，后端发 extension(clarification_required)，
 * 前端渲染输入框让用户补充信息（见 docs/14-podcast-generator-frontend.md §14.5.2）。
 */
export interface ClarifyData {
  questions: Array<{ field: string; prompt: string }>;
}

export interface ClarifyCardProps {
  data: ClarifyData;
  onSubmit: (message: string) => void;
}

export function ClarifyCard({ data, onSubmit }: ClarifyCardProps) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = () => {
    const msg = value.trim();
    if (!msg || busy) return;
    setBusy(true);
    onSubmit(msg);
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
      <div style={{ fontWeight: 600, marginBottom: 8 }}>
        {data.questions.map((q, i) => (
          <div key={i} style={{ marginBottom: 4 }}>
            <span style={{ color: "var(--color-info)" }}>?</span> {q.prompt}
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="补充你的需求..."
          disabled={busy}
          style={{
            flex: 1,
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid var(--color-border)",
            background: "var(--color-bg-white)",
            color: "var(--color-text)",
            fontSize: 13,
          }}
        />
        <button onClick={submit} disabled={busy} style={btnPrimary}>
          补充
        </button>
      </div>
    </div>
  );
}

const btnPrimary: React.CSSProperties = {
  padding: "6px 16px",
  borderRadius: 8,
  border: "none",
  background: "var(--color-accent)",
  color: "#fff",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
};
