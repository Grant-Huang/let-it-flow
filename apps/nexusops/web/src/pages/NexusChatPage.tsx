import { useState, useCallback, useEffect } from "react";
import { ThreeColumnLayout, MessageList, ChatComposer, type NavItem } from "@meso.ai/ui";
import type { Message } from "@meso.ai/ui";
import type { StreamState } from "@meso.ai/types";
import { useNexusStream } from "../hooks/useNexusStream.js";
import { createRenderLiveTrace } from "../components/renderLiveTrace.js";
import { createRenderExtension } from "../components/renderExtension.js";
import { ArtifactSlot } from "../components/ArtifactSlot.js";
import { SessionList } from "../components/SessionList.js";
import { extractArtifacts } from "../lib/artifacts.js";
import type { ConfirmDecision } from "../lib/api.js";

/** 从 StreamState 的 eventLog 中拼接所有文本 delta，得到本轮 AI 回答的完整文本。 */
function extractFinalText(s: StreamState): string {
  return s.eventLog
    .filter((ev) => ev.type === "text")
    .map((ev) => ((ev.data as { delta?: string }).delta ?? ""))
    .join("")
    .trim();
}

/**
 * NexusOps 运营智能分析主页面。
 *
 * ReAct harness：用户提精益分析问题 → harness 多步取证 → 产出结构化建议。
 * 与 podcast 生成页同构（三栏布局 + 流式 + HITL），区别在：
 *  - 欢迎语/示例是运营分析场景
 *  - 产物面板渲染建议/诊断而非文稿/视频
 */
