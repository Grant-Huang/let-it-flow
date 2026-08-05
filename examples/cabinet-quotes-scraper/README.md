# Canada Cabinet Quotes（加拿大橱柜报价助手）

一个基于 let-it-flow 平台工具（`core.web_search` provider、`core.web_fetch` 的 `extractHtml`、
`LlmService`）的独立 example 应用：

1. **聊天设计支持** —— 对话式收集厨房橱柜项目需求（尺寸/风格/材质/预算/工期/城市）。
2. **线索检索** —— 检索并抓取加拿大橱柜（kitchen cabinet）供应商网站，用 LLM 结构化抽取
   公司名 / 联系人 / 邮箱 / 电话。
3. **询价邮件** —— 基于收集到的需求为每家公司生成个性化 RFQ（Request for Quote）邮件草稿，
   **人工确认后才真正发送**。

## 运行

```bash
pnpm install
cp .env.example .env   # 填 OPENAI_API_KEY（或兼容服务）；TAVILY_API_KEY 可选（无则用 DuckDuckGo）
pnpm dev:cabinet-quotes
# 打开 http://localhost:8790
```

## 关于发送邮件（请先读这段）

- **默认是 dry run。** 只要 `.env` 里的 `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` 有任一为空，
  `/api/emails/send` 就只会把草稿标记为 `skipped`，**不会发起任何网络请求**。
- 要真正发送，需要在 `.env` 填好你自己邮箱账号的 SMTP 信息（`SMTP_HOST`/`SMTP_PORT`/
  `SMTP_USER`/`SMTP_PASS`/`SMTP_FROM`），并在页面上勾选草稿、点击"确认并发送"——前端会弹一次
  浏览器 `confirm()` 二次确认，后端也要求请求体显式带 `confirm: true` 才会调用 nodemailer。
- 逐封发送之间有节流延迟，避免触发邮箱服务商的批量发信风控。
- **这不是营销邮件群发工具。** 生成的邮件是"向已公开报价业务邮箱的公司发送一次性询价"，
  内容应只包含用户自己的真实项目需求。加拿大的反垃圾邮件法（CASL）对商业电子消息有严格
  的同意与身份披露要求；批量群发广告/推广邮件到抓取来的地址通常不合规。发送前请：
  - 确认每封邮件确实是你本人发起的、有实际意图的报价询问（而不是自动化广告推送）；
  - 邮件里保留真实寄件人身份与联系方式（页面已默认带上 `CABINET_SENDER_NAME`/`_PHONE`）；
  - 不要把这个工具改造成面向消费者的营销群发器。

## 文件

- `leads.ts` —— 检索查询构造、网页抓取（复用平台 `extractHtml`）、`mailto:` 正则抽取 +
  LLM 结构化抽取、按邮箱去重。
- `email.ts` —— LLM 生成询价邮件文案；`nodemailer` 发送（含 dry-run 闸门与确认闸门）。
- `server.ts` —— Hono API（`/api/chat`、`/api/leads/search`、`/api/emails/compose`、
  `/api/emails/send`）+ 静态页面。
- `web/index.html` —— 单页 UI（聊天面板 + 线索表格 + 邮件草稿预览/发送）。
- `types.ts` —— 共享类型。

## API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/api/chat` | `{ message }` → `{ reply, requirements }`，对话式收集需求 |
| GET  | `/api/requirements` | 当前累积的需求摘要 |
| POST | `/api/leads/search` | `{ cities?, maxQueries? }` → `{ leads, progress }` |
| GET  | `/api/leads` | 已发现的线索列表 |
| POST | `/api/emails/compose` | `{ leadIds }` → `{ drafts, sendConfigured }` |
| GET  | `/api/emails` | 当前草稿列表 |
| POST | `/api/emails/send` | `{ draftIds, confirm: true }` → `{ drafts }`（更新后的状态） |
