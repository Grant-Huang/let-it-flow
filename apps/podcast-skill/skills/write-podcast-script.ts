/**
 * skill.write_podcast_script：基于已聚焦的主线索撰写口播稿。
 *
 * 写稿铁律（来自 KB / 写稿铁律/*）：
 *   - 字数公式：字数 ≈ durationMinutes × 210（±5% 容差）
 *   - 单句长度 ≤ 25 字
 *   - 术语过滤：通用术语（CEO/GDP/ChatGPT）不解释；小众代号必须解释
 *
 * 写完后做自校验，校验失败自动重写一遍（skill 内重试 1 次）。
 */
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import { createSkill } from "../../../src/agent/skill-bridge.js";
import { wrapEvidence } from "../../../src/core/evidence-envelope.js";
import type { SkillStep, SkillConnector } from "../../../src/agent/skill-bridge.js";

const SYSTEM_PROMPT = `你是中文播客主播口播稿撰稿人。严格遵守以下铁律：

1. 字数公式：分钟数 × 210（±5%），偏离即重写。
2. 单句长度 ≤ 25 字，逗号断句，节奏短促，便于口播。
3. 术语过滤：
   - 通用术语（CEO/GDP/ChatGPT/AI/IPO 等）不解释
   - 小众代号、专业缩略词出现时必须用一句话解释
4. 引用规范：单条引用 ≤ 30 字，标信源；同信源不反复直引。
5. 段落结构按 narrative 决定（开场→主线展开→收束）。
6. 不堆砌多条线索，全文围绕 focusedThread 单一议题。

输出 JSON：
{
  "script": "<完整稿件，含段落分隔 \\n\\n>",
  "segmentBreakdown": [{ "title": "...", "words": 0 }],
  "estimatedDurationMin": 0,
  "citationList": ["..."]
}
不要 markdown 围栏。`;

interface ScriptOutput {
  script: string;
  segmentBreakdown: Array<{ title: string; words: number }>;
  estimatedDurationMin: number;
  citationList: string[];
  selfCheck: {
    targetWords: number;
    actualWords: number;
    deviation: number;
    maxSentenceLen: number;
    retried: boolean;
  };
}

export function createWritePodcastScriptSkill(getModel: () => LanguageModel): SkillConnector {
  const steps: SkillStep[] = [
    {
      description: "首次生成口播稿",
      execute: async (_ctx, params) => {
        return await writeOnce(getModel(), params, null);
      },
    },
    {
      description: "字数/单句长度自校验，必要时重写",
      execute: async (_ctx, params, prior) => {
        const first = prior[0] as { text: string; targetWords: number; durationMin: number };
        const check = checkScript(first.text, first.targetWords);
        if (check.ok) {
          return { ...first, retried: false, check };
        }
        // 失败：附带修正指令重写
        const second = await writeOnce(getModel(), params, check);
        const recheck = checkScript(second.text, second.targetWords);
        return { ...second, retried: true, check: recheck };
      },
    },
    {
      description: "解析为结构化输出 + EvidenceEnvelope",
      execute: async (_ctx, _params, prior) => {
        const r = prior[1] as {
          text: string;
          targetWords: number;
          durationMin: number;
          retried: boolean;
          check: ReturnType<typeof checkScript>;
        };
        const parsed = safeJson<{
          script: string;
          segmentBreakdown: Array<{ title: string; words: number }>;
          estimatedDurationMin: number;
          citationList: string[];
        }>(r.text);
        const actualWords = countChinese(parsed.script);
        const output: ScriptOutput = {
          script: parsed.script,
          segmentBreakdown: parsed.segmentBreakdown ?? [],
          estimatedDurationMin: parsed.estimatedDurationMin ?? r.durationMin,
          citationList: parsed.citationList ?? [],
          selfCheck: {
            targetWords: r.targetWords,
            actualWords,
            deviation: (actualWords - r.targetWords) / r.targetWords,
            maxSentenceLen: r.check.maxLen,
            retried: r.retried,
          },
        };
        return wrapEvidence(output, {
          freshness: "realtime",
          confidence: r.check.ok ? "estimated" : "inferred",
          system: "llm",
          provenance: "skill.write_podcast_script",
          caveat: r.check.ok ? undefined : `自校验未完全通过：${r.check.reason}`,
        });
      },
    },
  ];

  return createSkill({
    name: "skill.write_podcast_script",
    description:
      "基于已聚焦的主线索撰写口播稿。严格遵守字数公式（分钟 × 210，±5%）+ 单句 ≤25 字 + 术语过滤铁律。内部自校验失败自动重写一遍。",
    whenToUse: {
      triggers: ["撰写播客口播稿", "生成节目稿件"],
      notFor: ["尚未聚焦主线索（先调 skill.thread_focuser）", "公众号长文（用 skill.write_wechat_article）"],
    },
    inputSchema: {
      type: "object",
      properties: {
        focusedThread: { type: "object", description: "skill.thread_focuser 输出的 selected 字段" },
        narrative: { type: "string", description: "叙事结构名（悬念驱动体 / 分析师独白体 / 简报体 / 双线对照体）" },
        durationMinutes: { type: "number", description: "目标节目时长（分钟）" },
        language: { type: "string", description: "稿件语言，默认 zh-CN" },
      },
      required: ["focusedThread", "narrative", "durationMinutes"],
    },
    outputSchema: { type: "object", properties: { data: { type: "object" } } },
    outputExample: {
      data: { script: "...", segmentBreakdown: [], estimatedDurationMin: 30, citationList: [], selfCheck: {} },
      confidence: "estimated",
    },
    steps,
  });
}

