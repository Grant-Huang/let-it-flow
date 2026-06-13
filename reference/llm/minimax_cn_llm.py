"""MiniMax China API (api.minimaxi.com) — OpenAI-compatible chat completions."""
from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator
from typing import Optional

from app.llm.base import BaseLLM, LLMConfig, LLMMessage, LLMResponse, StreamPartKind
from app.llm.http_client import get_async_client

MINIMAX_CN_BASE = "https://api.minimaxi.com/v1"


class MinimaxCNLLM(BaseLLM):
    DEFAULT_MODEL = "MiniMax-M2.7"

    def __init__(self, config: LLMConfig):
        super().__init__(config)
        if not (config.api_key or "").strip():
            raise ValueError("MiniMax 国内版需要 API Key")

    def _base_url(self) -> str:
        """Resolve OpenAI-compatible base; honor config.base_url when set.

        本客户端走 OpenAI 兼容协议（/chat/completions）。MiniMax 的
        Anthropic 兼容端点（/anthropic）协议不同，不能在此使用。
        """
        base = (self.config.base_url or "").strip().rstrip("/")
        if not base:
            return MINIMAX_CN_BASE
        if base.endswith("/anthropic"):
            # Anthropic 端点与 OpenAI 协议不兼容，回退到 OpenAI 兼容根
            return base[: -len("/anthropic")] + "/v1"
        return base

    def _headers(self) -> dict[str, str]:
        headers = {
            "Authorization": f"Bearer {self.config.api_key}",
            "Content-Type": "application/json",
        }
        group_id = (self.config.extra or {}).get("group_id")
        if group_id and str(group_id).strip():
            headers["GroupId"] = str(group_id).strip()
        return headers

    @staticmethod
    def _split_think(text: str) -> tuple[str, str]:
        blocks = re.findall(
            r"<think>([\s\S]*?)</think>",
            text or "",
            flags=re.IGNORECASE,
        )
        reasoning = "\n\n".join(b.strip() for b in blocks if b and b.strip())
        visible = re.sub(
            r"<think>[\s\S]*?</think>\s*",
            "",
            text or "",
            flags=re.IGNORECASE,
        ).strip()
        return reasoning, visible

    def _extract_error(self, data: dict) -> str:
        br = data.get("base_resp") or {}
        err = data.get("error") or {}
        msg = br.get("status_msg") or err.get("message") or ""
        code = br.get("status_code") or err.get("http_code") or ""
        return f"MiniMax API error: code={code}, msg={msg}"

    async def chat(
        self,
        messages: list[LLMMessage],
        system: Optional[str] = None,
        max_tokens: int = 4096,
        temperature: float = 0.3,
    ) -> LLMResponse:
        model = self.config.model or self.DEFAULT_MODEL
        msgs: list[dict[str, str]] = []
        if system:
            msgs.append({"role": "system", "content": system})
        for m in messages:
            msgs.append({"role": m.role, "content": m.content})

        payload = {
            "model": model,
            "messages": msgs,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        url = f"{self._base_url()}/chat/completions"

        client = get_async_client()
        resp = await client.post(url, json=payload, headers=self._headers())
        resp.raise_for_status()
        data = resp.json()

        if not data.get("choices"):
            raise RuntimeError(self._extract_error(data))

        raw = data["choices"][0]["message"]["content"] or ""
        reasoning, content = self._split_think(raw)
        # 部分模型把正文全部放在 thinking 区，可见 content 为空
        if not (content or "").strip() and (reasoning or "").strip():
            content = reasoning.strip()
            reasoning = None
        return LLMResponse(
            content=content,
            reasoning=reasoning or None,
            model=model,
            provider="minimax_cn",
        )

    async def chat_stream(
        self,
        messages: list[LLMMessage],
        system: Optional[str] = None,
        max_tokens: int = 4096,
        temperature: float = 0.3,
    ) -> AsyncIterator[str]:
        async for _kind, piece in self.chat_stream_parts(
            messages,
            system=system,
            max_tokens=max_tokens,
            temperature=temperature,
        ):
            if _kind == "content" and piece:
                yield piece

    async def chat_stream_parts(
        self,
        messages: list[LLMMessage],
        system: Optional[str] = None,
        max_tokens: int = 4096,
        temperature: float = 0.3,
        *,
        use_reasoning: bool = False,
    ) -> AsyncIterator[tuple[StreamPartKind, str]]:
        model = self.config.model or self.DEFAULT_MODEL
        msgs: list[dict[str, str]] = []
        if system:
            msgs.append({"role": "system", "content": system})
        for m in messages:
            msgs.append({"role": m.role, "content": m.content})

        payload = {
            "model": model,
            "messages": msgs,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": True,
        }
        url = f"{self._base_url()}/chat/completions"

        in_think = False
        tag_buf = ""

        client = get_async_client()
        async with client.stream(
            "POST", url, json=payload, headers=self._headers()
        ) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data_s = line[5:].strip()
                if not data_s or data_s == "[DONE]":
                    continue
                try:
                    data = json.loads(data_s)
                except json.JSONDecodeError:
                    continue
                if not data.get("choices"):
                    continue
                delta = data["choices"][0].get("delta") or {}
                piece = delta.get("content") or ""
                if not piece:
                    continue

                tag_buf += piece
                while tag_buf:
                    if not in_think:
                        low = tag_buf.lower()
                        open_idx = low.find("<think>")
                        if open_idx == -1:
                            emit, tag_buf = tag_buf, ""
                            if emit:
                                yield ("content", emit)
                            break
                        if open_idx > 0:
                            yield ("content", tag_buf[:open_idx])
                        tag_buf = tag_buf[open_idx + len("<think>") :]
                        in_think = True
                        continue
                    low = tag_buf.lower()
                    close_idx = low.find("</think>")
                    if close_idx == -1:
                        # 综述生成等场景：正文可能在 thinking 标签内，需流出为 content
                        kind: StreamPartKind = (
                            "reasoning" if use_reasoning else "content"
                        )
                        yield (kind, tag_buf)
                        tag_buf = ""
                        break
                    if close_idx > 0:
                        kind = "reasoning" if use_reasoning else "content"
                        yield (kind, tag_buf[:close_idx])
                    tag_buf = tag_buf[close_idx + len("</think>") :]
                    in_think = False
