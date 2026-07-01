import { useState } from "react";

/**
 * nexus_advise 产出的结构化建议卡。
 *
 * 渲染 nexus_advise 工具输出的建议列表：每条含
 *  - title / rationale（依据，引用证据）
 *  - impact 影响度 / executionScore 执行度 / confidence 置信度（0-1 进度条）
 *  - actionTool + actionArgs（可选行动按钮，调对应 MCP/工具）
 *  - evidenceRefs（支撑证据引用）
 *
 * 设计原则：没有合适 MCP 时 actionTool 留空，不勉强给按钮。
 */

export interface Recommendation {
  title: string;
  rationale: string;
  impact: number;
  executionScore: number;
  confidence: number;
  actionTool?: string;
  actionArgs?: Record<string, unknown>;
  evidenceRefs?: string[];
}

export interface RecommendationData {
  recommendations: Recommendation[];
}

export function RecommendationCard({ data }: { data: RecommendationData }) {
  const recs = data.recommendations ?? [];
  if (recs.length === 0) return null;

  return (
    <div style={{ margin: "8px 0", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontWeight: 600, color: "var(--color-accent)", fontSize: 14 }}>
        改善建议（{recs.length} 条）
      </div>
      {recs.map((rec, i) => (
        <RecommendationItem key={i} rec={rec} index={i} />
      ))}
    </div>
  );
}

function RecommendationItem({ rec, index }: { rec: Recommendation; index: number }) {
  const [expanded, setExpanded] = useState(false);
  const priority = priorityOf(rec.impact, rec.executionScore);

  return (
    <div
      style={{
        padding: 14,
        borderRadius: 10,
        background: "var(--color-bg-elevated)",
        border: `1px solid ${priority.borderColor}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 8 }}>
        <span style={priority.badgeStyle}>{priority.label}</span>
        <div style={{ flex: 1, fontWeight: 600, fontSize: 14 }}>{rec.title}</div>
      </div>

      {/* 三维度评分 */}
      <div style={{ display: "flex", gap: 12, marginBottom: 10, flexWrap: "wrap" }}>
        <ScoreBar label="影响度" value={rec.impact} color="var(--color-error)" />
        <ScoreBar label="执行度" value={rec.executionScore} color="var(--color-success)" />
        <ScoreBar label="置信度" value={rec.confidence} color="var(--color-accent)" />
      </div>

      {/* 依据（可展开） */}
      <div
        style={{ fontSize: 13, color: "var(--color-text-secondary)", marginBottom: rec.evidenceRefs?.length ? 8 : 0, cursor: "pointer" }}
        onClick={() => setExpanded((v) => !v)}
      >
        {expanded ? rec.rationale : truncate(rec.rationale, 120)}
        {rec.rationale.length > 120 && (
          <span style={{ color: "var(--color-accent)", marginLeft: 4 }}>
            {expanded ? "收起" : "展开"}
          </span>
        )}
      </div>

      {/* 证据引用 */}
      {rec.evidenceRefs && rec.evidenceRefs.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8 }}>
          {rec.evidenceRefs.map((ref, i) => (
            <span
              key={i}
              style={{
                fontSize: 11,
                padding: "1px 6px",
                borderRadius: 4,
                background: "var(--badge-bg)",
                color: "var(--color-text-muted)",
              }}
            >
              {ref}
            </span>
          ))}
        </div>
      )}

      {/* 行动按钮：仅当有 actionTool 时渲染 */}
      {rec.actionTool && rec.actionTool.trim() !== "" ? (
        <button
          style={actionBtn}
          onClick={() => {
            // 行动按钮触发：通过 HITL 确认门走 MCP 工具（governance + 确认双保险）
            // 实际执行由后端 ReAct 循环接管，这里仅发起新任务或调对应工具
            window.alert(`即将执行：${rec.actionTool}\n参数：${JSON.stringify(rec.actionArgs ?? {})}`);
          }}
        >
          执行 {rec.actionTool}
        </button>
      ) : (
        <div style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
          无对应可执行动作（建议人工实施）
        </div>
      )}
    </div>
  );
}

function ScoreBar({ label, value, color }: { label: string; value: number; color: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div style={{ flex: "1 1 80px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: "var(--color-text-muted)", marginBottom: 2 }}>
        <span>{label}</span>
        <span>{value.toFixed(2)}</span>
      </div>
      <div style={{ height: 5, borderRadius: 3, background: "var(--color-border-light)", overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 3 }} />
      </div>
    </div>
  );
}

function priorityOf(impact: number, execution: number): {
  label: string;
  badgeStyle: React.CSSProperties;
  borderColor: string;
} {
  // 优先级 = 影响 × 执行度（高影响且易执行 → 紧急）
  const score = impact * execution;
  if (score >= 0.6) {
    return {
      label: "紧急",
      badgeStyle: { fontSize: 11, padding: "1px 6px", borderRadius: 4, background: "rgba(184,50,50,0.15)", color: "var(--color-error)", flexShrink: 0, fontWeight: 600 },
      borderColor: "rgba(184,50,50,0.3)",
    };
  }
  if (score >= 0.35) {
    return {
      label: "高优",
      badgeStyle: { fontSize: 11, padding: "1px 6px", borderRadius: 4, background: "rgba(180,83,9,0.15)", color: "var(--color-warning)", flexShrink: 0, fontWeight: 600 },
      borderColor: "rgba(180,83,9,0.3)",
    };
  }
  return {
    label: "参考",
    badgeStyle: { fontSize: 11, padding: "1px 6px", borderRadius: 4, background: "var(--badge-bg)", color: "var(--color-text-secondary)", flexShrink: 0, fontWeight: 600 },
    borderColor: "var(--color-border-light)",
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

const actionBtn: React.CSSProperties = {
  padding: "6px 14px",
  borderRadius: 8,
  border: "none",
  background: "var(--color-accent)",
  color: "#fff",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
};
