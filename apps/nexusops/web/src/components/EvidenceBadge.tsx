/**
 * EvidenceEnvelope 证据徽章（渲染 freshness + confidence + source）。
 *
 * ReAct 工具返回的 EvidenceEnvelope 携带时效/置信度/来源元信息，
 * 本组件把它们渲染成紧凑徽章，让用户一眼判断证据可信度。
 */

export type Freshness = "realtime" | "shift" | "daily" | "weekly" | "historical";
export type Confidence = "measured" | "estimated" | "inferred";

export interface EvidenceBadgeData {
  freshness?: Freshness;
  confidence?: Confidence;
  source?: { system?: string; provenance?: string };
  caveat?: string;
}

export function EvidenceBadge({ data }: { data: EvidenceBadgeData }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center" }}>
      {data.freshness && (
        <span className="nexus-badge" style={freshnessStyle(data.freshness)}>
          {freshnessLabel(data.freshness)}
        </span>
      )}
      {data.confidence && (
        <span className="nexus-badge" style={confidenceStyle(data.confidence)}>
          {confidenceLabel(data.confidence)}
        </span>
      )}
      {data.source?.system && (
        <span className="nexus-badge" style={sourceStyle}>
          {data.source.system}
        </span>
      )}
      {data.caveat && (
        <span className="nexus-badge" style={caveatStyle} title={data.caveat}>
          ⚠ {data.caveat}
        </span>
      )}
    </div>
  );
}

/** 从工具结果（tool_result 的 output JSON 字符串）解析 EvidenceEnvelope 元信息。 */
export function parseEvidenceFromOutput(output: string | undefined): EvidenceBadgeData | null {
  if (!output) return null;
  try {
    const obj = JSON.parse(output) as Record<string, unknown>;
    if (typeof obj !== "object" || obj === null) return null;
    if (!("freshness" in obj) && !("confidence" in obj)) return null;
    return {
      freshness: obj.freshness as Freshness | undefined,
      confidence: obj.confidence as Confidence | undefined,
      source: obj.source as { system?: string; provenance?: string } | undefined,
      caveat: typeof obj.caveat === "string" ? obj.caveat : undefined,
    };
  } catch {
    return null;
  }
}

function freshnessLabel(f: Freshness): string {
  const map: Record<Freshness, string> = {
    realtime: "实时",
    shift: "本班次",
    daily: "当日",
    weekly: "本周",
    historical: "历史",
  };
  return map[f] ?? f;
}

function freshnessStyle(f: Freshness): React.CSSProperties {
  // 实时→绿（可信），历史→灰（需谨慎）
  const bg: Record<Freshness, string> = {
    realtime: "rgba(42,122,79,0.15)",
    shift: "rgba(61,107,82,0.15)",
    daily: "rgba(59,130,246,0.15)",
    weekly: "rgba(180,83,9,0.15)",
    historical: "rgba(107,114,128,0.15)",
  };
  const fg: Record<Freshness, string> = {
    realtime: "var(--color-success)",
    shift: "var(--color-success)",
    daily: "var(--color-info)",
    weekly: "var(--color-warning)",
    historical: "var(--color-text-secondary)",
  };
  return { background: bg[f], color: fg[f] };
}

function confidenceIcon(c: Confidence): string {
  return c === "measured" ? "✓" : c === "estimated" ? "≈" : "?";
}

function confidenceLabel(c: Confidence): string {
  const map: Record<Confidence, string> = {
    measured: "实测",
    estimated: "估算",
    inferred: "推断",
  };
  return map[c] ?? c;
}

function confidenceStyle(c: Confidence): React.CSSProperties {
  const bg: Record<Confidence, string> = {
    measured: "rgba(42,122,79,0.15)",
    estimated: "rgba(180,83,9,0.15)",
    inferred: "rgba(139,92,246,0.15)",
  };
  const fg: Record<Confidence, string> = {
    measured: "var(--color-success)",
    estimated: "var(--color-warning)",
    inferred: "#8b5cf6",
  };
  return { background: bg[c], color: fg[c] };
}

const sourceStyle: React.CSSProperties = {
  background: "var(--badge-bg)",
  color: "var(--color-text-secondary)",
};

const caveatStyle: React.CSSProperties = {
  background: "rgba(184,50,50,0.15)",
  color: "var(--color-error)",
};