async function writeOnce(
  model: LanguageModel,
  params: Record<string, unknown>,
  fixHint: ReturnType<typeof checkScript> | null,
): Promise<{ text: string; targetWords: number; durationMin: number }> {
  const durationMin = Number(params.durationMinutes ?? 30);
  const targetWords = Math.round(durationMin * 210);
  const narrative = String(params.narrative ?? "分析师独白体");
  const focused = params.focusedThread as { oneLine?: string; evidence?: string } | undefined;
  const fixSection = fixHint
    ? `\n\n⚠️ 上一稿未通过自校验：${fixHint.reason}。请按目标字数 ${targetWords}（±5%）+ 单句 ≤25 字重写。`
    : "";

  const userPrompt = `主线索：${focused?.oneLine ?? "(空)"}
证据：${focused?.evidence ?? "(空)"}
叙事结构：${narrative}
目标时长：${durationMin} 分钟（${targetWords} 字 ±5%）${fixSection}

请输出 JSON。`;

  const { text } = await generateText({
    model,
    system: SYSTEM_PROMPT,
    prompt: userPrompt,
  });
  return { text, targetWords, durationMin };
}

function checkScript(text: string, targetWords: number): { ok: boolean; reason: string; maxLen: number } {
  const parsed = tryParse(text);
  if (!parsed) return { ok: false, reason: "稿件无法解析为 JSON", maxLen: 0 };
  const script = parsed.script ?? "";
  const actual = countChinese(script);
  const deviation = Math.abs(actual - targetWords) / targetWords;
  const sentences = script.split(/[。！？\n]/).filter((s) => s.trim());
  const maxLen = sentences.reduce((max, s) => Math.max(max, countChinese(s.trim())), 0);
  if (deviation > 0.05) {
    return { ok: false, reason: `字数偏差 ${(deviation * 100).toFixed(1)}%（目标 ${targetWords}，实际 ${actual}）`, maxLen };
  }
  if (maxLen > 25) {
    return { ok: false, reason: `存在超长单句（${maxLen} 字）`, maxLen };
  }
  return { ok: true, reason: "", maxLen };
}

function tryParse(text: string): { script?: string } | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as { script?: string };
  } catch {
    return null;
  }
}

function safeJson<T>(text: string): T {
  const m = text.match(/\{[\s\S]*\}/);
  const raw = m ? m[0] : text;
  try {
    return JSON.parse(raw) as T;
  } catch (e) {
    throw new Error(`LLM 返回非合法 JSON：${e instanceof Error ? e.message : String(e)}`);
  }
}

function countChinese(s: string): number {
  return [...s].filter((c) => /[一-鿿]/.test(c)).length;
}
