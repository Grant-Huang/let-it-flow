import { useEffect, useState, useCallback } from "react";
import { listTasks, type TaskSummary } from "../lib/api.js";

/**
 * 会话历史列表。
 *
 * 从 GET /api/tasks 拉取任务列表，每条显示意图摘要、状态徽章、创建时间。
 * 点击某条调用 onSelect(taskId)，由父组件拉取该任务的事件流重放。
 */
export interface SessionListProps {
  activeTaskId?: string | null;
  onSelect: (taskId: string) => void;
  onNewSession?: () => void;
}

export function SessionList({ activeTaskId, onSelect, onNewSession }: SessionListProps) {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const data = await listTasks();
      setTasks(data);
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
        {tasks.length === 0 ? (
          <div style={muted}>暂无历史会话</div>
        ) : (
          tasks.map((t) => (
            <SessionItem
              key={t.id}
              task={t}
              active={t.id === activeTaskId}
              onClick={() => onSelect(t.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function SessionItem({ task, active, onClick }: { task: TaskSummary; active: boolean; onClick: () => void }) {
  const intent = task.intent.length > 40 ? `${task.intent.slice(0, 40)}…` : task.intent;
  return (
    <button onClick={onClick} style={itemStyle(active)}>
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4, textAlign: "left", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {intent}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <StatusBadge status={task.status} />
        <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>{formatTime(task.createdAt)}</span>
      </div>
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color = badgeColor(status);
  return (
    <span style={{ fontSize: 11, padding: "1px 6px", borderRadius: 4, background: color.bg, color: color.fg }}>
      {statusLabel(status)}
    </span>
  );
}

function badgeColor(status: string): { bg: string; fg: string } {
  switch (status) {
    case "done": return { bg: "rgba(42,122,79,0.15)", fg: "var(--color-success)" };
    case "error": case "failed": return { bg: "rgba(184,50,50,0.15)", fg: "var(--color-error)" };
    case "running": case "pending": return { bg: "rgba(61,107,82,0.15)", fg: "var(--color-info)" };
    case "pending_confirmation": case "pending_clarification": return { bg: "rgba(180,83,9,0.15)", fg: "var(--color-warning)" };
    default: return { bg: "var(--badge-bg)", fg: "var(--color-text-secondary)" };
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

const muted: React.CSSProperties = { padding: 16, color: "var(--color-text-muted)", fontSize: 13 };

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
