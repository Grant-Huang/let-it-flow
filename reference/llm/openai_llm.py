from collections.abc import AsyncIterator
from typing import Optional

from openai import AsyncOpenAI

from app.llm.base import BaseLLM, LLMConfig, LLMMessage, LLMResponse
from app.llm.http_client import get_async_client


class OpenAILLM(BaseLLM):
    def __init__(self, config: LLMConfig):
        super().__init__(config)
        self._client = AsyncOpenAI(
            api_key=config.api_key,
            base_url=config.base_url,
            http_client=get_async_client(),
        )

    def _default_model(self) -> str:
        defaults = {
            "openai": "gpt-4o-mini",
            "zhipu": "glm-4-flash",
            "alibaba": "qwen-turbo",
            "qwen": "qwen-plus",
            "deepseek": "deepseek-chat",
            "minimax_intl": "MiniMax-Text-01",
        }
        return self.config.model or defaults.get(self.config.provider, "gpt-4o-mini")

    def _deepseek_extra_body(self) -> dict | None:
        """DeepSeek v4 默认开启思考模式，按模型自动控制：
        - deepseek-v4-pro：保持思考模式（review 任务需要深度推理）
        - deepseek-v4-flash / deepseek-chat：关闭思考（编排/理解等快响应场景）
        实例 extra.thinking 可显式覆盖（"enabled" / "disabled"）。
        """
        model = (self.config.model or "").lower()
        if not model.startswith("deepseek-"):
            return None
        extra = self.config.extra or {}
        if "thinking" in extra:
            return {"thinking": {"type": "disabled"}} if extra["thinking"] == "disabled" else None
        if model in ("deepseek-v4-pro", "deepseek-reasoner"):
            return None  # 不传 thinking → API 默认思考模式
        return {"thinking": {"type": "disabled"}}

    def _build_messages(
        self,
        messages: list[LLMMessage],
        system: Optional[str],
    ) -> list[dict]:
        msgs: list[dict] = []
        if system:
            msgs.append({"role": "system", "content": system})
        for m in messages:
            msgs.append({"role": m.role, "content": m.content})
        return msgs

    async def chat(
        self,
        messages: list[LLMMessage],
        system: Optional[str] = None,
        max_tokens: int = 4096,
        temperature: float = 0.3,
    ) -> LLMResponse:
        model = self._default_model()
        resp = await self._client.chat.completions.create(
            model=model,
            messages=self._build_messages(messages, system),
            max_tokens=max_tokens,
            temperature=temperature,
            extra_body=self._deepseek_extra_body(),
        )
        return LLMResponse(
            content=resp.choices[0].message.content or "",
            model=model,
            provider=self.config.provider,
            input_tokens=resp.usage.prompt_tokens if resp.usage else None,
            output_tokens=resp.usage.completion_tokens if resp.usage else None,
        )

    async def chat_stream(
        self,
        messages: list[LLMMessage],
        system: Optional[str] = None,
        max_tokens: int = 4096,
        temperature: float = 0.3,
    ) -> AsyncIterator[str]:
        model = self._default_model()
        stream = await self._client.chat.completions.create(
            model=model,
            messages=self._build_messages(messages, system),
            max_tokens=max_tokens,
            temperature=temperature,
            stream=True,
            extra_body=self._deepseek_extra_body(),
        )
        async for chunk in stream:
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta is None:
                continue
            text = delta.content or ""
            if text:
                yield text

    async def chat_stream_parts(
        self,
        messages: list[LLMMessage],
        system: Optional[str] = None,
        max_tokens: int = 4096,
        temperature: float = 0.3,
        *,
        use_reasoning: bool = False,
    ) -> AsyncIterator[tuple[str, str]]:
        """流式返回 (kind, piece)，DeepSeek 思考模式下 reasoning_content 也会作为 reasoning 输出。"""
        from app.llm.base import StreamPartKind

        model = self._default_model()
        stream = await self._client.chat.completions.create(
            model=model,
            messages=self._build_messages(messages, system),
            max_tokens=max_tokens,
            temperature=temperature,
            stream=True,
            extra_body=self._deepseek_extra_body(),
        )
        async for chunk in stream:
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta is None:
                continue
            reasoning = getattr(delta, "reasoning_content", None) or ""
            content = delta.content or ""
            if reasoning:
                yield ("reasoning", reasoning)
            if content:
                yield ("content", content)
