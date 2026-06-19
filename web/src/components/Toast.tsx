import { useEffect, useState } from "react";

// 简易全局提示（成功/错误），无需第三方依赖。
type ToastState = { kind: "success" | "error"; msg: string } | null;
let setter: ((s: ToastState) => void) | null = null;

export function toast(kind: "success" | "error", msg: string): void {
  setter?.({ kind, msg });
}

export function ToastHost(): JSX.Element {
  const [state, setState] = useState<ToastState>(null);
  useEffect(() => {
    setter = setState;
    return () => {
      setter = null;
    };
  }, []);
  useEffect(() => {
    if (!state) return;
    const t = setTimeout(() => setState(null), 3000);
    return () => clearTimeout(t);
  }, [state]);
  if (!state) return <></>;
  return (
    <div className="fixed bottom-4 right-4 z-50">
      <div
        className="card min-w-[220px]"
        style={{
          borderColor:
            state.kind === "success"
              ? "rgb(var(--success))"
              : "rgb(var(--danger))",
        }}
      >
        <p
          className="text-sm font-medium"
          style={{
            color:
              state.kind === "success"
                ? "rgb(var(--success))"
                : "rgb(var(--danger))",
          }}
        >
          {state.msg}
        </p>
      </div>
    </div>
  );
}
