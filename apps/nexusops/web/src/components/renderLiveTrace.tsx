import type { StreamState } from "@meso.ai/types";
import { ProcessTrace } from "@meso.ai/ui";

export interface RenderLiveTraceOptions {
  streaming: boolean;
  verbose?: boolean;
  onToolConfirm?: (toolCallId: string) => void;
  onToolCancel?: (toolCallId: string) => void;
}

export function createRenderLiveTrace(opts: RenderLiveTraceOptions) {
  return (stream: StreamState) => <LiveTrace stream={stream} {...opts} />;
}

function LiveTrace({
  stream,
  streaming,
  verbose = false,
  onToolConfirm,
  onToolCancel,
}: {
  stream: StreamState;
  streaming: boolean;
  verbose?: boolean;
  onToolConfirm?: (toolCallId: string) => void;
  onToolCancel?: (toolCallId: string) => void;
}) {
  return (
    <div className="nexus-live-trace">
      <ProcessTrace
        stream={stream}
        streaming={streaming}
        turnStreaming={stream.status === "streaming"}
        simplify={{ showDuration: false, verbosity: verbose ? "detailed" : "compact" }}
        onToolConfirm={onToolConfirm}
        onToolCancel={onToolCancel}
      />
    </div>
  );
}
