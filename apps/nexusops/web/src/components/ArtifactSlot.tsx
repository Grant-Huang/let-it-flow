import { useEffect, useRef, useState } from "react";
import type { StreamState } from "@meso.ai/types";
import { ArtifactPaneShell, ArtifactPanel } from "@meso.ai/ui";
import { extractArtifacts, inferLabel, isHtmlArtifact } from "../lib/artifacts.js";
import { DiagnosisPanel } from "./DiagnosisPanel.js";
import { ReportSolidifyEditor } from "./ReportSolidifyEditor.js";

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
        <HtmlReportFrame
          html={art.content}
          onMcpAction={onMcpAction}
          layout={art.layout}
          reportType={art.reportType}
          title={art.title}
        />
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
  /** 组件布局（来自 skill 输出，固化时回传编辑器）。 */
  layout?: import("../lib/api.js").ComponentLayout;
  /** 报告类型标识（固化模板 key）。 */
  reportType?: string;
  /** 报告标题。 */
  title?: string;
}

function HtmlReportFrame({ html, onMcpAction, layout, reportType, title }: HtmlReportFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [showEditor, setShowEditor] = useState(false);

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
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {layout && (
        <div style={{ padding: "6px 10px", borderBottom: "1px solid var(--color-border-light, #334155)", display: "flex", justifyContent: "flex-end" }}>
          <button style={solidifyBtnStyle} onClick={() => setShowEditor(true)}>
            固化为模板
          </button>
        </div>
      )}
      <iframe
        ref={iframeRef}
        srcDoc={html}
        style={{ width: "100%", flex: 1, border: "none", borderRadius: 8 }}
        sandbox="allow-scripts allow-same-origin"
        title="OEE 诊断报告"
      />
      {showEditor && layout && (
        <ReportSolidifyEditor
          layout={layout}
          reportType={reportType ?? "custom"}
          title={title ?? "自定义报告"}
          onClose={() => setShowEditor(false)}
          onSaved={(rt) => {
            setShowEditor(false);
            console.log(`[nexusops] 报表模板已固化：${rt}`);
          }}
        />
      )}
    </div>
  );
}

const solidifyBtnStyle: React.CSSProperties = {
  padding: "4px 12px",
  borderRadius: 6,
  border: "1px solid var(--color-border-light, #334155)",
  background: "transparent",
  color: "var(--color-accent, #3b82f6)",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
};

function EmptyPanel() {
  return (
    <div style={{ padding: 24, color: "var(--color-text-muted)", fontSize: 13, textAlign: "center" }}>
      分析产物（建议/诊断）将在此处展示
    </div>
  );
}
