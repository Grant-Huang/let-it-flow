/**
 * publish-wechat-draft skill 单测。
 *
 * 通过工厂注入 mock client / mock readFile / mock ctx，验证：
 *   - 成功路径：markdown 转 HTML → 上传正文图替换 → 上传封面 → HITL 确认 → addDraft 返回 mediaId
 *   - HITL 拒绝：不调用 addDraft，skill 抛错（被 step 捕获记入 errors）
 *   - 无图片时跳过上传图片
 *   - 用 thumbMediaId 时跳过封面上传
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPublishWechatDraftSkill } from "../../../../apps/ai-content-factory/skills/publish-wechat-draft.js";
import type { FlowConnector, ToolResult } from "../../../../src/tools/base.js";

/** 极简 mock client：所有方法都是 vi.fn，可在 it 内 setResolvedValue。 */
function mockClient() {
  return {
    uploadContentImage: vi.fn(async (_buf: Uint8Array, _name: string) => ({
      url: "https://mmbiz.qpic.cn/uploaded.png",
    })),
    addMaterial: vi.fn(async (_buf: Uint8Array, _name: string) => ({
      mediaId: "MEDIA_COVER",
      url: "https://mmbiz.qpic.cn/cover.png",
    })),
    addDraft: vi.fn(async () => ({ mediaId: "DRAFT_MID" })),
  };
}

/** mock ExecutionContext（DSL 需要 emit/requireConfirmation/resolveTool）。 */
function mockCtx(opts: { approved: boolean }) {
  return {
    taskId: "t",
    runId: "r",
    nodeId: "n",
    intent: "",
    emit: vi.fn(async () => ({})),
    requireConfirmation: vi.fn(async () => ({ approved: opts.approved })),
    resolveRef: () => undefined,
    resolveTool: () => undefined,
  } as unknown as Parameters<FlowConnector["execute"]>[1];
}

/** 消费 skill execute generator，取最终 ToolResult + 事件。 */
async function runSkill(
  skill: FlowConnector,
  args: Record<string, unknown>,
  ctx: Parameters<FlowConnector["execute"]>[1],
): Promise<{ final: ToolResult | undefined }> {
  const gen = skill.execute(args, ctx);
  let final: ToolResult | undefined;
  while (true) {
    const r = await gen.next();
    if (r.done) {
      final = r.value;
      break;
    }
  }
  return { final };
}

describe("publish_wechat_draft skill", () => {
  beforeEach(() => {
    process.env.WECHAT_APP_ID = "wx_test";
    process.env.WECHAT_APP_SECRET = "secret";
    // mock fetch：skill 内 downloadRemoteImage 用它下载正文图
    (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://a.com/x.png") {
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("成功路径：转 HTML → 上传正文图 → 上传封面 → HITL 确认 → addDraft 返回 mediaId", async () => {
    const client = mockClient();
    const readFile = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const skill = createPublishWechatDraftSkill({ client, readFile });
    const ctx = mockCtx({ approved: true });

    const { final } = await runSkill(
      skill,
      {
        article: "## 标题\n\n![alt](https://a.com/x.png)\n\n正文。",
        title: "测试文章",
        coverImagePath: "/tmp/cover.jpg",
      },
      ctx,
    );

    // 正文图被上传
    expect(client.uploadContentImage).toHaveBeenCalledOnce();
    // 封面被上传
    expect(client.addMaterial).toHaveBeenCalledOnce();
    // HITL 被调用
    expect(ctx.requireConfirmation).toHaveBeenCalledOnce();
    // addDraft 被调用
    expect(client.addDraft).toHaveBeenCalledOnce();
    // 返回 mediaId
    const output = final?.output as { data: { mediaId?: string } };
    expect(output.data.mediaId).toBe("DRAFT_MID");
  });

  it("HITL 拒绝时不推送草稿", async () => {
    const client = mockClient();
    const readFile = vi.fn(async () => new Uint8Array([1]));
    const skill = createPublishWechatDraftSkill({ client, readFile });
    const ctx = mockCtx({ approved: false });

    // skill 内部 HITL 拒绝后会抛错（被 step DSL 捕获记入 errors）
    await runSkill(
      skill,
      { article: "无图正文", title: "x", thumbMediaId: "M_PRESET" },
      ctx,
    );

    // 关键断言：拒绝时绝不调用 addDraft
    expect(client.addDraft).not.toHaveBeenCalled();
  });

  it("无图片时跳过正文图上传", async () => {
    const client = mockClient();
    const readFile = vi.fn(async () => new Uint8Array([1]));
    const skill = createPublishWechatDraftSkill({ client, readFile });
    const ctx = mockCtx({ approved: true });

    await runSkill(
      skill,
      { article: "纯文本，无图。", title: "无图文章", thumbMediaId: "M_PRESET" },
      ctx,
    );

    expect(client.uploadContentImage).not.toHaveBeenCalled();
    // thumbMediaId 已给，跳过封面上传
    expect(client.addMaterial).not.toHaveBeenCalled();
    // 仍推送草稿
    expect(client.addDraft).toHaveBeenCalledOnce();
  });

  it("既无 coverImagePath 也无 thumbMediaId 时抛错", async () => {
    const client = mockClient();
    const readFile = vi.fn();
    const skill = createPublishWechatDraftSkill({ client, readFile });
    const ctx = mockCtx({ approved: true });

    const { final } = await runSkill(
      skill,
      { article: "正文", title: "x" },
      ctx,
    );

    // 无封面来源：skill 应失败，addDraft 不调用
    expect(client.addDraft).not.toHaveBeenCalled();
    // skill output 应包含 errors
    const output = final?.output as { data: { _skill?: { errors?: string[] } } };
    expect(output.data._skill?.errors?.length ?? 0).toBeGreaterThan(0);
  });
});
