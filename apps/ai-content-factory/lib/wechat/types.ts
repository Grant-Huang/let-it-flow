/**
 * 微信公众号 API 类型定义。
 *
 * 对应微信「服务端 API」草稿箱 + 素材管理相关接口的字段契约。
 * 参考文档：
 *   - 获取 access_token：https://developers.weixin.qq.com/doc/offiaccount/Basic_Information/Get_access_token.html
 *   - 新增永久素材：https://developers.weixin.qq.com/doc/offiaccount/Asset_Management/Adding_Permanent_Asset.html
 *   - 上传图文消息内图片：https://developers.weixin.qq.com/doc/offiaccount/Asset_Management/Adding_Permanent_Asset.html
 *   - 新增草稿：https://developers.weixin.qq.com/doc/offiaccount/Draft_Box/Add_draft.html
 */

/** 微信客户端配置（从公众号后台「设置与开发」获取）。 */
export interface WechatConfig {
  /** 公众号 AppID（账号唯一凭证）。 */
  appId: string;
  /** 公众号 AppSecret（唯一凭证密钥；仅服务端持有，禁止落入前端/日志）。 */
  appSecret: string;
}

/** access_token 缓存条目。微信 token 有效期 7200 秒。 */
export interface AccessToken {
  /** token 字符串。 */
  value: string;
  /** 绝对过期时间戳（毫秒）。= 获取时 Date.now() + expires_in*1000。 */
  expiresAt: number;
}

/** uploadimg（图文消息内图片）返回。仅返回可嵌入 content 的 URL，无 media_id。 */
export interface UploadImageResult {
  url: string;
}

/** add_material（永久素材）返回。图片类型会同时返回 media_id 与可外链的 url。 */
export interface AddMaterialResult {
  /** 永久素材 media_id（用作草稿 thumb_media_id；不过期）。 */
  mediaId: string;
  /** 图片素材 URL（仅图片类型返回；腾讯系域名内可用）。 */
  url?: string;
}

/**
 * 草稿箱单篇 articles 条目（draft/add 的 articles 数组元素）。
 *
 * 字段对齐微信官方 schema：
 *   - article_type 缺省为 "news"（图文消息），这里固定 news，不暴露 newspic。
 *   - title 必填（≤32 字符）；content 必填（支持 HTML，≤2 万字符 / 1M）。
 *   - thumb_media_id 为 news 必填（封面永久素材 id）。
 */
export interface DraftArticle {
  title: string;
  /** HTML 内容（图片 URL 必须来自 uploadimg 返回的微信域名）。 */
  content: string;
  /** 封面永久素材 media_id。 */
  thumbMediaId: string;
  /** 作者（≤16 字符）。 */
  author?: string;
  /** 摘要（≤128 字符；不填则微信取正文前 54 字）。 */
  digest?: string;
  /** 「阅读原文」跳转 URL（≤1KB）。 */
  contentSourceUrl?: string;
  /** 是否打开评论，0 不打开（默认）/ 1 打开。 */
  needOpenComment?: 0 | 1;
  /** 是否仅粉丝可评论，0 所有人（默认）/ 1 仅粉丝。 */
  onlyFansCanComment?: 0 | 1;
}

/** draft/add 返回。media_id 即草稿 id（可用于后续 get/delete/update）。 */
export interface AddDraftResult {
  mediaId: string;
}

/**
 * 微信发布能力接口（skill 依赖的抽象）。
 *
 * WechatClient 实现此接口；测试可注入仅含这三个方法的 mock 对象。
 * 仅暴露 skill.publish_wechat_draft 用到的方法，遵循接口隔离原则。
 */
export interface IWechatPublisher {
  uploadContentImage(buffer: Uint8Array, filename: string): Promise<UploadImageResult>;
  addMaterial(
    buffer: Uint8Array,
    filename: string,
    type?: "image" | "voice" | "video" | "thumb",
  ): Promise<AddMaterialResult>;
  addDraft(article: DraftArticle): Promise<AddDraftResult>;
}

/** 微信 API 错误响应（绝大多数接口失败都返回 { errcode, errmsg }）。 */
export interface WechatApiError {
  errcode: number;
  errmsg: string;
}

/**
 * 微信 API 调用异常。
 *
 * 把微信的 { errcode, errmsg } 包成 JS Error，方便 skill / 上层 try/catch。
 * 常见 errcode：
 *   - 0：成功
 *   - -1：系统繁忙（可重试）
 *   - 40001：access_token 失效或不合法（需刷新 token 后重试一次）
 *   - 40007：不合法的媒体文件 id（media_id 非本公众号生成或已删除）
 *   - 45009：接口调用频率超限
 */
export class WechatApiException extends Error {
  readonly errcode: number;
  readonly errmsg: string;
  /** 微信请求 rid（便于排查，可缺省）。 */
  readonly rid?: string;

  constructor(err: WechatApiError, rid?: string) {
    super(`[wechat ${err.errcode}] ${err.errmsg}${rid ? ` (rid: ${rid})` : ""}`);
    this.name = "WechatApiException";
    this.errcode = err.errcode;
    this.errmsg = err.errmsg;
    if (rid) this.rid = rid;
  }
}
