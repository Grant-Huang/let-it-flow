import type { StreamState } from "@meso.ai/types";
import { ArtifactPaneShell, ArtifactPanel } from "@meso.ai/ui";
import { extractArtifacts, inferLabel, inferArtifactType } from "../lib/artifacts.js";

/**
 * 产物面板插槽（包 ArtifactPaneShell，展示文稿/视频，见 §14.3.3）。
 *
 * 从 streamState 提取 deliver 产物，用 ArtifactPaneShell 多 Tab 展示：
 *  - podcast_script → ArtifactPanel type="markdown"
 *  - 其他类型 → ArtifactPanel type="code"
 *  - 视频产物（P10.7）→ 独立播放器
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
      art.type === "podcast_video" ? (
        <VideoArtifact url={art.content} title={art.title} />
      ) : (
        <ArtifactPanel
          type={inferArtifactType(art.type)}
          content={art.content}
          streaming={!art.ready}
        />
      )
    ) : (
      <div style={{ padding: 16, color: "var(--color-text-muted)", fontSize: 13 }}>
        正在生成产物…
      </div>
    ),
  }));

  return <ArtifactPaneShell tabs={tabs} autoSelectFirstReady />;
}

function EmptyPanel() {
  return (
    <div style={{ padding: 24, color: "var(--color-text-muted)", fontSize: 13, textAlign: "center" }}>
      产物将在此处展示
    </div>
  );
}

/**
 * 视频产物展示（P10.7）。
 * content 存视频路径/URL：http(s) URL 用 HTML5 video 播放，本地路径显示链接。
 */
function VideoArtifact({ url, title }: { url: string; title?: string }) {
  const isHttp = /^https?:\/\//.test(url);
  const isStreamable = isHttp && /\.(mp4|webm|ogg)(\?|$)/i.test(url);

  return (
    <div style={{ padding: 16 }}>
      <div style={{ fontWeight: 600, marginBottom: 12 }}>{title ?? "视频已生成"}</div>
      {isStreamable ? (
        <video
          controls
          style={{ width: "100%", borderRadius: 8, background: "#000", maxHeight: "60vh" }}
          src={url}
        />
      ) : isHttp ? (
        <a href={url} target="_blank" rel="noreferrer" style={{ color: "var(--color-accent)", wordBreak: "break-all" }}>
          {url}
        </a>
      ) : (
        <code style={{ fontSize: 12, color: "var(--color-text-secondary)", wordBreak: "break-all" }}>{url}</code>
      )}
    </div>
  );
}
