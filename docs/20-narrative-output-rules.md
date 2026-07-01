# 标准化输出规则：Claude Code 风格流式叙述

> 生成时间：2026-06-23
> 目的：让所有 skill / tool 在执行期间向流式会话实时输出"正在做什么"，参考 Claude Code 的叙述风格（中文）。
> 配套 helper：`src/core/narrate.ts`（`narrate` / `narrateDone` / `narrateSummary`）

---

## 一、为什么需要

项目原本所有 skill / tool 在执行耗时操作时（网络请求、LLM 调用、多步循环）几乎完全静默，只在结束时一次性吐 `tool_result`。对比 Claude Code 的 "Let me read the file..." / "Searching..." 实时叙述，用户体验差距明显。

基础设施其实早已完备：
- `src/tools/base.ts:72-74` 早已约定工具可 emit `text`（流式正文）和 `workflow_node`（进度）
- `StepCtx.emit` 直接透传 `ExecutionContext.emit`，走 SSE 实时下发
- 只有 `core.llm_node` 用过 token 级 text 流，其余全部静默

本规则统一了"何时叙述、如何叙述、用什么 helper"。

---

## 二、何时发叙述（5 个时机）

| 时机 | 事件类型 | 示例 |
|---|---|---|
| skill 开始 | text | "我先聚焦本期主线。" |
| 步骤开始前 | text | "正在从知识库取写稿铁律…" |
| 关键分支决策 | text | "字数超标 320 字，触发自动重写。" |
| 步骤结束的关键产出摘要 | text | "找到 3 条铁律，最长 1200 字。" |
| skill 结束 | text（换行起头） | "口播稿完成，5 段约 6300 字，预计 30 分钟。" |

---

## 三、文本规范（Claude Code 风格，中文）

1. **第一人称**："我"、"正在"——拟人化
2. **动词开头**：检索 / 抓取 / 生成 / 校验 / 提取 / 聚焦
3. **单条 ≤ 50 字**：不写长段落
4. **不发**：
   - JSON dump（结果走 tool_result，不进叙述）
   - step 名重复（workflow_node 已有）
   - 调试信息、堆栈、原始参数
   - 纯英文（项目内 system prompt 统一中文）
5. **标点约定**：
   - 进行中用"…"（视觉上未完成）
   - 完成用"。"（视觉上收尾）
6. **批量操作用计数**：抓取 [3/5]、检索到 12 条——让用户感知进度
7. **关键发现用 `- ` 前缀**：每条独立的发现、结论、建议单独一行，以 `- ` 开头，前端会渲染为 `·` bullet 标记。例：
   ```
   - 主轴振动超规 50%，直接导致尺寸超差占 42%。
   - 润滑泵堵塞已持续 72h，MTBF 跌至基准值 40%。
   ```
8. **"收尾"措辞约束**：只在 **所有工具调用已完成后** 才可发"收尾"类文字（"已完成"、"分析结束"等）；在工具调用 **之前** 的 narrate 只能描述"接下来要做什么"，不能说"然后收尾"——避免用户看到"收尾"后又出现新内容。

---

## 四、技术映射

```
narrate(ctx, "正在检索写稿铁律…")
  ↓ 内部展开
ctx.emit({ type: "text", channel: "content", payload: { delta: "正在检索写稿铁律…" } })
  ↓ toSSE()
SSE: { type: "text", schema_version: "1.0", payload: { delta: "正在检索写稿铁律…" } }
  ↓ 前端 useNexusStream
追加到对话流（Claude Code 风格气泡）
```

关键点：`ctx.emit` 走 `ExecutionContext.emit`，**直接 append 到 store + 走 SSE**，绕过 skill-bridge 的 `pendingEvents` 批量队列，保证实时。

---

## 五、helper 用法

```typescript
import { narrate, narrateDone, narrateSummary } from "../../../src/core/narrate.js";

// skill 内 step fn 里（ctx 是 StepCtx）
async steps(input) {
  const { step, narrate: skillNarrate } = input;  // 阶段4 起支持 input.narrate
  await skillNarrate("我来写这期口播稿。");        // skill 级叙述（step 外）

  const rulesStep = await step("获取写稿铁律", async (ctx) => {
    await narrate(ctx, "正在从知识库取写稿铁律…"); // 步骤级叙述（step 内）
    const envelope = await ctx.call("kb.search", { query: "..." });
    await narrateDone(ctx, `找到 ${results.length} 条铁律。`);
    return ...;
  });
  ...
  await narrateSummary(/* 见阶段4 */ , "口播稿完成，5 段约 6300 字，预计 30 分钟。");
}
```

```typescript
// 工具内（ctx 是 ExecutionContext）
import { narrate } from "../../core/narrate.js";

async *execute(params, ctx) {
  yield { type: "tool_call", ... };
  for (let i = 0; i < targets.length; i++) {
    await narrate(ctx, `抓取 [${i+1}/${targets.length}] ${targets[i].url}…`);
    const doc = await fetchOne(targets[i]);
    ...
  }
  yield { type: "tool_result", ... };
}
```

---

## 六、适用范围

| 类型 | 文件 | 改造要求 |
|---|---|---|
| **aicf skill** | `apps/ai-content-factory/skills/*.ts` | skill 开始 + 每个 step + 关键分支 + 结束总结 |
| **nexusops skill** | `apps/nexusops/skills/*.ts` | 每个 step 边界 |
| **core 工具（耗时类）** | `src/tools/builtin/{web-fetch,web-search,knowledge-base}.ts` | 网络/检索往返前后 |
| **core 工具（LLM 类）** | `src/tools/builtin/llm-node.ts` | 不补 narrative（已有 token 级 text 流，额外叙述会与 LLM 输出混淆） |
| **core 工具（瞬时类）** | `src/tools/builtin/deliver.ts` | 不改（无 narrative 价值） |

---

## 七、已知限制

1. **skill-bridge 的 pendingEvents 批量延迟**：`runDynamicSteps` 把步骤事件（workflow_node）积攒到 skill 结束才统一 yield。**narrate 通过 ctx.emit 绕过此队列**，所以叙述文本是实时的；但 workflow_node 机器字段仍有延迟。修复它会触及 skill 执行模型核心，风险高收益低，列为已知限制。
2. **前端无需改动**：前端只需把 text 事件的 delta 追加到对话流（NexusChatPage 已支持 text 渲染）。
3. **SSE 协议无需改动**：text 事件已存在于协议，只是 skill/tool 之前没用。
4. **text 事件不带 tool_call_id**：narrative 文本会进入主对话气泡，而非工具卡片内。由于 ReAct 工具是顺序执行（工具运行期间无并发 LLM 输出），narrative 与 LLM 正文不会真正冲突。唯一例外是 `core.llm_node`——它本身就在产 LLM token 流，**故 llm_node 不补 narrative**，避免混淆。
