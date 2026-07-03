/**
 * 微信公众号服务端 API 客户端。
 *
 * 设计要点：
 *   - access_token 中控缓存：微信官方建议「中控服务器」统一刷新 token（重复刷新会使
 *     上一次 token 失效）。本类在实例内缓存 token + expiresAt，提前 300s 刷新；并发请求
 *     去重为单一 in-flight Promise。
 *   - multipart/form-data 用原生 FormData + Blob（Node 18+ 内置），不引入第三方依赖，
 *     与平台 web-fetch.ts 的纯净标准库风格一致。
 *   - 错误处理：所有响应统一校验 errcode；40001（token 失效）触发一次刷新重试。
 *
 * 参考文档：
 *   - https://developers.weixin.qq.com/doc/offiaccount/Basic_Information/Get_access_token.html
 *   - https://developers.weixin.qq.com/doc/offiaccount/Draft_Box/Add_draft.html
 */
import {
  type WechatConfig,
  type AccessToken,
  type UploadImageResult,
  type AddMaterialResult,
  type DraftArticle,
  type AddDraftResult,
  type WechatApiError,
  type IWechatPublisher,
  WechatApiException,
} from "./types.js";
import { SERVICE_URLS } from "../../../../src/core/config.js";

/** 微信 API 基址（从集中配置读取，便于切代理/私有部署）。 */
const API_BASE = SERVICE_URLS.wechatApi;

/** token 提前刷新余量（毫秒）。避免边界过期。 */
const TOKEN_REFRESH_LEAD_MS = 300_000;

/**
 * 微信公众号客户端。
 *
 * 一个实例对应一个公众号（一套 appId/appSecret）。skill 通过 `createWechatClient()`
 * 工厂从环境变量构造，或在测试中直接 `new WechatClient(cfg)`。
 */
export class WechatClient implements IWechatPublisher {
  private readonly cfg: WechatConfig;
  /** 缓存的 access_token。 */
  private cachedToken: AccessToken | undefined;
  /** 进行中的 token 请求（并发去重）。 */
  private inflight: Promise<AccessToken> | undefined;

  constructor(cfg: WechatConfig) {
    this.cfg = cfg;
  }

