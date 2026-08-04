import "dotenv/config";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { generateText, Output } from "ai";
import { z } from "zod";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { LlmService } from "../../src/services/llm-service.js";
import { loadConfig } from "../../src/llm/config-loader.js";
import { searchCabinetLeads } from "./leads.js";
import { composeQuoteEmail, isSendConfigured, sendDrafts } from "./email.js";
import type { ChatMessage, DesignRequirements, EmailDraft, Lead } from "./types.js";

/**
 * Canada Cabinet Quotes —— 独立 example 应用：
 *   1. 聊天获取橱柜设计需求（对话助手）
 *   2. 检索 + 抓取加拿大橱柜报价公司的邮箱/联系人
 *   3. 生成个性化询价邮件草稿，人工确认后才发送（未配置 SMTP 时始终 dry run）
 *
 * 用法：tsx examples/cabinet-quotes-scraper/server.ts
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const llm = new LlmService({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || undefined,
  runtimeConfig: loadConfig(),
});

// ── 内存态存储（单会话 example，无需数据库）───────────────────────────────────
const chatHistory: ChatMessage[] = [];
let requirements: DesignRequirements = { summary: "" };
const leadsStore = new Map<string, Lead>();
const draftsStore = new Map<string, EmailDraft>();

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

app.get("/", (c) => {
  const html = readFileSync(path.join(__dirname, "web/index.html"), "utf-8");
  return c.html(html);
});

// ── 聊天：设计支持顾问 ─────────────────────────────────────────────────────────
const ChatTurnSchema = z.object({
  reply: z.string().describe("给用户看的回复"),
  requirementsSummary: z.string().describe("截至目前整理出的橱柜项目需求摘要（尺寸/风格/材质/预算/工期/所在城市等），信息不足的字段留空即可，用一段自然语言描述"),
});

app.post("/api/chat", async (c) => {
  const body = await c.req.json<{ message: string }>();
  const message = (body.message ?? "").trim();
  if (!message) return c.json({ error: "message is required" }, 400);

  chatHistory.push({ role: "user", content: message });

  const model = llm.model("writer");
  const foldSystem = llm.compatMode;
  const system = [
    "你是一位友善、专业的加拿大厨房橱柜设计顾问。通过对话帮用户理清装修需求：",
    "厨房尺寸、橱柜风格（现代/传统/简约等）、材质（实木/板材/石英台面等）、预算范围、",
    "期望完工时间、所在城市/省份。每次只问 1-2 个最关键的缺失信息，不要一次性列一堆问题。",
    "已经了解足够信息后，简要复述需求让用户确认，并告知可以开始搜索报价公司了。",
    "始终输出 reply（自然对话）和 requirementsSummary（当前已知需求的结构化摘要，逐轮累积更新）。",
  ].join("\n");
  const history = chatHistory.map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`).join("\n");
  const priorSummary = requirements.summary ? `\n\n目前已知需求摘要：${requirements.summary}` : "";
  const user = `对话历史：\n${history}${priorSummary}`;

  const callArgs = foldSystem
    ? { messages: [{ role: "user" as const, content: `${system}\n\n---\n${user}` }] }
    : { system, messages: [{ role: "user" as const, content: user }] };

  const { output } = await generateText({
    model,
    ...callArgs,
    output: Output.object({ schema: ChatTurnSchema }),
    temperature: 0.3,
  });

  const reply = output?.reply ?? "抱歉，我没能理解，能再说一次吗？";
  requirements = { summary: output?.requirementsSummary ?? requirements.summary };
  chatHistory.push({ role: "assistant", content: reply });

  return c.json({ reply, requirements });
});

app.get("/api/requirements", (c) => c.json({ requirements }));

// ── 线索检索 ───────────────────────────────────────────────────────────────
app.post("/api/leads/search", async (c) => {
  const body = await c.req.json<{ cities?: string[]; maxQueries?: number }>().catch(() => ({}));
  const progress: string[] = [];
  const leads = await searchCabinetLeads(llm, {
    cities: body.cities,
    maxQueries: body.maxQueries,
    onProgress: (m) => progress.push(m),
  });
  for (const lead of leads) leadsStore.set(lead.id, lead);
  return c.json({ leads: [...leadsStore.values()], progress });
});

app.get("/api/leads", (c) => c.json({ leads: [...leadsStore.values()] }));

// ── 邮件：生成草稿 + 受控发送 ───────────────────────────────────────────────────
app.post("/api/emails/compose", async (c) => {
  const body = await c.req.json<{ leadIds: string[] }>();
  if (!requirements.summary) {
    return c.json({ error: "请先通过 /api/chat 收集设计需求" }, 400);
  }
  const drafts: EmailDraft[] = [];
  for (const leadId of body.leadIds ?? []) {
    const lead = leadsStore.get(leadId);
    if (!lead) continue;
    const { subject, body: text } = await composeQuoteEmail(llm, lead, requirements);
    const draft: EmailDraft = {
      id: `draft_${leadId}`,
      leadId,
      to: lead.email,
      subject,
      body: text,
      status: "draft",
    };
    draftsStore.set(draft.id, draft);
    drafts.push(draft);
  }
  return c.json({ drafts, sendConfigured: isSendConfigured() });
});

app.get("/api/emails", (c) => c.json({ drafts: [...draftsStore.values()], sendConfigured: isSendConfigured() }));

app.post("/api/emails/send", async (c) => {
  const body = await c.req.json<{ draftIds: string[]; confirm: boolean }>();
  const targets = (body.draftIds ?? [])
    .map((id) => draftsStore.get(id))
    .filter((d): d is EmailDraft => !!d);
  const results = await sendDrafts(targets, { confirm: !!body.confirm });
  for (const r of results) draftsStore.set(r.id, r);
  return c.json({ drafts: results });
});

const port = Number(process.env.CABINET_QUOTES_PORT || 8790);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[cabinet-quotes-scraper] http://localhost:${info.port}`);
  console.log(`[cabinet-quotes-scraper] SMTP configured: ${isSendConfigured()}`);
});
