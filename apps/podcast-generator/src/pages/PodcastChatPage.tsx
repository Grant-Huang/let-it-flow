import { useState } from "react";
import { ThreeColumnLayout, MessageList, ChatComposer, type NavItem } from "@meso.ai/ui";
import type { Message } from "@meso.ai/ui";
import { usePodcastStream } from "../hooks/usePodcastStream.js";
import { createRenderLiveTrace } from "../components/renderLiveTrace.js";
import { createRenderExtension } from "../components/renderExtension.js";
import { ArtifactSlot } from "../components/ArtifactSlot.js";
import { SessionList } from "../components/SessionList.js";
import { extractArtifacts } from "../lib/artifacts.js";
import type { ConfirmDecision } from "../lib/api.js";

/**
 * Podcast Generator 主页面。
 *
 * P10.6：接入 SessionList 历史功能（依赖后端 GET /api/tasks）。
 * 全部里程碑完成。
 */
export default function PodcastChatPage() {
  const [activeNav, setActiveNav] = useState("generate");
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<Message[]>([]);
  const [artifactVisible, setArtifactVisible] = useState(false);

  const { state, taskId, isStreaming, start, replay, confirm, clarify, abort, reset } = usePodcastStream();

  const navItems: NavItem[] = [
    { id: "generate", label: "生成", icon: <IconWave />, active: activeNav === "generate", onClick: () => setActiveNav("generate") },
    { id: "history", label: "历史", icon: <IconClock />, active: activeNav === "history", onClick: () => setActiveNav("history") },
    { id: "settings", label: "设置", icon: <IconGear />, active: activeNav === "settings", onClick: () => setActiveNav("settings") },
  ];

  const handleSend = async () => {
    const intent = input.trim();
    if (!intent || isStreaming) return;
    // 把用户意图压入历史轮次
    setHistory((prev) => [
      ...prev,
      { id: `u-${Date.now()}`, role: "user", content: intent, timestamp: new Date().toISOString() },
    ]);
    setInput("");
    reset();
    await start(intent);
  };

  const handleAbort = () => {
    abort();
  };

  /** 选中历史任务，重放其事件流 */
  const handleSelectHistory = (historyTaskId: string) => {
    reset();
    setHistory([]);
    void replay(historyTaskId);
  };

  /** 新建会话 */
  const handleNewSession = () => {
    reset();
    setHistory([]);
  };

  const handleConfirm = (decision: ConfirmDecision["decision"]) => {
    confirm(decision);
  };

  const renderLiveTrace = createRenderLiveTrace({
    streaming: isStreaming,
    onToolConfirm: () => handleConfirm("approve"),
    onToolCancel: () => handleConfirm("reject"),
  });

  const renderExtension = createRenderExtension({
    onConfirm: (decision) => handleConfirm(decision),
    onClarify: (message) => clarify(message),
  });

  // 有产物时自动展开面板
  const hasArtifacts = extractArtifacts(state).length > 0;
  const showArtifact = artifactVisible || hasArtifacts;

  return (
    <ThreeColumnLayout
      appName="Podcast Generator"
      navItems={navItems}
      sidebarFooter={<SidebarFooter />}
      sessionColumn={
        <SessionList
          activeTaskId={taskId}
          onSelect={handleSelectHistory}
          onNewSession={handleNewSession}
        />
      }
      artifactPanel={<ArtifactSlot stream={state.status !== "idle" ? state : undefined} />}
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
          <ChatComposer
            value={input}
            onChange={setInput}
            onSubmit={handleSend}
            onStop={handleAbort}
            streaming={isStreaming}
            placeholder="输入意图，如：把 https://example.com/a 做成播客"
          />
        </div>
      </div>
    </ThreeColumnLayout>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 占位组件（后续里程碑替换）
// ─────────────────────────────────────────────────────────────────────────────

function WelcomeScreen() {
  return (
    <div className="podcast-welcome" style={{ padding: "48px 24px", textAlign: "center" }}>
      <h1 style={{ fontSize: 24, marginBottom: 12 }}>Podcast Generator</h1>
      <p style={{ color: "var(--color-text-secondary)", marginBottom: 24 }}>
        输入意图，自动生成播客文稿与视频。
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
        <ExampleCard title="从 URL 生成" desc="把 https://example.com/article 做成播客" />
        <ExampleCard title="从主题生成" desc="做一期关于 AI 技术趋势的播客" />
        <ExampleCard title="完整视频链" desc="带配音、配图、字幕的完整视频播客" />
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
      <div>Let It Flow · v0.1.0</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 内联 SVG 图标
// ─────────────────────────────────────────────────────────────────────────────

function IconWave() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1 8h2l1.5-4 3 8 2-6 1.5 2H15" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
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
