/**
 * WechatClient 单元测试。
 *
 * 通过 vi.fn() mock globalThis.fetch，验证：
 *   - access_token 获取与中控缓存（命中不重复请求、过期刷新、并发去重）
 *   - uploadContentImage / addMaterial / addDraft 请求格式（URL / multipart / JSON）
 *   - 错误码处理：errcode!=0 抛 WechatApiException；40001 触发一次 token 刷新重试
 *
 * 不发起真实网络请求；fetch mock 按 url 前缀匹配并返回预设 Response。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WechatClient, __resetWechatTokenCache } from "../../../../apps/ai-content-factory/lib/wechat/client.js";
import { WechatApiException } from "../../../../apps/ai-content-factory/lib/wechat/types.js";

/** 构造一个 JSON Response。 */
function jsonRes(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** fetch 第一个参数的类型（避免直接引用 DOM 的 RequestInfo）。 */
type FetchInput = Parameters<typeof fetch>[0];
/** fetch 第二个参数的类型（RequestInit）。 */
type FetchInit = Parameters<typeof fetch>[1];

/** 记录 fetch 调用元信息的容器（每个 it 重置）。 */
let calls: Array<{ url: string; method: string; body?: string | FormData }>;
let fetchMock: ReturnType<typeof vi.fn>;

/** 仅保留 path 部分（去掉 API_BASE 前缀），便于断言用短前缀匹配。 */
function pathOf(url: string): string {
  return url.replace("https://api.weixin.qq.com", "");
}
/** 测试断言用：返回 calls 的 path 视图。 */
function callsByPath(): Array<{ path: string; method: string; body?: string | FormData }> {
  return calls.map((c) => ({ path: pathOf(c.url), method: c.method, body: c.body }));
}

beforeEach(() => {
  calls = [];
  __resetWechatTokenCache();
  fetchMock = vi.fn(async (input: FetchInput, init?: FetchInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | FormData | undefined });

    // access_token 接口
    if (url.startsWith("https://api.weixin.qq.com/cgi-bin/token")) {
      const q = new URL(url).searchParams;
      if (q.get("appid") === "BAD") {
        return jsonRes({ errcode: 40125, errmsg: "invalid appsecret" });
      }
      return jsonRes({ access_token: "TOKEN_A", expires_in: 7200 });
    }

    // uploadimg（正文图）
    if (url.startsWith("https://api.weixin.qq.com/cgi-bin/media/uploadimg")) {
      return jsonRes({ url: "https://mmbiz.qpic.cn/uploaded.png" });
    }

    // add_material（封面永久素材）
    if (url.startsWith("https://api.weixin.qq.com/cgi-bin/material/add_material")) {
      return jsonRes({ media_id: "MEDIA_123", url: "https://mmbiz.qpic.cn/cover.png" });
    }

    // draft/add
    if (url.startsWith("https://api.weixin.qq.com/cgi-bin/draft/add")) {
      return jsonRes({ media_id: "DRAFT_001" });
    }

    return jsonRes({ errcode: -999, errmsg: `unmocked ${url}` });
  });
  // 替换全局 fetch
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WechatClient", () => {
  const cfg = { appId: "wxabc", appSecret: "secret123" };

  describe("access_token 中控缓存", () => {
    it("首次调用 fetch token，后续命中缓存不再请求", async () => {
      const c = new WechatClient(cfg);
      const t1 = await c.getAccessToken();
      const t2 = await c.getAccessToken();
      expect(t1.value).toBe("TOKEN_A");
      expect(t2.value).toBe("TOKEN_A");
      // 只请求一次 token
      const tokenCalls = callsByPath().filter((c) => c.path.startsWith("/cgi-bin/token"));
      expect(tokenCalls).toHaveLength(1);
    });

    it("并发请求去重（同一 in-flight Promise，只发一次）", async () => {
      const c = new WechatClient(cfg);
      await Promise.all([c.getAccessToken(), c.getAccessToken(), c.getAccessToken()]);
      const tokenCalls = callsByPath().filter((c) => c.path.startsWith("/cgi-bin/token"));
      expect(tokenCalls).toHaveLength(1);
    });

    it("token 过期（expiresAt 已过）触发重新获取", async () => {
      const c = new WechatClient(cfg);
      // 注入一个已过期的缓存条目
      c.__setTokenCacheForTest({ value: "STALE", expiresAt: Date.now() - 1000 });
      const t = await c.getAccessToken();
      expect(t.value).toBe("TOKEN_A");
      const tokenCalls = callsByPath().filter((c) => c.path.startsWith("/cgi-bin/token"));
      expect(tokenCalls).toHaveLength(1);
    });
  });

  describe("uploadContentImage", () => {
    it("POST uploadimg，返回微信图片 URL", async () => {
      const c = new WechatClient(cfg);
      const buf = new Uint8Array([1, 2, 3]);
      const r = await c.uploadContentImage(buf, "pic.png");
      expect(r.url).toBe("https://mmbiz.qpic.cn/uploaded.png");
      const call = callsByPath().find((x) => x.path.startsWith("/cgi-bin/media/uploadimg"));
      expect(call?.method).toBe("POST");
      // access_token 附在 query
      expect(call?.path).toContain("access_token=TOKEN_A");
      // body 是 multipart FormData
      expect(call?.body).toBeInstanceOf(FormData);
    });
  });

  describe("addMaterial", () => {
    it("POST add_material?type=image，返回 mediaId + url", async () => {
      const c = new WechatClient(cfg);
      const r = await c.addMaterial(new Uint8Array([9, 9]), "cover.jpg", "image");
      expect(r.mediaId).toBe("MEDIA_123");
      expect(r.url).toBe("https://mmbiz.qpic.cn/cover.png");
      const call = callsByPath().find((x) => x.path.startsWith("/cgi-bin/material/add_material"));
      expect(call?.path).toContain("type=image");
      expect(call?.body).toBeInstanceOf(FormData);
    });
  });

  describe("addDraft", () => {
    it("POST draft/add，articles 数组 + 返回 mediaId", async () => {
      const c = new WechatClient(cfg);
      const r = await c.addDraft({
        title: "测试标题",
        content: "<p>hello</p>",
        thumbMediaId: "MEDIA_123",
      });
      expect(r.mediaId).toBe("DRAFT_001");
      const call = callsByPath().find((x) => x.path.startsWith("/cgi-bin/draft/add"));
      expect(call?.method).toBe("POST");
      expect(call?.path).toContain("access_token=TOKEN_A");
      const sent = JSON.parse(call?.body as string);
      expect(sent.articles[0].title).toBe("测试标题");
      expect(sent.articles[0].thumb_media_id).toBe("MEDIA_123");
      expect(sent.articles[0].article_type).toBe("news");
    });
  });

  describe("错误处理", () => {
    it("errcode != 0 抛 WechatApiException 并带 errcode/errmsg", async () => {
      const c = new WechatClient({ appId: "BAD", appSecret: "x" });
      await expect(c.getAccessToken()).rejects.toMatchObject({
        name: "WechatApiException",
        errcode: 40125,
      });
    });

    it("40001 token 失效：自动刷新一次 token 再重试", async () => {
      // 第一次 addDraft 返回 40001，第二次返回成功
      let addCallCount = 0;
      fetchMock.mockImplementation(async (input: FetchInput, init?: FetchInit) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | FormData | undefined });
        if (url.startsWith("https://api.weixin.qq.com/cgi-bin/token")) {
          return jsonRes({ access_token: `T_${calls.length}`, expires_in: 7200 });
        }
        if (url.startsWith("https://api.weixin.qq.com/cgi-bin/draft/add")) {
          addCallCount++;
          if (addCallCount === 1) return jsonRes({ errcode: 40001, errmsg: "invalid credential" });
          return jsonRes({ media_id: "DRAFT_RETRY_OK" });
        }
        return jsonRes({ errcode: -999, errmsg: "unmocked" });
      });

      const c = new WechatClient(cfg);
      const r = await c.addDraft({ title: "x", content: "y", thumbMediaId: "m" });
      expect(r.mediaId).toBe("DRAFT_RETRY_OK");
      // token 被请求两次（初次 + 40001 刷新）
      const tokenCalls = callsByPath().filter((x) => x.path.startsWith("/cgi-bin/token"));
      expect(tokenCalls.length).toBeGreaterThanOrEqual(2);
    });

    it("非 40001 的 errcode 不重试，直接抛错", async () => {
      fetchMock.mockImplementation(async (input: FetchInput, init?: FetchInit) => {
        const url = typeof input === "string" ? input : input.toString();
        calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | FormData | undefined });
        if (url.startsWith("https://api.weixin.qq.com/cgi-bin/token"))
          return jsonRes({ access_token: "T", expires_in: 7200 });
        if (url.startsWith("https://api.weixin.qq.com/cgi-bin/draft/add"))
          return jsonRes({ errcode: 45009, errmsg: "reach max api daily limit" });
        return jsonRes({ errcode: -999, errmsg: "unmocked" });
      });
      const c = new WechatClient(cfg);
      await expect(c.addDraft({ title: "x", content: "y", thumbMediaId: "m" })).rejects.toMatchObject({
        errcode: 45009,
      });
    });
  });
});
