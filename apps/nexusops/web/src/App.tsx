import { Routes, Route, Navigate } from "react-router-dom";
import NexusChatPage from "./pages/NexusChatPage.js";

/**
 * 路由：/ 运营智能分析页。
 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<NexusChatPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
