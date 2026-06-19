import "@meso.ai/ui/tokens.css"; // 设计令牌（必须最先）
import "@meso.ai/ui/style.css"; // 组件样式
import "./index.css"; // 业务 Tailwind + 覆盖
import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.js";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
