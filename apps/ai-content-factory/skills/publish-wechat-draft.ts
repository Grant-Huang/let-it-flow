/**
 * skill.publish_wechat_draft —— 把已生成的公众号长文推送到微信草稿箱。
 *
 * 流程（steps DSL）：
 *   1. markdown → HTML + sanitize
 *   2. 提取并上传正文图片（uploadimg）→ 替换为微信 URL
 *   3. 处理封面：coverImagePath → addMaterial，或直接用传入的 thumbMediaId
 *   4. HITL 确认门（requireConfirmation）：展示标题/字数/封面，用户批准后继续
 *   5. addDraft 推送到草稿箱 → 返回 evidence envelope（data.mediaId 即草稿 id）
 *
 * 安全策略：
 *   - risk: "write"（外部写入）
 *   - HITL 拒绝 → 抛错终止（绝不静默推送）
 *   - access_token / AppSecret 不入 narrate（仅中性进度消息）
 *
 * 参考文档：
 *   - https://developers.weixin.qq.com/doc/offiaccount/Draft_Box/Add_draft.html
 */
import { createSkill } from "../../../src/agent/skill-bridge.js";
import { wrapEvidence, type EvidenceEnvelope } from "../../../src/core/evidence-envelope.js";
import { narrate, narrateSummary } from "../../../src/core/narrate.js";
import { WechatClient, createWechatClientFromEnv } from "../lib/wechat/client.js";
import type { IWechatPublisher } from "../lib/wechat/types.js";
import {
  markdownToHtml,
  extractImageUrls,
  replaceImageUrls,
  sanitizeForWechat,
} from "../lib/wechat/markdown-to-html.js";
import { readFile as fsReadFile } from "node:fs/promises";
import { basename } from "node:path";

/** skill 业务输出（evidence envelope 的 data 部分）。 */
export interface PublishWechatDraftData {
  /** 草稿 media_id（可用于后续 get/delete/发布）。 */
  mediaId: string;
  /** 文章标题。 */
  title: string;
  /** HTML 正文字符数。 */
  contentChars: number;
  /** 封面 thumb_media_id。 */
  thumbMediaId: string;
  /** 正文图片数量。 */
  imageCount: number;
}

/** skill 完整输出类型（EvidenceEnvelope<PublishWechatDraftData>）。 */
export type PublishWechatDraftOutput = EvidenceEnvelope<PublishWechatDraftData>;

/** 工厂注入选项（测试用；生产从 env / fs 构造）。 */
export interface PublishWechatDraftOptions {
  /** 注入 mock publisher（测试用）；缺省从 process.env 构造真实 WechatClient。 */
  client?: IWechatPublisher;
  /** 注入 mock readFile（测试用）；缺省用 node:fs/promises.readFile。 */
  readFile?: (path: string) => Promise<Uint8Array>;
}

/**
 * 远程图片下载（仅当正文图是 http(s) URL 时需要上传到微信）。
 *
 * 注：当前实现聚焦本地/已知 URL 场景；远程图先用 fetch 抓取再 uploadContentImage。
 * 抓取失败则跳过该图（不阻断流程），并在 evidence.caveat 中标注。
 */
async function downloadRemoteImage(
  url: string,
  fetchImpl: typeof fetch,
): Promise<{ buffer: Uint8Array; filename: string } | undefined> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return undefined;
    const buf = new Uint8Array(await res.arrayBuffer());
    const filename = basename(new URL(url).pathname) || "image.png";
    return { buffer: buf, filename };
  } catch {
    return undefined;
  }
}

/**
 * 创建 publish_wechat_draft skill。
 *
 * 默认从 process.env.WECHAT_APP_ID / WECHAT_APP_SECRET 构造 client；
 * 测试可通过 opts.client 注入 mock。
 */
