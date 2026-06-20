/**
 * skill.write_wechat_article：基于已聚焦主线索撰写公众号长文。
 *
 * 公众号特点：
 *   - 二级标题（##）分段
 *   - 短段落、加粗重点、引用块
 *   - 目标 6500 字（默认），±10% 容差
 *   - 自校验字数 + section 数量
 */
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import { createSkill } from "../../../src/agent/skill-bridge.js";
import { wrapEvidence } from "../../../src/core/evidence-envelope.js";
import type { SkillStep, SkillConnector } from "../../../src/agent/skill-bridge.js";

const SYSTEM_PROMPT = `你是中文公众号长文撰稿人。遵守规范：

1. 二级标题（##）分段，5-7 个 section 为佳。
2. 段落短（3-5 句），避免大段密文。
3. 重点加粗（**...**），便于扫读。
4. 列表（- / 1.）用于罗列要点。
5. 引用块（> ...）用于直引信源。
6. 全文围绕 focusedThread 单一议题，narrative 决定行文逻辑。

输出 JSON：
{
  "article": "<完整 markdown 正文>",
  "sectionOutline": ["##标题1", "##标题2", ...],
  "citationList": ["..."]
}
不要外层 markdown 围栏。`;

interface ArticleOutput {
  article: string;
  sectionOutline: string[];
  citationList: string[];
  selfCheck: {
    targetWords: number;
    actualWords: number;
    sectionCount: number;
  };
}

export function createWriteWechatArticleSkill(getModel: () => LanguageModel): SkillConnector {
  const steps: SkillStep[] = [
    {
      description: "生成公众号长文",
      execute: async (_ctx, params) => {
        const targetWords = Number(params.targetWords ?? 6500);
        const narrative = String(params.narrativeReason ?? params.narrative ?? "");
        const focused = params.focusedThread as { oneLine?: string; evidence?: string } | undefined;
        const userPrompt = `主线索：${focused?.oneLine ?? "(空)"}
证据：${focused?.evidence ?? "(空)"}
叙事逻辑：${narrative}
目标字数：${targetWords}（±10%）

请输出 JSON。`;
        const { text } = await generateText({
          model: getModel(),
          system: SYSTEM_PROMPT,
          prompt: userPrompt,
        });
        return { text, targetWords };
      },
    },
    {
      description: "解析 + 自校验 + 包 envelope",
      execute: async (_ctx, _params, prior) => {
        const r = prior[0] as { text: string; targetWords: number };
        const parsed = safeJson<{
          article: string;
          sectionOutline: string[];
          citationList: string[];
        }>(r.text);
        const article = parsed.article ?? "";
        const actual = countChinese(article);
        const sections = (article.match(/^##\s/gm) ?? []).length;
        const output: ArticleOutput = {
          article,
          sectionOutline: parsed.sectionOutline ?? [],
          citationList: parsed.citationList ?? [],
          selfCheck: { targetWords: r.targetWords, actualWords: actual, sectionCount: sections },
        };
        const deviation = Math.abs(actual - r.targetWords) / r.targetWords;
        return wrapEvidence(output, {
          freshness: "realtime",
          confidence: deviation <= 0.1 ? "estimated" : "inferred",
          system: "llm",
          provenance: "skill.write_wechat_article",
          caveat:
            deviation > 0.1 ? `字数偏差 ${(deviation * 100).toFixed(1)}% 超过 10% 容差` : undefined,
        });
      },
    },
  ];

  return createSkill({
    name: "skill.write_wechat_article",
    description:
      "基于已聚焦主线索撰写公众号长文（默认 6500 字）。结构化为 ## 二级标题分段、重点加粗、列表/引用块。自校验字数 + section 数量。",
    whenToUse: {
      triggers: ["撰写公众号长文", "生成图文文章"],
      notFor: ["口播稿（用 skill.write_podcast_script）", "尚未聚焦主线索"],
    },
    inputSchema: {
      type: "object",
      properties: {
        focusedThread: { type: "object" },
        narrativeReason: { type: "string", description: "选定叙事的理由（供长文行文逻辑参考）" },
        targetWords: { type: "number", description: "目标字数，默认 6500" },
      },
      required: ["focusedThread"],
    },
    outputSchema: { type: "object", properties: { data: { type: "object" } } },
    outputExample: {
      data: { article: "## ...", sectionOutline: ["## 引子"], citationList: [], selfCheck: {} },
      confidence: "estimated",
    },
    steps,
  });
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