export default function NexusChatPage() {
  const [activeNav, setActiveNav] = useState("analyze");
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<Message[]>([]);
  const [artifactVisible, setArtifactVisible] = useState(false);
  const [verboseMode, setVerboseMode] = useState(false);

  const { state, taskId, conversationId, isStreaming, start, followUp, replay, confirm, clarify, abort, reset } = useNexusStream();

  const navItems: NavItem[] = [
    { id: "analyze", label: "分析", icon: <IconChart />, active: activeNav === "analyze", onClick: () => setActiveNav("analyze") },
    { id: "history", label: "历史", icon: <IconClock />, active: activeNav === "history", onClick: () => setActiveNav("history") },
    { id: "settings", label: "设置", icon: <IconGear />, active: activeNav === "settings", onClick: () => setActiveNav("settings") },
  ];

  const handleSend = async () => {
    const intent = input.trim();
    if (!intent || isStreaming) return;
    // Bug Fix 1: 发新问题前，先把上一轮 AI 回答存入历史（否则 state 被重置后回答消失）
    if (taskId) {
      const prevText = extractFinalText(state);
      if (prevText) {
        setHistory((prev) => [
          ...prev,
          { id: `a-${taskId}`, role: "assistant", content: prevText, timestamp: new Date().toISOString() },
        ]);
      }
    }
    // 把用户意图压入历史轮次（多轮展示）
    setHistory((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: "user", content: intent, timestamp: new Date().toISOString() },
    ]);
    setInput("");
    // Bug Fix 2: 只要有 conversationId 且不在流式中即可追问（state.status 完成态是 "done" 不是 "idle"）
    const canFollowUp = !!conversationId && !isStreaming;
    if (canFollowUp) {
      await followUp(intent);
    } else {
      reset();
      await start(intent);
    }
  };

  const handleAbort = () => {
    abort();
  };

  const handleSelectHistory = (historyTaskId: string) => {
    reset();
    setHistory([]);
    void replay(historyTaskId);
  };

  const handleNewSession = () => {
    reset();
    setHistory([]);
  };

  const handleConfirm = (decision: ConfirmDecision["decision"]) => {
    confirm(decision);
  };

  const handleMcpAction = useCallback(
    (tool: string, args: Record<string, unknown>) => {
      // Route the HTML report button click as a follow-up intent,
      // so the agent can present a HITL confirm_gate before executing.
      const intent = `请执行：${tool}，参数：${JSON.stringify(args)}`;
      // 同 handleSend：先把上一轮 AI 回答存入历史再发新意图
      if (taskId) {
        const prevText = extractFinalText(state);
        if (prevText) {
          setHistory((prev) => [
            ...prev,
            { id: `a-${taskId}`, role: "assistant", content: prevText, timestamp: new Date().toISOString() },
          ]);
        }
      }
      setHistory((prev) => [
        ...prev,
        { id: `u-mcp-${Date.now()}`, role: "user", content: `[报告按钮] ${intent}`, timestamp: new Date().toISOString() },
      ]);
      void followUp(intent);
    },
    [followUp, state, taskId],
  );

  const renderLiveTrace = createRenderLiveTrace({
    streaming: isStreaming,
    verbose: verboseMode,
    onToolConfirm: () => handleConfirm("approve"),
    onToolCancel: () => handleConfirm("reject"),
  });

  const renderExtension = createRenderExtension({
    onConfirm: (decision) => handleConfirm(decision),
    onClarify: (message) => clarify(message),
  });

  const hasArtifacts = extractArtifacts(state).length > 0;
  const showArtifact = artifactVisible || hasArtifacts;

  // Auto-collapse panel when artifacts disappear (e.g. new session reset)
  useEffect(() => {
    if (!hasArtifacts) setArtifactVisible(false);
  }, [hasArtifacts]);

  return (
    <ThreeColumnLayout
      appName="NexusOps"
      navItems={navItems}
      sidebarFooter={<SidebarFooter />}
      sessionColumn={
        <SessionList
          activeTaskId={taskId}
          onSelect={handleSelectHistory}
          onNewSession={handleNewSession}
        />
      }
      artifactPanel={<ArtifactSlot stream={state} onMcpAction={handleMcpAction} />}
      artifactVisible={showArtifact}
      onArtifactToggle={setArtifactVisible}
      defaultArtifactVisible={false}
      contentMaxWidth={860}
    >
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div style={{ flex: 1, overflow: "auto" }}>
          <MessageList
            messages={history}
            streaming={isStreaming || state.status !== "idle" ? state : undefined}
            emptyState={<WelcomeScreen />}
            emptyStateAlign="top"
            renderLiveTrace={renderLiveTrace}
            renderExtension={renderExtension}
            onToolConfirm={(toolCallId) => {
              void toolCallId;
              handleConfirm("approve");
            }}
            onToolCancel={(toolCallId) => {
              void toolCallId;
              handleConfirm("reject");
            }}
          />
        </div>
        <div style={{ flexShrink: 0, padding: "0 0 8px" }}>
          {state.status === "error" && state.errorMessage && (
            <div style={{ color: "var(--color-error)", fontSize: 13, marginBottom: 6, padding: "0 4px" }}>
              {state.errorMessage}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 8, paddingBottom: 8, paddingLeft: 4, paddingRight: 4 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--color-text-secondary)", cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={verboseMode}
                onChange={(e) => setVerboseMode(e.target.checked)}
                style={{ cursor: "pointer" }}
              />
              <span>详细模式 (Verbose)</span>
            </label>
          </div>
          <ChatComposer
            value={input}
            onChange={setInput}
            onSubmit={handleSend}
            onStop={handleAbort}
            streaming={isStreaming}
            placeholder="输入运营分析问题，如：L01产线OEE最近偏低，帮我诊断原因并给改善建议"
          />
        </div>
      </div>
    </ThreeColumnLayout>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 欢迎屏 + 占位组件
// ─────────────────────────────────────────────────────────────────────────────

function WelcomeScreen() {
  return (
    <div className="nexus-welcome" style={{ padding: "48px 24px", textAlign: "center" }}>
      <h1 style={{ fontSize: 24, marginBottom: 12 }}>NexusOps · 运营智能分析</h1>
      <p style={{ color: "var(--color-text-secondary)", marginBottom: 24 }}>
        精益生产智能分析助手。ReAct 多步取证 + 证据驱动建议。
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 12,
          maxWidth: 640,
          margin: "0 auto",
        }}
      >
        <ExampleCard title="OEE 诊断" desc="L01产线OEE最近偏低，帮我诊断原因并给改善建议" />
        <ExampleCard title="停机根因" desc="L01上周停机时间激增，分析根因" />
        <ExampleCard title="质量缺陷" desc="L01产线缺陷率超标，帕累托分析主因" />
      </div>
    </div>
  );
}

function ExampleCard({ title, desc }: { title: string; desc: string }) {
  return (
    <div
      style={{
        padding: 16,
        borderRadius: 10,
        background: "var(--color-bg-elevated)",
        border: "1px solid var(--color-border-light)",
        textAlign: "left",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>{desc}</div>
    </div>
  );
}

function SidebarFooter() {
  return (
    <div style={{ padding: "8px 12px", fontSize: 11, color: "var(--color-text-muted)" }}>
      <div>NexusOps · Let It Flow · v0.1.0</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 内联 SVG 图标
// ─────────────────────────────────────────────────────────────────────────────

function IconChart() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2 13V3M2 13h12M5 11V8M8 11V5M11 11V6.5M14 11V3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconClock() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.5V8l2.5 1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function IconGear() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M3 13l1.4-1.4M11.6 4.4L13 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
