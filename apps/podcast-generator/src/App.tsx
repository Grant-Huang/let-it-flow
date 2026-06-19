import { Routes, Route, Navigate } from "react-router-dom";
import PodcastChatPage from "./pages/PodcastChatPage.js";

/**
 * 路由：/ 生成页（P10.1 仅此页），/history 与 /settings 占位（后续里程碑）。
 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<PodcastChatPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
