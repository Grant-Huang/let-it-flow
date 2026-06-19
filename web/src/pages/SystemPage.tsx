import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { toast, ToastHost } from "../components/Toast";

// ── 类型（与 src/core/system-settings.ts 对齐）─────────────────────────────

interface SystemSettings {
  heavyIoTimeoutMs: number;
  subprocessDefaultTimeoutMs: number;
  contentMaxTokens: number;
  contentRewriteMaxTokens: number;
  contentStrip: boolean;
  contentSummarize: boolean;
  fetchMaxBytes: number;
  searchMaxResults: number;
  sseDeadlineMs: number;
  ssePollIntervalMs: number;
  coalescerMaxBuffer: number;
  coalescerMaxDelayMs: number;
}

// 字段分组定义（驱动渲染）
interface FieldDef {
  key: keyof SystemSettings;
  label: string;
  type: "number" | "boolean";
  hint?: string;
}
interface GroupDef {
  title: string;
  description: string;
  fields: FieldDef[];
}

const GROUPS: GroupDef[] = [
  {
    title: "超时（毫秒）",
    description: "控制各步骤的最大执行时间。超时后任务失败。",
    fields: [
      { key: "heavyIoTimeoutMs", label: "重 IO 单步超时", type: "number", hint: "rewrite / TTS / 生图 / 视频合成等步骤的超时" },
      { key: "subprocessDefaultTimeoutMs", label: "子进程默认超时", type: "number", hint: "SubprocessAdapter 未显式指定时的默认超时" },
    ],
  },
  {
    title: "内容管道",
    description: "DAG 节点注入上游数据时的压缩策略默认值（节点级可覆盖）。",
    fields: [
      { key: "contentMaxTokens", label: "默认 maxTokens", type: "number", hint: "注入本节点前的最大 token 数（按 4 字符/token 估算）" },
      { key: "contentRewriteMaxTokens", label: "rewrite 专用 maxTokens", type: "number", hint: "rewrite 节点默认比普通节点高" },
      { key: "contentStrip", label: "HTML/Markdown 净化", type: "boolean", hint: "剥离标签、导航噪声" },
      { key: "contentSummarize", label: "滚动窗口摘要化", type: "boolean", hint: "MVP 砍，永远 false" },
      { key: "fetchMaxBytes", label: "单页最大抓取字节", type: "number", hint: "兜底，避免超大页撑爆内存" },
    ],
  },
  {
    title: "搜索",
    description: "web_search 与 planner 启发式参数的默认值。",
    fields: [
      { key: "searchMaxResults", label: "默认搜索结果数", type: "number", hint: "web_search 节点参数缺省值（上限 20）" },
    ],
  },
  {
    title: "流式传输",
    description: "SSE 长连接与事件合并器（coalescer）参数。",
    fields: [
      { key: "sseDeadlineMs", label: "SSE 长连接最大挂起", type: "number", hint: "超时后让客户端重连，避免僵尸连接" },
      { key: "ssePollIntervalMs", label: "SSE 轮询间隔", type: "number", hint: "等待新事件的轮询间隔" },
      { key: "coalescerMaxBuffer", label: "coalescer 缓冲阈值（条数）", type: "number", hint: "content 通道缓冲达到此数则 flush" },
      { key: "coalescerMaxDelayMs", label: "coalescer flush 延迟", type: "number", hint: "距上次 flush 超过此毫秒则 flush" },
    ],
  },
];

// ── 主组件 ────────────────────────────────────────────────────────────────

export default function SystemPage(): JSX.Element {
  const [settings, setSettings] = useState<SystemSettings | null>(null);
  const [dirty, setDirty] = useState(false);

  async function load() {
    try {
      const data = await api.get<SystemSettings>("/api/config/system");
      setSettings(data);
      setDirty(false);
    } catch (e) {
      toast("error", (e as Error).message);
    }
  }
  useEffect(() => { void load(); }, []);

  function setField(key: keyof SystemSettings, value: number | boolean) {
    setSettings((prev) => (prev ? { ...prev, [key]: value } : prev));
    setDirty(true);
  }

  async function save() {
    if (!settings) return;
    try {
      const updated = await api.put<SystemSettings>("/api/config/system", settings);
      setSettings(updated);
      setDirty(false);
      toast("success", "系统设置已保存");
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
          <h1 className="text-xl font-semibold mb-1">任务与流式设置</h1>
          <p className="text-muted text-sm">
            <strong>部署者维护</strong>：超时、内容管道、搜索、流式传输等系统级参数。
            <span className="ml-1">不热加载，改后下次读取生效。</span>
          </p>
        </div>
        <div className="flex gap-2">
          {dirty && <span className="badge badge-muted self-center">未保存</span>}
          <button className="btn btn-ghost" onClick={reset}>重置</button>
          <button className="btn btn-primary" onClick={save} disabled={!dirty}>保存</button>
        </div>
      </div>
      <div className="space-y-4">
        {GROUPS.map((group) => (
          <div key={group.title} className="card">
            <h2 className="font-medium mb-1">{group.title}</h2>
            <p className="text-muted text-sm mb-4">{group.description}</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              {group.fields.map((f) => (
                <FieldInput
                  key={f.key}
                  def={f}
                  value={settings[f.key]}
                  onChange={(v) => setField(f.key, v)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function FieldInput(props: {
  def: FieldDef;
  value: number | boolean;
  onChange: (v: number | boolean) => void;
}): JSX.Element {
  const { def, value } = props;
  return (
    <div>
      <label className="label">{def.label}</label>
      {def.type === "boolean" ? (
        <label className="flex items-center gap-2 h-[38px]">
          <input
            type="checkbox"
            checked={value as boolean}
            onChange={(e) => props.onChange(e.target.checked)}
          />
          <span className="text-sm">{value ? "开启" : "关闭"}</span>
        </label>
      ) : (
        <input
          type="number"
          className="input"
          value={value as number}
          onChange={(e) => props.onChange(Number(e.target.value))}
        />
      )}
      {def.hint && <p className="text-xs text-muted mt-1">{def.hint}</p>}
    </div>
  );
}
