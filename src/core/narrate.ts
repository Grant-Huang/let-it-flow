/**
 * 流式叙述 helper（Claude Code 风格）。
 *
 * 让 skill / tool 在执行耗时操作时，把"正在做什么"以人类可读文本实时发到 SSE 流，
 * 用户在对话窗口能看到进度，而不是静默到 tool_result 才一次性吐结果。
 *
 * 设计要点：
 *   - 直接走 ctx.emit → SSE，**绕过 skill-bridge 的 pendingEvents 批量队列**，保证实时。
 *   - 文本规范见 docs/20-narrative-output-rules.md：第一人称、动词开头、≤50 字、
 *     进行中用"…"，完成用"。"。
 *
 * 三种发射器签名都被支持：
 *   - skill 的 StepCtx（含 emit: ExecutionContext["emit"]）
 *   - 工具的 ExecutionContext（含 emit）
 *   - 扩展后的 StepsInput.narrate（skill 级叙述，step 外使用）
 */
import type { ToolEvent } from "./stream-events.js";

/** 任何含 emit 字段的对象（StepCtx / ExecutionContext 均满足）。 */
interface EmitHolder {
  // emit 入参用 ToolEvent；测试 mock 可用更宽的类型（结构兼容即可）
  emit: (event: ToolEvent) => Promise<unknown>;
}

/**
 * 发射一条进行中叙述（Claude Code 风格"正在…"）。
 *
 * @example
 * await narrate(ctx, "正在从知识库取写稿铁律…");
 */
export function narrate(ctx: EmitHolder, text: string): Promise<unknown> {
  return ctx.emit({
    type: "text",
    channel: "content",
    payload: { delta: text },
  });
}

/**
 * 发射一条完成叙述（Claude Code 风格"完成。"）。
 * 与 narrate 的区别仅是语义提示，实际事件结构相同——保留独立函数便于审计与未来差异化。
 */
export function narrateDone(ctx: EmitHolder, text: string): Promise<unknown> {
  return ctx.emit({
    type: "text",
    channel: "content",
    payload: { delta: text },
  });
}

/**
 * 发射一条 skill 结束总结（前置换行，便于前端分隔气泡）。
 *
 * @example
 * await narrateSummary(ctx, "口播稿完成，5 段约 6300 字，预计 30 分钟。");
 */
export function narrateSummary(ctx: EmitHolder, text: string): Promise<unknown> {
  return ctx.emit({
    type: "text",
    channel: "content",
    payload: { delta: `\n${text}` },
  });
}
