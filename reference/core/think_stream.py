"""Parse model reasoning and emit Meso think SSE chunks."""
from __future__ import annotations

import re
from collections.abc import AsyncIterator
from typing import Any, Literal

from app.llm.base import BaseLLM, LLMMessage

THINKING_TAG_RE = re.compile(
    r"<think>([\s\S]*?)</think>",
    re.IGNORECASE,
)

SYS_START = "⟦sys⟧"
SYS_END = "⟦/sys⟧"

_JSON_START = re.compile(r'\{\s*"session_title"')
# 检测 content_acc 末尾是否有未闭合的 {（可能是 JSON 开始处），
# 匹配 { 后没有 } 直到字符串末尾，防止 { 与其他字符合并为一个 token 时泄漏
_JSON_OPEN_TAIL = re.compile(r'\{[^}]*$')

StreamPartKind = Literal["reasoning", "content"]


def split_thinking_text(text: str) -> tuple[str, str]:
    if not text:
        return "", ""
    blocks = [
        m.group(1).strip()
        for m in THINKING_TAG_RE.finditer(text)
        if m.group(1).strip()
    ]
    think = "\n\n".join(blocks)
    visible = THINKING_TAG_RE.sub("", text).strip()
    return think, visible


def chunk_text(text: str, size: int = 28) -> list[str]:
    if not text:
        return []
    return [text[i : i + size] for i in range(0, len(text), size)]


def wrap_system_line(text: str) -> str:
    body = (text or "").strip()
    if not body:
        return ""
    return f"{SYS_START}{body}{SYS_END}\n"


class ThinkAccumulator:
    """累积本轮 SSE think 正文，供 msg_meta.think 持久化。"""

    def __init__(self) -> None:
        self._parts: list[str] = []

    def append(self, text: str) -> None:
        body = (text or "").strip()
        if body:
            self._parts.append(body)

    def append_raw(self, text: str) -> None:
        if text:
            self._parts.append(text)

    def finalize(self) -> str:
        return "\n\n".join(self._parts).strip()


async def emit_think_events(
    text: str,
    *,
    chunk_size: int = 28,
    accumulator: ThinkAccumulator | None = None,
    stream_tokens: bool = False,
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    body = (text or "").strip()
    if not body:
        return
    if accumulator is not None:
        accumulator.append_raw(body)
    if stream_tokens:
        for chunk in chunk_text(body, chunk_size):
            yield ("think", {"delta": chunk})
    else:
        yield ("think", {"delta": body})
    yield ("think", {"delta": "", "done": True})


async def emit_system_think_line(
    text: str,
    *,
    accumulator: ThinkAccumulator | None = None,
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    wrapped = wrap_system_line(text)
    if not wrapped:
        return
    if accumulator is not None:
        accumulator.append_raw(wrapped)
    yield ("think", {"delta": wrapped, "source": "system"})
    yield ("think", {"delta": "", "done": True})


async def stream_llm_to_think(
    llm: BaseLLM,
    messages: list[LLMMessage],
    *,
    system: str | None = None,
    accumulator: ThinkAccumulator | None = None,
    max_tokens: int = 280,
    temperature: float = 0.25,
    use_reasoning: bool = False,
    hide_json_in_stream: bool = False,
    json_hide_hint: str | None = None,
    content_buffer: list[str] | None = None,
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """将 LLM 流式输出映射为 think SSE；reasoning 与可见叙述均进入思考区。

    hide_json_in_stream=True 时使用 pending buffer：当 ``content_acc`` 末尾出现未闭合
    ``{`` 时暂存后续 token，待 ``_JSON_START`` 确认后整体丢弃，避免逐 token 检测时
    ``{`` / ``"session_title"`` 等前缀泄漏到用户流。
    """
    section: list[str] = []
    content_acc = ""
    json_hide_notified = False
    _pending: list[str] = []  # 潜在 JSON 开头暂存，确认后整体丢弃

    async for kind, piece in llm.chat_stream_parts(
        messages,
        system=system,
        max_tokens=max_tokens,
        temperature=temperature,
        use_reasoning=use_reasoning,
    ):
        if kind == "content":
            if content_buffer is not None:
                content_buffer.append(piece)
            content_acc += piece

            if hide_json_in_stream:
                if json_hide_notified:
                    continue

                # 先检测完整 JSON 开头（pending 中已含 { 时最终在此处确认）
                if _JSON_START.search(content_acc):
                    json_hide_notified = True
                    _pending.clear()
                    hint = (json_hide_hint or "正在整理结构化检索规划…").strip()
                    wrapped = wrap_system_line(hint)
                    if wrapped:
                        if accumulator is not None:
                            accumulator.append_raw(wrapped)
                        yield ("think", {"delta": wrapped, "source": "system"})
                    continue

                # content_acc 末尾出现未闭合 { 或已在暂存模式 → 暂存等待确认
                if _JSON_OPEN_TAIL.search(content_acc) or _pending:
                    _pending.append(piece)
                    continue

                # 安全：flush pending（如有）并 emit 当前 piece
                if _pending:
                    for p in _pending:
                        section.append(p)
                        yield ("think", {"delta": p, "source": "model"})
                    _pending.clear()
                section.append(piece)
                yield ("think", {"delta": piece, "source": "model"})
                continue

            section.append(piece)
            yield ("think", {"delta": piece, "source": "model"})
        else:
            # reasoning 或其他 kind：先 flush pending（不是 JSON 上下文）
            if hide_json_in_stream and _pending and not json_hide_notified:
                for p in _pending:
                    section.append(p)
                    yield ("think", {"delta": p, "source": "model"})
                _pending.clear()
            section.append(piece)
            yield ("think", {"delta": piece, "source": "model"})

    # 流结束：处理剩余 pending（max_tokens 不足截断场景）
    if _pending:
        pending_str = "".join(_pending)
        if hide_json_in_stream and pending_str.lstrip().startswith("{"):
            if not json_hide_notified:
                hint = (json_hide_hint or "正在整理结构化检索规划…").strip()
                wrapped = wrap_system_line(hint)
                if wrapped:
                    if accumulator is not None:
                        accumulator.append_raw(wrapped)
                    yield ("think", {"delta": wrapped, "source": "system"})
        else:
            for p in _pending:
                section.append(p)
                yield ("think", {"delta": p, "source": "model"})

    if section and accumulator is not None:
        accumulator.append_raw("".join(section))
    yield ("think", {"delta": "", "done": True})


async def emit_assistant_thinking(
    content: str | None,
    *,
    reasoning: str | None = None,
    for_tool_round: bool = False,
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    merged = (content or "").strip()
    extra = (reasoning or "").strip()
    think_from_tags, visible = split_thinking_text(merged)
    to_emit = extra or think_from_tags
    if for_tool_round and not to_emit and visible:
        to_emit = visible
    elif not for_tool_round and not to_emit:
        return
    if not to_emit:
        return
    async for ev in emit_think_events(to_emit, stream_tokens=True):
        yield ev
