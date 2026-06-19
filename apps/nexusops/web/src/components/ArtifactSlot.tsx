import type { StreamState } from "@meso.ai/types";
import { ArtifactPaneShell, ArtifactPanel } from "@meso.ai/ui";
import { extractArtifacts, inferLabel } from "../lib/artifacts.js";

/**
 * NexusOps 产物面板插槽。
 *
 * 展示 ReAct 分析的"产物"：
 *  - nexus_advise 的结构化建议（JSON，含 impact/confidence/actionTool）
 *  - skill.* 的诊断结论
 *
 * 与 podcast 的文稿/视频不同，NexusOps 产物是结构化数据，
 * 用 ArtifactPanel type="code" 渲染 JSON，让用户可查看完整证据链。
 */
export function ArtifactSlot({ stream }: { stream: StreamState | null | undefined }) {
  if (!stream) return <EmptyPanel />;

  const arts = extractArtifacts(stream);
  if (arts.length === 0) return <EmptyPanel />;

  const tabs = arts.map((art) => ({
    id: art.id,
    label: inferLabel(art.type),
    ready: art.ready,
    content: art.ready ? (
      <ArtifactPanel type="code" content={art.content} streaming={!art.ready} />
    ) : (
      <div style={{ padding: 16, color: "var(--color-text-muted)", fontSize: 13 }}>
        正在分析…
      </div>
    ),
  }));

  return <ArtifactPaneShell tabs={tabs} autoSelectFirstReady />;
}

function EmptyPanel() {
  return (
    <div style={{ padding: 24, color: "var(--color-text-muted)", fontSize: 13, textAlign: "center" }}>
      分析产物（建议/诊断）将在此处展示
    </div>
  );
}
