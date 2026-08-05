/**
 * 询价邮件：LLM 生成个性化报价询问邮件（compose）+ 受控发送（send）。
 *
 * 发送默认是「草稿 → 人工确认 → 发送」，与本仓库现有 skill（如微信公众号发布，见
 * .env.example 末尾说明）保持同一原则：不做静默群发。未配置 SMTP 时 send() 走
 * dry-run，只标记邮件为 skipped，不产生任何网络请求。
 */
import { generateText } from "ai";
import type { LlmService } from "../../src/services/llm-service.js";
import type { DesignRequirements, EmailDraft, Lead } from "./types.js";

export interface SenderInfo {
  name: string;
  email: string;
  phone?: string;
}

function resolveSenderInfo(): SenderInfo {
  return {
    name: process.env.CABINET_SENDER_NAME || "A homeowner in Canada",
    email: process.env.SMTP_FROM || process.env.SMTP_USER || "",
    phone: process.env.CABINET_SENDER_PHONE || undefined,
  };
}

/** 用 LLM 为单个线索生成个性化询价邮件（英文，符合"一次性报价询问"场景）。 */
export async function composeQuoteEmail(
  llm: LlmService,
  lead: Lead,
  requirements: DesignRequirements,
  sender: SenderInfo = resolveSenderInfo(),
): Promise<Pick<EmailDraft, "subject" | "body">> {
  const model = llm.model("writer");
  const foldSystem = llm.compatMode;
  const system = [
    "You draft short, polite B2B quote-request (RFQ) emails from a prospective customer to a Canadian kitchen ",
    "cabinet company. This is a one-time inquiry, not a marketing message. Keep it under 180 words, professional, ",
    "concrete about the project, and end with the sender's contact info. Do not invent details not given.",
    "Output plain text only, no markdown. First line is the subject prefixed with 'Subject: '.",
  ].join("\n");
  const user = [
    `Company: ${lead.companyName}${lead.contactName ? ` (contact: ${lead.contactName})` : ""}`,
    `Project requirements: ${requirements.summary}`,
    `Sender name: ${sender.name}`,
    `Sender email: ${sender.email}`,
    sender.phone ? `Sender phone: ${sender.phone}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const callArgs = foldSystem
    ? { messages: [{ role: "user" as const, content: `${system}\n\n---\n${user}` }] }
    : { system, messages: [{ role: "user" as const, content: user }] };

  const { text } = await generateText({ model, ...callArgs, temperature: 0.4 });
  const lines = text.trim().split("\n");
  const subjectLine = lines[0]?.startsWith("Subject:") ? lines.shift()! : `Quote request: ${requirements.summary.slice(0, 40)}`;
  const subject = subjectLine.replace(/^Subject:\s*/i, "").trim() || `Kitchen cabinet quote request`;
  const body = lines.join("\n").trim();
  return { subject, body };
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  fromName: string;
}

export function resolveSmtpConfig(): SmtpConfig | null {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass) return null;
  return {
    host,
    port: Number(process.env.SMTP_PORT || 587),
    secure: process.env.SMTP_SECURE === "true",
    user,
    pass,
    from: process.env.SMTP_FROM || user,
    fromName: process.env.CABINET_SENDER_NAME || "Cabinet Quote Request",
  };
}

/** 是否处于可真实发送的状态（仅用于给前端展示提示，不代表已发送）。 */
export function isSendConfigured(): boolean {
  return resolveSmtpConfig() !== null;
}

const SEND_DELAY_MS = 1500;

/**
 * 发送一批已确认的草稿。
 *
 * 安全闸门：
 *   - 未配置 SMTP → 全部标记 skipped（dry run），不发起任何网络请求。
 *   - confirm !== true → 拒绝执行（调用方必须显式传入用户确认）。
 *   - 逐封间隔 {@link SEND_DELAY_MS}，避免触发供应商侧的批量发信风控。
 */
export async function sendDrafts(
  drafts: EmailDraft[],
  opts: { confirm: boolean },
): Promise<EmailDraft[]> {
  const smtp = resolveSmtpConfig();
  if (!smtp) {
    return drafts.map((d) => ({ ...d, status: "skipped", error: "SMTP 未配置：dry run，未发送任何邮件" }));
  }
  if (!opts.confirm) {
    return drafts.map((d) => ({ ...d, status: "skipped", error: "未收到用户发送确认" }));
  }

  const nodemailer = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass },
  });

  const out: EmailDraft[] = [];
  for (const draft of drafts) {
    try {
      await transporter.sendMail({
        from: `"${smtp.fromName}" <${smtp.from}>`,
        to: draft.to,
        subject: draft.subject,
        text: draft.body,
      });
      out.push({ ...draft, status: "sent", sentAt: new Date().toISOString() });
    } catch (e) {
      out.push({ ...draft, status: "failed", error: e instanceof Error ? e.message : String(e) });
    }
    await new Promise((r) => setTimeout(r, SEND_DELAY_MS));
  }
  return out;
}
