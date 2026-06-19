import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { toast, ToastHost } from "../components/Toast";

// ── 类型（与 src/core/heavy-io-settings.ts 对齐）────────────────────────────

interface HeavyIoSettings {
  rewriteBackend: "ollama" | "openai";
  ollamaRewriteModel: string;
  rewriteOpenaiModel: string;
  ttsEngine: "edge" | "qwen";
  ttsRefAudio: string;
  pythonBin: string;
  ttsPythonBin: string;
}
type Source = "json" | "env" | "default";
type Sources = Record<string, Source>;

interface ApiResponse {
  settings: HeavyIoSettings;
  sources: Sources;
}

// 字段定义
interface FieldDef {
  key: keyof HeavyIoSettings;
  label: string;
  type: "text" | "select";
  options?: string[];
  hint?: string;
}

const FIELDS: FieldDef[] = [
  { key: "rewriteBackend", label: "rewrite 后端", type: "select", options: ["ollama", "openai"], hint: "step3 改写用的 LLM 后端" },
  { key: "ollamaRewriteModel", label: "ollama rewrite 模型", type: "text", hint: "rewriteBackend=ollama 时生效" },
  { key: "rewriteOpenaiModel", label: "openai rewrite 模型", type: "text", hint: "rewriteBackend=openai 时生效；留空用 writer 角色" },
  { key: "ttsEngine", label: "TTS 引擎", type: "select", options: ["edge", "qwen"], hint: "edge=Edge-TTS（无 key）；qwen=Qwen3-TTS（需 venv）" },
  { key: "ttsRefAudio", label: "TTS 参考音色路径", type: "text", hint: "qwen 引擎克隆音色用" },
  { key: "pythonBin", label: "通用 Python 解释器", type: "text", hint: "运行 ai-content-factory 文本步骤" },
  { key: "ttsPythonBin", label: "TTS venv python", type: "text", hint: "Qwen3-TTS 专用（依赖 torch/transformers）" },
];

const SOURCE_LABEL: Record<Source, string> = {
  json: "配置文件",
  env: "环境变量",
  default: "默认值",
};

// ── 主组件 ────────────────────────────────────────────────────────────────

export default function HeavyIoPage(): JSX.Element {
  const [settings, setSettings] = useState<HeavyIoSettings | null>(null);
  const [sources, setSources] = useState<Sources>({});
  const [dirty, setDirty] = useState(false);

  async function load() {
    try {
      const data = await api.get<ApiResponse>("/api/config/heavy-io");
      setSettings(data.settings);
      setSources(data.sources);
      setDirty(false);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }
  useEffect(() => { void load(); }, []);

  function setField(key: keyof HeavyIoSettings, value: string) {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
    setDirty(true);
  }

  async function save() {
    if (!settings) return;
    try {
      const data = await api.put<ApiResponse>("/api/config/heavy-io", settings);
      setSettings(data.settings);
      setSources(data.sources);
      setDirty(false);
      toast("success", "已保存（重启进程后生效）");
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function reset() {
    if (!confirm("放弃当前修改并重新加载？")) return;
    await load();
  }

  if (!settings) return <p className="text-muted">加载中…</p>;

  return (
    <div>
      <ToastHost />
      <div className="flex justify-between items-start mb-4">
        <div>
          <h1 className="text-xl font-semibold mb-1">重 IO 工具链设置</h1>
          <p className="text-muted text-sm">
            <strong>部署者维护</strong>：rewrite / TTS / 生图 / 视频合成等步骤的后端选择。
            <span className="ml-1">这些项在进程启动时构造 SubprocessAdapter，改动需重启进程生效。</span>
          </p>
        </div>
        <div className="flex gap-2">
          {dirty && <span className="badge badge-muted self-center">未保存</span>}
          <button className="btn btn-ghost" onClick={reset}>重置</button>
          <button className="btn btn-primary" onClick={save} disabled={!dirty}>保存</button>
        </div>
      </div>
      <div className="card">
        <h2 className="font-medium mb-1">后端配置</h2>
        <p className="text-muted text-sm mb-4">
          优先级：<span className="font-mono">配置文件 &gt; 环境变量 &gt; 默认值</span>。
          每项右侧徽章显示当前生效来源。
        </p>
        <div className="space-y-4">
          {FIELDS.map((f) => (
            <div key={f.key} className="grid grid-cols-[1fr_2fr_auto] items-end gap-3">
              <div>
                <label className="label">{f.label}</label>
                {f.hint && <p className="text-xs text-muted">{f.hint}</p>}
              </div>
              {f.type === "select" ? (
                <select
                  className="input"
                  value={settings[f.key] as string}
                  onChange={(e) => setField(f.key, e.target.value)}
                >
                  {f.options!.map((opt) => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  className="input font-mono text-sm"
                  value={settings[f.key] as string}
                  onChange={(e) => setField(f.key, e.target.value)}
                />
              )}
              <span className="badge badge-muted whitespace-nowrap mb-[9px]">
                {SOURCE_LABEL[sources[f.key] ?? "default"]}
              </span>
            </div>
          ))}
        </div>
      </div>
      <div className="card mt-4" style={{ borderColor: "rgb(var(--primary) / 0.4)" }}>
        <p className="text-sm">
          <strong>注意</strong>：保存后写入 <code className="font-mono">data/config/heavy_io_settings.json</code>，
          优先级高于环境变量。要恢复使用环境变量，请删除对应字段或整个文件。
          需要设置 <code className="font-mono">LIF_AICF_REPO_ROOT</code> 才会注册这些工具。
        </p>
      </div>
    </div>
  );
}
