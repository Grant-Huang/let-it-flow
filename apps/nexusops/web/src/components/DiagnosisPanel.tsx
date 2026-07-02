import type { NexusArtifact, ReasoningStep } from "../lib/artifacts.js";

/**
 * 诊断面板：步骤化展示 skill 的推理链（取数→分流→交叉验证→结论）。
 *
 * 结构：
 *  ┌─────────────────────────────────────┐
 *  │ 诊断结论（顶部，醒目）+ 置信度条      │
 *  │ 推理链（纵向时间线，每步 finding/inference）│
 *  │ 排除的备选解释（灰化，体现"考虑过但排除"） │
 *  └─────────────────────────────────────┘
 */
export function DiagnosisPanel({ artifact }: { artifact: NexusArtifact }) {
  const { content, reasoningChain, ruledOut, confidence, title } = artifact;
  // content 形如 "<diagnosis>\n\n置信度：0.85"，取首段作 diagnosis 文本
  const diagnosisText = content.split("\n\n")[0] ?? content;
  const steps = reasoningChain ?? [];
  const confPct = typeof confidence === "number" ? Math.round(confidence * 100) : null;

  return (
    <div style={{ padding: 16, overflowY: "auto", height: "100%", fontSize: 13, color: "var(--color-text)" }}>
      {/* 诊断结论 */}
      <div
        style={{
          background: "var(--color-surface-raised, #1e293b)",
          border: "1px solid var(--color-border, #334155)",
          borderRadius: 10,
          padding: 14,
          marginBottom: 16,
        }}
      >
        <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.05em" }}>
          {title}
        </div>
        <div style={{ fontSize: 15, fontWeight: 600, lineHeight: 1.5, color: "var(--color-text-strong, #f1f5f9)" }}>
          {diagnosisText}
        </div>
        {confPct !== null && (
          <div style={{ marginTop: 10 }}>
            <ConfidenceBar pct={confPct} />
          </div>
        )}
      </div>

      {/* 推理链 */}
      {steps.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--color-text-muted)",
              marginBottom: 12,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            推理链（{steps.length} 步）
          </div>
          <div style={{ position: "relative", paddingLeft: 8 }}>
            {steps.map((s, i) => (
              <ReasoningStepView key={s.step ?? i} step={s} isLast={i === steps.length - 1} />
            ))}
          </div>
        </div>
      )}

      {/* 排除的备选 */}
      {ruledOut && ruledOut.length > 0 && (
        <div>
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: "var(--color-text-muted)",
              marginBottom: 8,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            排除的备选解释
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {ruledOut.map((r, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: 8,
                  alignItems: "flex-start",
                  fontSize: 12,
                  color: "var(--color-text-muted)",
                  opacity: 0.75,
                }}
              >
                <span style={{ color: "#64748b", flexShrink: 0 }}>✗</span>
                <span style={{ textDecoration: "line-through", textDecorationColor: "rgba(148,163,184,0.4)" }}>
                  {r}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ReasoningStepView({ step, isLast }: { step: ReasoningStep; isLast: boolean }) {
  return (
    <div style={{ position: "relative", paddingBottom: isLast ? 0 : 16, paddingLeft: 18 }}>
      {/* 竖向连线 */}
      {!isLast && (
        <div
          style={{
            position: "absolute",
            left: 5,
            top: 16,
            bottom: 0,
            width: 2,
            background: "var(--color-border, #334155)",
          }}
        />
      )}
      {/* 节点圆点 */}
      <div
        style={{
          position: "absolute",
          left: 0,
          top: 4,
          width: 12,
          height: 12,
          borderRadius: "50%",
          background: "var(--color-accent, #3b82f6)",
          border: "2px solid var(--color-surface, #0f172a)",
        }}
      />
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--color-text-strong, #f1f5f9)", marginBottom: 2 }}>
        Step {step.step} · {step.action}
      </div>
      <div style={{ fontSize: 11, color: "var(--color-text-muted)", marginBottom: 6 }}>
        工具：<code style={{ background: "var(--color-surface, #0f172a)", padding: "1px 5px", borderRadius: 4 }}>{step.tool}</code>
      </div>
      <div
        style={{
          fontSize: 12,
          color: "var(--color-text, #cbd5e1)",
          borderLeft: "2px solid var(--color-border, #334155)",
          paddingLeft: 8,
          marginBottom: 4,
          lineHeight: 1.5,
        }}
      >
        <span style={{ color: "var(--color-text-muted)", fontSize: 10, textTransform: "uppercase" }}>发现：</span>
        {step.finding}
      </div>
      <div style={{ fontSize: 12, color: "var(--color-text-muted)", lineHeight: 1.5 }}>
        <span style={{ color: "#3b82f6" }}>→ 推断：</span>
        {step.inference}
      </div>
    </div>
  );
}

function ConfidenceBar({ pct }: { pct: number }) {
  const color = pct >= 75 ? "#22c55e" : pct >= 50 ? "#f59e0b" : "#ef4444";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 11, color: "var(--color-text-muted)", width: 56 }}>置信度</span>
      <div style={{ flex: 1, height: 6, background: "var(--color-surface, #0f172a)", borderRadius: 3, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 11, color: "var(--color-text-muted)", width: 36, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
        {pct}%
      </span>
    </div>
  );
}
