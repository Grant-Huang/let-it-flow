import { useState } from "react";
import type { ComponentLayout } from "../lib/api.js";
import { saveReportTemplate } from "../lib/api.js";

/**
 * 报表固化编辑器（Phase 2.3）。
 *
 * 用户点击"固化"按钮后弹出，可：
 *   - 编辑 reportType（模板 key，同 key 覆盖）
 *   - 编辑标题
 *   - 预览 / 编辑 ComponentLayout JSON（组件序列）
 *   - 选择 status（draft 试运行 / active 直接生效）
 *   - 提交保存到后端（POST /api/report-templates）
 *
 * 固化后，下次同 reportType 的报表生成会走模板路径（0 LLM 调用）。
 */
export interface ReportSolidifyEditorProps {
  /** 初始 layout（来自当前报告产物的 layout 字段）。 */
  layout: ComponentLayout;
  /** 初始 reportType。 */
  reportType: string;
  /** 初始标题。 */
  title: string;
  /** 关闭回调。 */
  onClose: () => void;
  /** 保存成功回调。 */
  onSaved?: (reportType: string) => void;
}

export function ReportSolidifyEditor({
  layout,
  reportType: initialReportType,
  title: initialTitle,
  onClose,
  onSaved,
}: ReportSolidifyEditorProps) {
  const [reportType, setReportType] = useState(initialReportType);
  const [title, setTitle] = useState(initialTitle);
  const [layoutJson, setLayoutJson] = useState(() => JSON.stringify(layout, null, 2));
  const [status, setStatus] = useState<"draft" | "active">("active");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);

  function handleSave() {
    setError(null);
    setJsonError(null);

    let parsedLayout: ComponentLayout;
    try {
      parsedLayout = JSON.parse(layoutJson) as ComponentLayout;
    } catch (e) {
      setJsonError(`JSON 解析失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }

    if (!reportType.trim()) {
      setError("reportType 不能为空");
      return;
    }
    if (!title.trim()) {
      setError("标题不能为空");
      return;
    }
    if (!parsedLayout.components || !Array.isArray(parsedLayout.components)) {
      setError("layout.components 必须是数组");
      return;
    }

    setSaving(true);
    saveReportTemplate({ reportType: reportType.trim(), title: title.trim(), layout: parsedLayout, status })
      .then(() => {
        onSaved?.(reportType.trim());
        onClose();
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => setSaving(false));
  }

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <span style={{ fontWeight: 600, fontSize: 15 }}>固化报表模板</span>
          <button style={closeBtnStyle} onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div style={bodyStyle}>
          <Field label="模板标识 reportType（同 key 覆盖）">
            <input
              style={inputStyle}
              value={reportType}
              onChange={(e) => setReportType(e.target.value)}
              placeholder="如 dmaic / oee / energy_anomaly"
            />
          </Field>

          <Field label="模板标题">
            <input
              style={inputStyle}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="如 DMAIC 改善路线图"
            />
          </Field>

          <Field label="状态">
            <div style={{ display: "flex", gap: 12 }}>
              <label style={{ fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
                <input
                  type="radio"
                  checked={status === "active"}
                  onChange={() => setStatus("active")}
                />
                active（直接生效）
              </label>
              <label style={{ fontSize: 13, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }}>
                <input
                  type="radio"
                  checked={status === "draft"}
                  onChange={() => setStatus("draft")}
                />
                draft（试运行）
              </label>
            </div>
          </Field>

          <Field label="ComponentLayout（组件序列 JSON，可编辑）">
            <textarea
              style={textareaStyle}
              value={layoutJson}
              onChange={(e) => setLayoutJson(e.target.value)}
              spellCheck={false}
            />
            {jsonError && <div style={errorStyle}>{jsonError}</div>}
          </Field>

          <div style={{ fontSize: 12, color: "var(--color-text-muted)", marginTop: 4 }}>
            固化后，下次同 reportType 的报表生成会走模板路径（0 LLM 调用，0 工具取数）。
          </div>

          {error && <div style={errorStyle}>{error}</div>}
        </div>

        <div style={footerStyle}>
          <button style={cancelBtnStyle} onClick={onClose} disabled={saving}>
            取消
          </button>
          <button style={saveBtnStyle} onClick={handleSave} disabled={saving}>
            {saving ? "保存中…" : "保存模板"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  background: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const modalStyle: React.CSSProperties = {
  background: "var(--color-bg-elevated, #1e293b)",
  borderRadius: 12,
  width: "min(640px, 90vw)",
  maxHeight: "85vh",
  display: "flex",
  flexDirection: "column",
  boxShadow: "0 8px 32px rgba(0,0,0,0.3)",
};

const headerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "14px 18px",
  borderBottom: "1px solid var(--color-border-light, #334155)",
};

const closeBtnStyle: React.CSSProperties = {
  background: "none",
  border: "none",
  color: "var(--color-text-muted)",
  fontSize: 22,
  cursor: "pointer",
  lineHeight: 1,
  padding: 0,
};

const bodyStyle: React.CSSProperties = {
  padding: "16px 18px",
  overflowY: "auto",
  flex: 1,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid var(--color-border-light, #334155)",
  background: "var(--color-bg, #0f172a)",
  color: "var(--color-text, #e2e8f0)",
  fontSize: 13,
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  fontFamily: "monospace",
  fontSize: 12,
  minHeight: 200,
  resize: "vertical",
};

const footerStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  padding: "12px 18px",
  borderTop: "1px solid var(--color-border-light, #334155)",
};

const cancelBtnStyle: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: 8,
  border: "1px solid var(--color-border-light, #334155)",
  background: "transparent",
  color: "var(--color-text-secondary)",
  fontSize: 13,
  cursor: "pointer",
};

const saveBtnStyle: React.CSSProperties = {
  padding: "7px 16px",
  borderRadius: 8,
  border: "none",
  background: "var(--color-accent, #3b82f6)",
  color: "#fff",
  fontSize: 13,
  fontWeight: 500,
  cursor: "pointer",
};

const errorStyle: React.CSSProperties = {
  fontSize: 12,
  color: "var(--color-error, #ef4444)",
  marginTop: 6,
};
