import { Routes, Route, NavLink, Navigate } from "react-router-dom";
import ModelsPage from "./pages/ModelsPage";
import SystemPage from "./pages/SystemPage";
import HeavyIoPage from "./pages/HeavyIoPage";

const navItems = [
  { to: "/models", label: "模型配置", audience: "部署者 / 使用者" },
  { to: "/system", label: "任务与流式", audience: "部署者" },
  { to: "/heavy-io", label: "重 IO 工具链", audience: "部署者" },
];

export default function App() {
  return (
    <div className="min-h-screen">
      <header className="border-b sticky top-0 z-10 backdrop-blur" style={{ borderColor: "rgb(var(--border))", backgroundColor: "rgb(var(--card) / 0.8)" }}>
        <div className="max-w-5xl mx-auto px-4 py-3 flex items-center gap-6">
          <span className="font-semibold">Let It Flow</span>
          <nav className="flex gap-1">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) =>
                  `btn ${isActive ? "btn-primary" : "btn-ghost"}`
                }
              >
                {item.label}
                <span className="ml-1 text-xs opacity-60">[{item.audience}]</span>
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-4 py-8">
        <Routes>
          <Route path="/" element={<Navigate to="/models" replace />} />
          <Route path="/models" element={<ModelsPage />} />
          <Route path="/system" element={<SystemPage />} />
          <Route path="/heavy-io" element={<HeavyIoPage />} />
        </Routes>
      </main>
    </div>
  );
}