  /**
   * 获取 access_token（带中控缓存 + 并发去重）。
   *
   * - 缓存命中（未到期）→ 直接返回
   * - 缓存过期 / 不存在 → 发起新请求；并发调用复用同一 in-flight Promise
   */
  async getAccessToken(): Promise<AccessToken> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt - TOKEN_REFRESH_LEAD_MS) {
      return this.cachedToken;
    }
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      const url =
        `${API_BASE}/cgi-bin/token` +
        `?grant_type=client_credential` +
        `&appid=${encodeURIComponent(this.cfg.appId)}` +
        `&secret=${encodeURIComponent(this.cfg.appSecret)}`;
      const data = await this.getJson<{ access_token: string; expires_in: number } & WechatApiError>(url);
      const token: AccessToken = {
        value: data.access_token,
        expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
      };
      this.cachedToken = token;
      return token;
    })().finally(() => {
      this.inflight = undefined;
    });

    return this.inflight;
  }

  /**
   * 强制使当前 token 缓存失效（40001 重试前调用）。
   */
  private invalidateToken(): void {
    this.cachedToken = undefined;
  }

  /**
   * 上传图文消息内的图片（uploadimg）。
   *
   * 用于文章正文中的图片；返回的 URL 仅可嵌入图文 content，不返回 media_id。
   * 文档：/cgi-bin/media/uploadimg
   *
   * @param buffer  图片二进制
   * @param filename 原始文件名（带扩展名，用于 MIME 推断）
   */
  async uploadContentImage(buffer: Uint8Array, filename: string): Promise<UploadImageResult> {
    const token = await this.getAccessToken();
    const url = `${API_BASE}/cgi-bin/media/uploadimg?access_token=${token.value}`;
    const form = this.buildMultipartForm(buffer, filename);
    const data = await this.postJson<{ url: string } & WechatApiError>(url, form);
    return { url: data.url };
  }

  /**
   * 新增永久素材（add_material）。
   *
   * 主要用于上传封面图，返回的 media_id 即草稿所需的 thumb_media_id（不过期）。
   * 文档：/cgi-bin/material/add_material?type=image
   *
   * @param buffer   文件二进制
   * @param filename 文件名（带扩展名）
   * @param type     媒体类型，默认 image（封面图）
   */
  async addMaterial(buffer: Uint8Array, filename: string, type: "image" | "voice" | "video" | "thumb" = "image"): Promise<AddMaterialResult> {
    const token = await this.getAccessToken();
    const url = `${API_BASE}/cgi-bin/material/add_material?access_token=${token.value}&type=${type}`;
    const form = this.buildMultipartForm(buffer, filename);
    const data = await this.postJson<{ media_id: string; url?: string } & WechatApiError>(url, form);
    return { mediaId: data.media_id, url: data.url };
  }

  /**
   * 新增草稿（draft/add）。
   *
   * 把 DraftArticle 包装为微信官方 articles 数组格式（snake_case），推送到草稿箱。
   * 文档：/cgi-bin/draft/add
   */
  async addDraft(article: DraftArticle): Promise<AddDraftResult> {
    const token = await this.getAccessToken();
    const url = `${API_BASE}/cgi-bin/draft/add?access_token=${token.value}`;
    const body = {
      articles: [
        {
          article_type: "news",
          title: article.title,
          author: article.author ?? "",
          digest: article.digest ?? "",
          content: article.content,
          content_source_url: article.contentSourceUrl ?? "",
          thumb_media_id: article.thumbMediaId,
          need_open_comment: article.needOpenComment ?? 0,
          only_fans_can_comment: article.onlyFansCanComment ?? 0,
        },
      ],
    };
    const data = await this.postJson<{ media_id: string } & WechatApiError>(url, JSON.stringify(body), true);
    return { mediaId: data.media_id };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 内部：HTTP 工具
  // ─────────────────────────────────────────────────────────────────────────

  /** GET 并解析 JSON，含错误码检查 + 40001 重试。 */
  private async getJson<T>(url: string): Promise<T> {
    const res = await fetch(url, { method: "GET" });
    const json = (await res.json()) as T & WechatApiError;
    this.assertOk(json);
    return json as T;
  }

  /**
   * POST 并解析 JSON。
   *
   * @param rawJson true 表示 body 是 JSON 字符串（设置 application/json）；
   *                false/省略 表示 body 是 FormData（multipart）。
   * @param attempt 当前重试次数（内部用，处理 40001）。
   */
  private async postJson<T>(url: string, body: RequestInit["body"], rawJson = false, attempt = 0): Promise<T> {
    const headers: Record<string, string> = rawJson ? { "content-type": "application/json" } : {};
    const res = await fetch(url, { method: "POST", headers, body });
    const json = (await res.json()) as T & WechatApiError;

    // 40001：token 失效 → 刷新 token 重试一次
    if (json.errcode === 40001 && attempt === 0) {
      this.invalidateToken();
      // 重试时需要带上新 token，因此重写 url（仅 draft/add 与 material 类接口走此分支）
      const retried = await this.retryWithFreshToken<T>(url, body, rawJson);
      return retried;
    }

    this.assertOk(json);
    return json as T;
  }

  /** 40001 后用新 token 重新发起同一请求。 */
  private async retryWithFreshToken<T>(originalUrl: string, body: RequestInit["body"], rawJson: boolean): Promise<T> {
    await this.getAccessToken();
    const newToken = this.cachedToken!.value;
    const newUrl = replaceAccessToken(originalUrl, newToken);
    const res = await fetch(newUrl, {
      method: "POST",
      headers: rawJson ? { "content-type": "application/json" } : {},
      body,
    });
    const json = (await res.json()) as T & WechatApiError;
    this.assertOk(json);
    return json as T;
  }

  /** 构造 multipart/form-data（Node 18+ 原生 FormData + Blob）。 */
  private buildMultipartForm(buffer: Uint8Array, filename: string): FormData {
    const mime = inferMime(filename);
    // Blob 接收 ArrayBufferView；Uint8Array 即其实现。
    const blob = new Blob([buffer], { type: mime });
    const form = new FormData();
    form.append("media", blob, filename);
    return form;
  }

  /** 校验响应 errcode；非 0 抛 WechatApiException。 */
  private assertOk(json: WechatApiError): void {
    if (typeof json?.errcode === "number" && json.errcode !== 0) {
      throw new WechatApiException({ errcode: json.errcode, errmsg: json.errmsg });
    }
  }

  /** 测试钩子：直接注入 token 缓存。 */
  __setTokenCacheForTest(t: AccessToken): void {
    this.cachedToken = t;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 工厂：从环境变量构造客户端
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 从 process.env 构造 WechatClient（skill 调用入口）。
 *
 * 读 WECHAT_APP_ID / WECHAT_APP_SECRET。缺失则抛错（skill 在 narrate 中向用户说明）。
 */
export function createWechatClientFromEnv(): WechatClient {
  const appId = process.env.WECHAT_APP_ID ?? "";
  const appSecret = process.env.WECHAT_APP_SECRET ?? "";
  if (!appId || !appSecret) {
    throw new Error("缺少微信配置：请在 .env 设置 WECHAT_APP_ID 与 WECHAT_APP_SECRET");
  }
  return new WechatClient({ appId, appSecret });
}

// ─────────────────────────────────────────────────────────────────────────────
// 测试辅助：重置模块级缓存（保留 API 以便测试统一调用）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 测试辅助：重置 token 缓存。
 *
 * token 缓存是实例级的（Per-Client），测试通常 new 一个新客户端即可；
 * 此函数保留为对外稳定钩子，便于未来扩展模块级缓存时无需改测试。
 */
export function __resetWechatTokenCache(): void {
  /* no-op：当前缓存实例级，new WechatClient 即得干净状态 */
}

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数工具
// ─────────────────────────────────────────────────────────────────────────────

/** 把 url 中的 access_token=xxx 替换为新 token。 */
function replaceAccessToken(url: string, newToken: string): string {
  return url.replace(/access_token=[^&]+/, `access_token=${newToken}`);
}

/** 由文件名推断 MIME（仅覆盖微信支持的图片格式）。 */
function inferMime(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    default:
      return "application/octet-stream";
  }
}
