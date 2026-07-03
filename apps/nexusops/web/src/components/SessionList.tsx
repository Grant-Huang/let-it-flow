import { useEffect, useState, useCallback } from "react";
import { listConversations, type ConversationSummary } from "../lib/api.js";

/**
 * 会话历史列表（会话维度）。
 *
 * 从 GET /api/conversations 拉取会话列表（同 conversationId 的多轮 task 聚合为一条），
 * 每条显示会话标题（首轮 intent）、轮次数、最近状态、最近活跃时间。
 * 点击某条调用 onSelect(conversationId)，由父组件拉取该会话全部 task 事件重放。
 */
export interface SessionListProps {
  /** 当前激活会话 id（高亮用）。 */
  activeConversationId?: string | null;
  onSelect: (conversationId: string) => void;
  onNewSession?: () => void;
}

export function SessionList({
  activeConversationId,
  onSelect,
  onNewSession,
}: SessionListProps) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await listConversations();
      setConversations(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loading) {
    return <div style={muted}>加载中…</div>;
  }

  if (error) {
    return (
      <div style={{ ...muted, color: "var(--color-error)" }}>
        加载失败：{error}
        <button onClick={() => void refresh()} style={retryBtn}>重试</button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {onNewSession && (
        <button onClick={onNewSession} style={newBtn}>+ 新建会话</button>
      )}
      <div style={{ flex: 1, overflow: "auto" }}>
        {conversations.length === 0 ? (
          <div style={muted}>暂无历史会话</div>
        ) : (
          conversations.map((c) => (
            <ConversationItem
              key={c.conversationId}
              conversation={c}
              active={c.conversationId === activeConversationId}
              onClick={() => onSelect(c.conversationId)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ConversationItem({
  conversation,
  active,
  onClick,
}: {
  conversation: ConversationSummary;
  active: boolean;
  onClick: () => void;
}) {
  const title =
    conversation.title.length > 40
      ? `${conversation.title.slice(0, 40)}…`
      : conversation.title;
  return (
    <button onClick={onClick} style={itemStyle(active)}>
      <div
        style={{
          fontSize: 13,
          fontWeight: 500,
          marginBottom: 4,
          textAlign: "left",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {title}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <StatusBadge status={conversation.lastStatus} />
          {conversation.taskCount > 1 && (
            <span style={roundCountBadge}>{conversation.taskCount} 轮</span>
          )}
        </div>
        <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
          {formatTime(conversation.lastActiveAt)}
        </span>
      </div>
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color = badgeColor(status);
  return (
    <span
      style={{
        fontSize: 11,
        padding: "1px 6px",
        borderRadius: 4,
        background: color.bg,
        color: color.fg,
      }}
    >
      {statusLabel(status)}
    </span>
  );
}

function badgeColor(status: string): { bg: string; fg: string } {
  switch (status) {
    case "done":
      return { bg: "rgba(42,122,79,0.15)", fg: "var(--color-success)" };
    case "error":
    case "failed":
      return { bg: "rgba(184,50,50,0.15)", fg: "var(--color-error)" };
    case "running":
    case "pending":
      return { bg: "rgba(61,107,82,0.15)", fg: "var(--color-info)" };
    case "pending_confirmation":
    case "pending_clarification":
      return { bg: "rgba(180,83,9,0.15)", fg: "var(--color-warning)" };
    default:
      return { bg: "var(--badge-bg)", fg: "var(--color-text-secondary)" };
  }
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    pending: "等待",
    running: "运行中",
    pending_confirmation: "待确认",
    pending_clarification: "待澄清",
    done: "完成",
    error: "错误",
    aborted: "已中止",
    failed: "已拒绝",
  };
  return map[status] ?? status;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}

const muted: React.CSSProperties = {
  padding: 16,
  color: "var(--color-text-muted)",
  fontSize: 13,
};

const newBtn: React.CSSProperties = {
  margin: "8px 12px",
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid var(--color-border)",
  background: "transparent",
  color: "var(--color-accent)",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
  textAlign: "center",
};

const roundCountBadge: React.CSSProperties = {
  fontSize: 10,
  padding: "1px 5px",
  borderRadius: 4,
  background: "var(--badge-bg)",
  color: "var(--color-text-secondary)",
};

function itemStyle(active: boolean): React.CSSProperties {
  return {
    display: "block",
    width: "100%",
    padding: "10px 14px",
    border: "none",
    borderBottom: "1px solid var(--color-border-light)",
    background: active ? "var(--session-active-bg)" : "transparent",
    cursor: "pointer",
  };
}

const retryBtn: React.CSSProperties = {
  marginLeft: 8,
  padding: "2px 8px",
  borderRadius: 4,
  border: "1px solid var(--color-border)",
  background: "transparent",
  color: "var(--color-accent)",
  fontSize: 11,
  cursor: "pointer",
};
