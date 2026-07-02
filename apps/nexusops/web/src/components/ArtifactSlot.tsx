import { useEffect, useRef } from "react";
import type { StreamState } from "@meso.ai/types";
import { ArtifactPaneShell, ArtifactPanel } from "@meso.ai/ui";
import { extractArtifacts, inferLabel, isHtmlArtifact } from "../lib/artifacts.js";
import { DiagnosisPanel } from "./DiagnosisPanel.js";

/**
 * NexusOps 产物面板插槽。
 *
 * 展示 ReAct 分析的"产物"：
 *  - nexus_advise 的结构化建议（JSON，含 impact/confidence/actionTool）
 *  - skill.* 的诊断结论（含推理链 reasoningChain，DiagnosisPanel 渲染）
 *  - skill.report_html / oee.report_html 的 HTML 诊断报告（iframe 渲染）
 *
 * 受控：activeTabId 由父组件持有，便于点击会话中 #artifact 链接时切换 tab。
 */
export interface ArtifactSlotProps {
  stream: StreamState | null | undefined;
  onMcpAction?: (tool: string, args: Record<string, unknown>) => void;
  activeArtifactId?: string;
  onArtifactTabChange?: (id: string) => void;
}

export function ArtifactSlot({ stream, onMcpAction, activeArtifactId, onArtifactTabChange }: ArtifactSlotProps) {
  if (!stream) return <EmptyPanel />;

  const arts = extractArtifacts(stream);
  if (arts.length === 0) return <EmptyPanel />;

  const tabs = arts.map((art) => ({
    id: art.id,
    label: art.type === "diagnosis" ? art.title : inferLabel(art.type),
    ready: art.ready,
    content: art.ready ? (
      art.type === "diagnosis" ? (
        <DiagnosisPanel artifact={art} />
      ) : isHtmlArtifact(art.type) ? (
        <HtmlReportFrame html={art.content} onMcpAction={onMcpAction} />
      ) : (
        <ArtifactPanel type="code" content={art.content} streaming={!art.ready} />
      )
    ) : (
      <div style={{ padding: 16, color: "var(--color-text-muted)", fontSize: 13 }}>
        正在分析…
      </div>
    ),
  }));

  return (
    <ArtifactPaneShell
      tabs={tabs}
      activeTabId={activeArtifactId}
      onTabChange={onArtifactTabChange}
      autoSelectFirstReady
    />
  );
}

interface HtmlReportFrameProps {
  html: string;
  onMcpAction?: (tool: string, args: Record<string, unknown>) => void;
}

function HtmlReportFrame({ html, onMcpAction }: HtmlReportFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!onMcpAction) return;
    const handler = (event: MessageEvent) => {
      const data = event.data as { type?: string; tool?: string; args?: Record<string, unknown> };
      if (data?.type === "nexus_mcp" && typeof data.tool === "string") {
        onMcpAction(data.tool, data.args ?? {});
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [onMcpAction]);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={html}
      style={{ width: "100%", height: "100%", border: "none", borderRadius: 8 }}
      sandbox="allow-scripts allow-same-origin"
      title="OEE 诊断报告"
    />
  );
}

function EmptyPanel() {
  return (
    <div style={{ padding: 24, color: "var(--color-text-muted)", fontSize: 13, textAlign: "center" }}>
      分析产物（建议/诊断）将在此处展示
    </div>
  );
}
