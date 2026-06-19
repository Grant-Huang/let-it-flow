import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { toast, ToastHost } from "../components/Toast";

// ── 类型（与后端 src/llm/*.ts 对齐）──────────────────────────────────────

const PROVIDERS = ["openai", "ollama", "azure", "anthropic", "openai-compatible"] as const;
const STRUCTURED = ["native", "weak"] as const;
const CAPABILITIES = ["chat", "structured", "streaming", "reasoning"] as const;
const CALL_SITES = ["planner", "rewrite", "translate", "seam_repair", "terminology", "image_prompts"] as const;
const CALL_SITE_LABELS: Record<string, string> = {
  planner: "planner（DAG 规划）",
  rewrite: "rewrite（旁述改写 step3）",
  translate: "translate（初译 step2）",
  seam_repair: "seam_repair（接缝修复 step3b）",
  terminology: "terminology（术语统一 step3c）",
  image_prompts: "image_prompts（生图提示词 step3d）",
};

/** 已知 apiKeyEnv 候选（对应 .env 中应配置的变量名）。 */
const KNOWN_API_KEY_ENVS = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AZURE_API_KEY"] as const;
/** 各 provider 推荐的 apiKeyEnv（用于切换 provider 时自动联动）。 */
const PROVIDER_DEFAULT_KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  "openai-compatible": "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  azure: "AZURE_API_KEY",
  ollama: "",
};
/** ollama 默认本地端点。 */
const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";

interface ModelEndpoint {
  alias: string;
  provider: string;
  modelId: string;
  baseURL?: string;
  apiKeyEnv: string;
  azureResourceName?: string;
  azureApiVersion?: string;
  structuredSupport: string;
  capabilities: string[];
  pricing?: { inputPer1K: number; outputPer1K: number };
  note?: string;
  enabled: boolean;
}

interface CallSiteBinding {
  callSite: string;
  modelAlias: string;
  params: { temperature?: number; maxTokens?: number; topP?: number };
  robustGuard: boolean;
}

// ── 主组件 ────────────────────────────────────────────────────────────────