export function createPublishWechatDraftSkill(
  opts: PublishWechatDraftOptions = {},
) {
  // 延迟构造 client：仅在 skill 真正执行时读取 env（避免 import 时副作用；测试也无需 mock env）
  const getClient = (): IWechatPublisher => opts.client ?? createWechatClientFromEnv();
  const readFileImpl = opts.readFile ?? (async (p: string) => {
    const buf = await fsReadFile(p);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  });

  return createSkill({
    name: "skill.publish_wechat_draft",
    description: "把已生成的公众号长文（markdown）转换为微信草稿并推送到草稿箱（HITL 确认后推送）",
    whenToUse: {
      triggers: ["发布到公众号", "推送到草稿箱", "发布草稿", "上传到微信"],
      notFor: ["写公众号文章（走 write_wechat_article）", "群发消息（本 skill 仅入草稿箱）"],
    },
    inputSchema: {
      type: "object" as const,
      properties: {
        article: {
          type: "string",
          description: "已生成的公众号文章（markdown；来自 write_wechat_article）",
        },
        title: {
          type: "string",
          description: "文章标题（≤32 字符）",
        },
        thumbMediaId: {
          type: "string",
          description: "已有的封面永久素材 media_id（与 coverImagePath 二选一）",
        },
        coverImagePath: {
          type: "string",
          description: "封面图本地路径（上传后得到 thumb_media_id；与 thumbMediaId 二选一）",
        },
        author: { type: "string", description: "作者（≤16 字符，可选）" },
        digest: { type: "string", description: "摘要（≤128 字符，可选；不填取正文前 54 字）" },
        contentSourceUrl: { type: "string", description: "「阅读原文」URL（可选）" },
      },
      required: ["article", "title"],
    },
    outputSchema: {
      type: "object",
      properties: {
        mediaId: { type: "string", description: "草稿 media_id" },
      },
    },
    outputExample: {
      mediaId: "DRAFT_xxx",
    },
    risk: "write",

    async steps(input) {
      const { step, narrate: skillNarrate, narrateSummary: skillSummary } = input;
      const article = typeof input.article === "string" ? input.article : "";
      const title = typeof input.title === "string" ? input.title : "";
      const coverImagePath = typeof input.coverImagePath === "string" ? input.coverImagePath : "";
      const thumbMediaIdIn = typeof input.thumbMediaId === "string" ? input.thumbMediaId : "";
      const author = typeof input.author === "string" ? input.author : undefined;
      const digest = typeof input.digest === "string" ? input.digest : undefined;
      const contentSourceUrl = typeof input.contentSourceUrl === "string" ? input.contentSourceUrl : undefined;

      const client = getClient();

      await skillNarrate(`我来把这篇 ${article.length} 字的文章推送到微信草稿箱。`);

      // 校验：封面来源至少其一
      if (!coverImagePath && !thumbMediaIdIn) {
        throw new Error(
          "缺少封面图：请提供 coverImagePath（本地图片路径）或 thumbMediaId（已有永久素材 id）",
        );
      }

      // Step 1: markdown → HTML + sanitize
      const htmlStep = await step<string>("内容转换", async (ctx) => {
        await narrate(ctx, "正在把 markdown 转为微信 HTML…");
        const raw = markdownToHtml(article);
        const clean = sanitizeForWechat(raw);
        await narrate(ctx, `转换完成，HTML 约 ${clean.length} 字符。`);
        return clean;
      });

      let contentHtml = htmlStep;

      // Step 2: 提取并上传正文图片
      const imageUrls = extractImageUrls(contentHtml);
      if (imageUrls.length > 0) {
        const uploadStep = await step<Record<string, string>>("正文图上传", async (ctx) => {
          await narrate(ctx, `检测到 ${imageUrls.length} 张正文图片，正在上传到微信…`);
          const mapping: Record<string, string> = {};
          let idx = 0;
          for (const url of imageUrls) {
            idx++;
            await narrate(ctx, `上传图片 [${idx}/${imageUrls.length}]…`);
            try {
              // 仅 http(s) 远程图需要先下载；data: / 本地图此处暂不支持（write_wechat_article 产出的是远程 URL）
              if (/^https?:\/\//i.test(url)) {
                const fetched = await downloadRemoteImage(url, fetch);
                if (!fetched) {
                  await narrate(ctx, `图片 ${idx} 下载失败，跳过（将保留原图或被微信过滤）。`);
                  continue;
                }
                const r = await client.uploadContentImage(fetched.buffer, fetched.filename);
                mapping[url] = r.url;
              }
            } catch (e) {
              await narrate(ctx, `图片 ${idx} 上传失败：${e instanceof Error ? e.message : String(e)}（跳过）`);
            }
          }
          return mapping;
        });
        contentHtml = replaceImageUrls(contentHtml, uploadStep);
      }

      // Step 3: 处理封面图
      const coverStep = await step<string>("封面处理", async (ctx) => {
        if (thumbMediaIdIn) {
          await narrate(ctx, "使用传入的封面 thumbMediaId。");
          return thumbMediaIdIn;
        }
        await narrate(ctx, `正在上传封面图 ${coverImagePath}…`);
        const buf = await readFileImpl(coverImagePath);
        const filename = basename(coverImagePath) || "cover.png";
        const r = await client.addMaterial(buf, filename, "image");
        await narrate(ctx, "封面上传完成。");
        return r.mediaId;
      });

      const thumbMediaId = coverStep;

      // Step 4: HITL 确认门 —— 推送前必须用户确认
      const confirmStep = await step<boolean>("用户确认", async (ctx) => {
        const wordCount = article.length;
        const coverDesc = thumbMediaIdIn ? "传入的 thumbMediaId" : `本地图 ${coverImagePath}`;
        const decision = await ctx.requireConfirmation({
          prompt:
            `即将把以下内容推送到微信公众号草稿箱（不会群发）：\n` +
            `标题：${title}\n` +
            `字数：${wordCount}\n` +
            `封面：${coverDesc}\n` +
            `确认推送吗？`,
          options: ["approve", "reject"],
          detail: { tool: "skill.publish_wechat_draft", risk: "write" },
        });
        return decision.approved === true;
      });

      if (!confirmStep) {
        // 用户拒绝：抛错终止（addDraft 不会被调用，因为后续步骤不会执行）
        throw new Error("用户取消了推送，未发送到草稿箱");
      }

      // Step 5: 推送草稿
      const draftStep = await step<{ mediaId: string }>("推送草稿", async (ctx) => {
        await narrate(ctx, "正在推送到草稿箱…");
        const r = await client.addDraft({
          title,
          content: contentHtml,
          thumbMediaId,
          author,
          digest,
          contentSourceUrl,
        });
        await narrate(ctx, `推送成功，草稿 media_id：${r.mediaId}。`);
        return r;
      });

      await skillSummary(`草稿已推送到微信草稿箱（media_id：${draftStep.mediaId}）。`);

      const evidence = wrapEvidence(
        {
          mediaId: draftStep.mediaId,
          title,
          contentChars: contentHtml.length,
          thumbMediaId,
          imageCount: imageUrls.length,
        },
        {
          freshness: "realtime",
          confidence: "measured",
          system: "wechat",
          provenance: "skill.publish_wechat_draft",
          caveat: "仅入草稿箱，未群发；需在公众号后台手动发布",
        },
      );

      // 返回 evidence envelope：skill-bridge 会识别并展开，
      // 最终 output.data.mediaId 即草稿 id（附加 _skill 元信息）。
      return evidence;
    },
  });
}

/** 默认导出的 skill 实例（从 env 构造 client），供 boot.ts 注册。 */
export const publishWechatDraftSkill = createPublishWechatDraftSkill();
