from abc import ABC, abstractmethod
from collections.abc import AsyncIterator
from typing import Any, Literal, Optional

StreamPartKind = Literal["reasoning", "content"]

from pydantic import BaseModel, Field


class LLMMessage(BaseModel):
    role: str
    content: str = ""
    tool_calls: Optional[list[dict[str, Any]]] = None
    tool_call_id: Optional[str] = None


class LLMConfig(BaseModel):
    provider: str
    api_key: str
    model: Optional[str] = None
    base_url: Optional[str] = None
    extra: Optional[dict] = None


class LLMResponse(BaseModel):
    content: str
    model: str
    provider: str
    reasoning: Optional[str] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None


class BaseLLM(ABC):
    def __init__(self, config: LLMConfig):
        self.config = config

    @abstractmethod
    async def chat(
        self,
        messages: list[LLMMessage],
        system: Optional[str] = None,
        max_tokens: int = 4096,
        temperature: float = 0.3,
    ) -> LLMResponse:
        pass

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
        del use_reasoning
        async for piece in self.chat_stream(
            messages,
            system=system,
            max_tokens=max_tokens,
            temperature=temperature,
        ):
            if piece:
                yield ("content", piece)