export default function ModelsPage(): JSX.Element {
  const [tab, setTab] = useState<"registry" | "bindings">("registry");
  return (
    <div>
      <ToastHost />
      <h1 className="text-xl font-semibold mb-1">模型配置</h1>
      <p className="text-muted text-sm mb-4">
        管理「可用模型注册表」与「调用点 → 模型绑定」。修改后后端热加载（清缓存），正在执行的任务用旧配置跑完。
      </p>
      <div className="flex gap-2 mb-4">
        <button
          className={`btn ${tab === "registry" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setTab("registry")}
        >
          模型注册表
        </button>
        <button
          className={`btn ${tab === "bindings" ? "btn-primary" : "btn-ghost"}`}
          onClick={() => setTab("bindings")}
        >
          调用点绑定
        </button>
      </div>
      {tab === "registry" ? <RegistryTab /> : <BindingsTab />}
    </div>
  );
}

// ── 模型注册表 Tab ────────────────────────────────────────────────────────

const EMPTY_MODEL: ModelEndpoint = {
  alias: "",
  provider: "openai",
  modelId: "",
  baseURL: "",
  apiKeyEnv: "OPENAI_API_KEY",
  azureResourceName: "",
  azureApiVersion: "2024-10-21",
  structuredSupport: "native",
  capabilities: ["chat"],
  pricing: undefined,
  note: "",
  enabled: true,
};

function RegistryTab(): JSX.Element {
  const [models, setModels] = useState<ModelEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<ModelEndpoint | null>(null);
  const [isNew, setIsNew] = useState(false);

  async function load() {
    setLoading(true);
    try {
      setModels(await api.get<ModelEndpoint[]>("/api/config/models"));
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function save() {
    if (!editing) return;
    try {
      if (isNew) {
        await api.post("/api/config/models", editing);
      } else {
        await api.put(`/api/config/models/${editing.alias}`, editing);
      }
      toast("success", "已保存");
      setEditing(null);
      await load();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  async function remove(alias: string) {
    if (!confirm(`删除模型 ${alias}？`)) return;
    try {
      await api.del(`/api/config/models/${alias}`);
      toast("success", "已删除");
      await load();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  if (loading) return <p className="text-muted">加载中…</p>;

  return (
    <div>
      <div className="card mb-3" style={{ borderColor: "rgb(var(--primary) / 0.3)" }}>
        <p className="text-sm">
          <strong>部署者维护</strong>：模型接入（provider / 密钥 / 端点）与定价。使用者只读。
        </p>
      </div>
      <div className="flex justify-between items-center mb-3">
        <h2 className="font-medium">已注册模型（{models.length}）</h2>
        <button className="btn btn-primary" onClick={() => { setEditing({ ...EMPTY_MODEL }); setIsNew(true); }}>
          + 新增模型
        </button>
      </div>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-muted border-b" style={{ borderColor: "rgb(var(--border))" }}>
              <th className="py-2 pr-3">alias</th>
              <th className="py-2 pr-3">provider</th>
              <th className="py-2 pr-3">modelId</th>
              <th className="py-2 pr-3">能力</th>
              <th className="py-2 pr-3">单价(入/出)</th>
              <th className="py-2 pr-3">状态</th>
              <th className="py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <tr key={m.alias} className="border-b" style={{ borderColor: "rgb(var(--border))" }}>
                <td className="py-2 pr-3 font-mono">{m.alias}</td>
                <td className="py-2 pr-3">{m.provider}</td>
                <td className="py-2 pr-3 font-mono">{m.modelId}</td>
                <td className="py-2 pr-3">{m.capabilities.join(", ")}</td>
                <td className="py-2 pr-3">
                  {m.pricing ? `${m.pricing.inputPer1K}/${m.pricing.outputPer1K}` : "—"}
                </td>
                <td className="py-2 pr-3">
                  <span className={`badge ${m.enabled ? "badge-success" : "badge-muted"}`}>
                    {m.enabled ? "启用" : "禁用"}
                  </span>
                </td>
                <td className="py-2 whitespace-nowrap">
                  <button className="btn btn-ghost mr-1" onClick={() => { setEditing({ ...m }); setIsNew(false); }}>编辑</button>
                  <button className="btn btn-danger" onClick={() => remove(m.alias)}>删</button>
                </td>
              </tr>
            ))}
            {models.length === 0 && (
              <tr><td colSpan={7} className="py-6 text-center text-muted">暂无模型，点击右上角新增</td></tr>
            )}
          </tbody>
        </table>
      </div>
      {editing && (
        <ModelEditor
          value={editing}
          isNew={isNew}
          onChange={setEditing}
          onSave={save}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function ModelEditor(props: {
  value: ModelEndpoint;
  isNew: boolean;
  onChange: (m: ModelEndpoint) => void;
  onSave: () => void;
  onCancel: () => void;
}): JSX.Element {
  const { value: m, onChange } = props;
  const set = (patch: Partial<ModelEndpoint>) => onChange({ ...m, ...patch });
  const toggleCap = (cap: string) => {
    const has = m.capabilities.includes(cap);
    set({ capabilities: has ? m.capabilities.filter((c) => c !== cap) : [...m.capabilities, cap] });
  };
  /** 切换 provider 时联动 apiKeyEnv / baseURL（ollama 隐藏 key、默认本地端点）。 */
  const isOllama = m.provider === "ollama";
  const isAzure = m.provider === "azure";
  const onProviderChange = (provider: string) => {
    const next: Partial<ModelEndpoint> = { provider };
    const defaultKeyEnv = PROVIDER_DEFAULT_KEY_ENV[provider] ?? "";
    if (provider === "ollama" && !m.baseURL) {
      next.baseURL = OLLAMA_DEFAULT_BASE_URL;
    }
    // 仅当当前 key env 属于已知清单且与该 provider 默认不符时才覆盖，
    // 避免抹掉用户自定义的 env 名
    if (KNOWN_API_KEY_ENVS.includes(m.apiKeyEnv as typeof KNOWN_API_KEY_ENVS[number])) {
      next.apiKeyEnv = defaultKeyEnv;
    }
    set(next);
  };
  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center p-4" style={{ backgroundColor: "rgb(0 0 0 / 0.5)" }}>
      <div className="card w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <h3 className="font-medium mb-4">{props.isNew ? "新增模型" : `编辑 ${m.alias}`}</h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">alias（小写连字符）</label>
            <input className="input" value={m.alias} disabled={!props.isNew}
              onChange={(e) => set({ alias: e.target.value })} />
          </div>
          <div>
            <label className="label">provider</label>
            <select className="input" value={m.provider} onChange={(e) => onProviderChange(e.target.value)}>
              {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className="label">modelId</label>
            <input className="input" value={m.modelId} onChange={(e) => set({ modelId: e.target.value })} />
          </div>
          <div>
            <label className="label">
              baseURL{isOllama ? "（ollama 本地端点）" : "（可选）"}
            </label>
            <input
              className="input"
              value={m.baseURL ?? ""}
              placeholder={isOllama ? OLLAMA_DEFAULT_BASE_URL : ""}
              onChange={(e) => set({ baseURL: e.target.value })}
            />
          </div>
          {!isOllama && (
            <div>
              <label className="label">apiKeyEnv（环境变量名）</label>
              <input
                className="input"
                value={m.apiKeyEnv}
                list="known-key-envs"
                onChange={(e) => set({ apiKeyEnv: e.target.value })}
              />
              <datalist id="known-key-envs">
                {KNOWN_API_KEY_ENVS.map((k) => <option key={k} value={k} />)}
              </datalist>
            </div>
          )}
          {isAzure && (
            <>
              <div>
                <label className="label">azureResourceName（必填）</label>
                <input
                  className="input"
                  value={m.azureResourceName ?? ""}
                  placeholder="my-azure-resource"
                  onChange={(e) => set({ azureResourceName: e.target.value })}
                />
              </div>
              <div>
                <label className="label">azureApiVersion</label>
                <input
                  className="input"
                  value={m.azureApiVersion ?? "2024-10-21"}
                  onChange={(e) => set({ azureApiVersion: e.target.value })}
                />
              </div>
            </>
          )}
          <div>
            <label className="label">结构化能力</label>
            <select className="input" value={m.structuredSupport} onChange={(e) => set({ structuredSupport: e.target.value })}>
              {STRUCTURED.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div className="col-span-2">
            <label className="label">能力标签</label>
            <div className="flex gap-3">
              {CAPABILITIES.map((cap) => (
                <label key={cap} className="flex items-center gap-1 text-sm">
                  <input type="checkbox" checked={m.capabilities.includes(cap)} onChange={() => toggleCap(cap)} />
                  {cap}
                </label>
              ))}
            </div>
          </div>
          <div>
            <label className="label">单价 入/1K token ($)</label>
            <input type="number" step="0.0001" className="input" value={m.pricing?.inputPer1K ?? ""}
              onChange={(e) => set({ pricing: { ...m.pricing!, inputPer1K: Number(e.target.value), outputPer1K: m.pricing?.outputPer1K ?? 0 } })} />
          </div>
          <div>
            <label className="label">单价 出/1K token ($)</label>
            <input type="number" step="0.0001" className="input" value={m.pricing?.outputPer1K ?? ""}
              onChange={(e) => set({ pricing: { ...m.pricing!, inputPer1K: m.pricing?.inputPer1K ?? 0, outputPer1K: Number(e.target.value) } })} />
          </div>
          <p className="col-span-2 text-xs text-muted">
            填 provider 官方标价，用于成本统计。使用者可在成本页查看（定价 + 实际用量）。
          </p>
          <div className="col-span-2">
            <label className="label">备注（可选）</label>
            <input className="input" value={m.note ?? ""} onChange={(e) => set({ note: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 text-sm col-span-2">
            <input type="checkbox" checked={m.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
            启用
          </label>
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button className="btn btn-ghost" onClick={props.onCancel}>取消</button>
          <button className="btn btn-primary" onClick={props.onSave}>保存</button>
        </div>
      </div>
    </div>
  );
}

// ── 调用点绑定 Tab ────────────────────────────────────────────────────────

function BindingsTab(): JSX.Element {
  const [bindings, setBindings] = useState<CallSiteBinding[]>([]);
  const [models, setModels] = useState<ModelEndpoint[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    try {
      const [b, m] = await Promise.all([
        api.get<CallSiteBinding[]>("/api/config/bindings"),
        api.get<ModelEndpoint[]>("/api/config/models"),
      ]);
      setBindings(b);
      setModels(m);
    } catch (e) {
      toast("error", (e as Error).message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void load(); }, []);

  async function update(callSite: string, patch: Partial<CallSiteBinding>) {
    const target = bindings.find((b) => b.callSite === callSite);
    if (!target) return;
    const next = { ...target, ...patch };
    try {
      await api.put(`/api/config/bindings/${callSite}`, next);
      toast("success", `${callSite} 已保存`);
      await load();
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }

  if (loading) return <p className="text-muted">加载中…</p>;

  // 仅列出 capabilities 含 chat 的启用模型供调用点绑定（planner 等需 chat 能力）
  const chatModels = models.filter((m) => m.enabled && m.capabilities.includes("chat"));

  return (
    <div>
      <div className="card mb-3" style={{ borderColor: "rgb(var(--primary) / 0.3)" }}>
        <p className="text-sm">
          <strong>使用者维护</strong>：为每个调用点选模型 + 调参数（temperature / maxTokens）。修改后自动热加载。
        </p>
      </div>
      <h2 className="font-medium mb-2">6 个调用点绑定</h2>
      <div className="space-y-3">
        {bindings.map((b) => (
          <div key={b.callSite} className="card">
            <div className="flex items-center justify-between mb-3">
              <div>
                <span className="font-mono font-medium">{b.callSite}</span>
                <span className="text-muted text-sm ml-2">{CALL_SITE_LABELS[b.callSite] ?? ""}</span>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={b.robustGuard}
                  onChange={(e) => update(b.callSite, { robustGuard: e.target.checked })}
                />
                RobustOutputGuard
              </label>
            </div>
            <div className="grid grid-cols-4 gap-3">
              <div>
                <label className="label">模型</label>
                <select
                  className="input"
                  value={b.modelAlias}
                  onChange={(e) => update(b.callSite, { modelAlias: e.target.value })}
                >
                  {chatModels.map((m) => (
                    <option key={m.alias} value={m.alias}>{m.alias}</option>
                  ))}
                  {!chatModels.some((m) => m.alias === b.modelAlias) && (
                    <option value={b.modelAlias}>{b.modelAlias}（当前/env）</option>
                  )}
                </select>
              </div>
              <div>
                <label className="label">temperature</label>
                <input
                  type="number" step="0.05" min={0} max={2} className="input"
                  value={b.params.temperature ?? ""}
                  onChange={(e) => update(b.callSite, { params: { ...b.params, temperature: e.target.value === "" ? undefined : Number(e.target.value) } })}
                />
              </div>
              <div>
                <label className="label">maxTokens</label>
                <input
                  type="number" step="1" min={1} className="input"
                  value={b.params.maxTokens ?? ""}
                  onChange={(e) => update(b.callSite, { params: { ...b.params, maxTokens: e.target.value === "" ? undefined : Number(e.target.value) } })}
                />
              </div>
              <div>
                <label className="label">topP</label>
                <input
                  type="number" step="0.05" min={0} max={1} className="input"
                  value={b.params.topP ?? ""}
                  onChange={(e) => update(b.callSite, { params: { ...b.params, topP: e.target.value === "" ? undefined : Number(e.target.value) } })}
                />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
