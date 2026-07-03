/**
 * 前端 UI 常量集中配置（web/ 内核前端）。
 *
 * 把散落在组件中的魔法数字（Toast 超时、轮询间隔、动画时长等）收敛到一处，
 * 便于统一调整 + 注释说明业务含义。
 *
 * 注：Node 端配置走 src/core/config.ts；前端独立，不引 Node 模块。
 */
export const UI_CONSTANTS = {
  /**
   * Toast 自动消失延迟（毫秒）。
   *
   * 业务含义：用户看到成功/错误提示后，3 秒通常足够读完一句话，
   * 太短错过信息，太长遮挡内容。如需更长（如带操作按钮的 Toast），
   * 调用方应在 toast() 时单独传入覆盖。
   */
  toastAutoDismissMs: 3000,
} as const;
