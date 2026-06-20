/**
 * skill.thread_focuser：从素材中识别"能独立撑起一期"的线索，聚焦到单一主线索。
 *
 * 设计纪律：
 *   - 1 条线索 → 直接选
 *   - ≥2 条且无 focusHint → 输出 needsUserChoice 字段（主 ReAct 看到后调 ask_user_choice 反问）
 *   - 同步推断 contentType（rigorous | comprehensive）
 *
 * 输出 EvidenceEnvelope：provenance="skill.thread_focuser"。
 */
import { generateText } from "ai";
import type { LanguageModel } from "ai";
import { createSkill } from "../../../src/agent/skill-bridge.js";
import { wrapEvidence } from "../../../src/core/evidence-envelope.js";
import type { SkillStep, SkillConnector } from "../../../src/agent/skill-bridge.js";

/** 单条候选线索。 */
interface Thread {
  id: string;
  oneLine: string;
  evidence: string;
  argumentDepth: number; // 0-10
}

interface FocuserOutput {
  selected: Thread | null;
  discarded: Thread[];
  needsUserChoice: boolean;
  options?: Array<{ id: string; label: string }>;
  contentType: "rigorous" | "comprehensive";
  rationale: string;
}

const SYSTEM_PROMPT = `你是播客内容策划助手。给定一批素材，识别能独立撑起一期节目的"主线索"。

输出 JSON：
{
  "threads": [{ "id": "t1", "oneLine": "...", "evidence": "...", "argumentDepth": 0-10 }],
  "contentType": "rigorous" | "comprehensive",
  "rationale": "<2 句话说明>"
}

规则：
- argumentDepth：该线索能展开多少独立分析（10=可单期深挖，<5=只够一段）
- contentType：素材偏理论/分析 → rigorous；偏综述/盘点 → comprehensive
- 严禁把多条独立线索混编成"综合"——宁可少做也不堆砌
- 直接返回 JSON，不要 markdown 围栏`;

export function createThreadFocuserSkill(getModel: () => LanguageModel): SkillConnector {
  const steps: SkillStep[] = [
    {
      description: "LLM 抽取候选线索",
      execute: async (_ctx, params) => {
        const sourceText = String(params.sourceText ?? "");
        if (!sourceText.trim()) {
          throw new Error("sourceText 为空，无法抽取线索");
        }
        const { text } = await generateText({
          model: getModel(),
          system: SYSTEM_PROMPT,
          prompt: `素材：\n${sourceText}\n\n请输出 JSON。`,
        });
        const parsed = safeJson<{
          threads: Thread[];
          contentType: "rigorous" | "comprehensive";
          rationale: string;
        }>(text);
        return parsed;
      },
    },
    {
      description: "选定单一主线索（或抛 HITL 选项）",
      execute: async (_ctx, params, prior) => {
        const step1 = prior[0] as {
          threads: Thread[];
          contentType: "rigorous" | "comprehensive";
          rationale: string;
        };
        const focusHint = typeof params.focusHint === "string" ? params.focusHint.trim() : "";
        const threads = step1.threads ?? [];

        let selected: Thread | null = null;
        let needsUserChoice = false;
        let options: Array<{ id: string; label: string }> | undefined;

        if (threads.length === 0) {
          throw new Error("无可用线索：素材内容不足以撑起一期");
        }

        if (threads.length === 1) {
          selected = threads[0] ?? null;
        } else if (focusHint) {
          const hit = threads.find(
            (t) => t.oneLine.includes(focusHint) || t.id === focusHint,
          );
          selected = hit ?? threads[0] ?? null;
        } else {
          // 显著差距判定：第 1 名 argumentDepth - 第 2 名 ≥ 3 直接选
          const sorted = [...threads].sort((a, b) => b.argumentDepth - a.argumentDepth);
          const first = sorted[0];
          const second = sorted[1];
          if (
            first &&
            second &&
            first.argumentDepth - second.argumentDepth >= 3
          ) {
            selected = first;
          } else {
            needsUserChoice = true;
            options = threads.map((t) => ({ id: t.id, label: t.oneLine }));
          }
        }

        const output: FocuserOutput = {
          selected,
          discarded: threads.filter((t) => t.id !== selected?.id),
          needsUserChoice,
          ...(options ? { options } : {}),
          contentType: step1.contentType,
          rationale: step1.rationale,
        };
        return output;
      },
    },
    {
      description: "包成 EvidenceEnvelope",
      execute: async (_ctx, _params, prior) => {
        const focused = prior[1] as FocuserOutput;
        return wrapEvidence(focused, {
          freshness: "realtime",
          confidence: focused.selected ? "estimated" : "inferred",
          system: "llm",
          provenance: "skill.thread_focuser",
          caveat: focused.needsUserChoice
            ? "存在多条独立线索，需用户选择后续跑"
            : undefined,
        });
      },
    },
  ];

  return createSkill({
    name: "skill.thread_focuser",
    description:
      "从素材中识别能独立撑起一期节目的主线索。当只有 1 条时直接选；当 ≥2 条且无 focusHint 时返回 needsUserChoice=true + options，主循环应调 ask_user_choice 反问。",
    whenToUse: {
      triggers: [
        "素材有多条线索需要聚焦",
        "决定本期播客的核心议题",
        "判断该期主题是 rigorous 还是 comprehensive",
      ],
      notFor: [
        "已明确选定线索（直接调 skill.write_podcast_script）",
        "尚未检索素材（先调 core.web_search / core.web_fetch）",
      ],
    },
    inputSchema: {
      type: "object",
      properties: {
        sourceText: { type: "string", description: "已检索/抓取的素材全文（多段拼接）" },
        focusHint: { type: "string", description: "可选：用户提示的聚焦角度关键词" },
        durationMinutes: { type: "number", description: "可选：目标节目时长（分钟）" },
      },
      required: ["sourceText"],
    },
    outputSchema: {
      type: "object",
      properties: {
        data: { type: "object" },
        confidence: { type: "string" },
      },
    },
    outputExample: {
      data: {
        selected: { id: "t1", oneLine: "G7 AI 治理框架", evidence: "...", argumentDepth: 8 },
        discarded: [],
        needsUserChoice: false,
        contentType: "rigorous",
        rationale: "单一深度议题，适合分析师独白",
      },
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
    throw new Error(
      `LLM 返回非合法 JSON：${e instanceof Error ? e.message : String(e)}；原文片段：${text.slice(0, 200)}`,
    );
  }
}
