/**
 * 加拿大橱柜报价线索抓取 + 询价邮件 —— 共享类型定义。
 */

export interface Lead {
  id: string;
  companyName: string;
  contactName?: string;
  email: string;
  phone?: string;
  city?: string;
  province?: string;
  website: string;
  sourceUrl: string;
  foundAt: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface DesignRequirements {
  /** 自由文本形式的需求摘要（尺寸/风格/材质/预算/工期/城市等），由聊天助手逐步整理。 */
  summary: string;
}

export interface EmailDraft {
  id: string;
  leadId: string;
  to: string;
  subject: string;
  body: string;
  status: "draft" | "sent" | "failed" | "skipped";
  error?: string;
  sentAt?: string;
}
