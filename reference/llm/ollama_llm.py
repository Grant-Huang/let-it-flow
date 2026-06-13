"""Ollama local LLM — text chat via /api/generate."""
from __future__ import annotations

from typing import Optional

from app.llm.base import BaseLLM, LLMConfig, LLMMessage, LLMResponse
from app.llm.http_client import get_async_client


class OllamaLLM(BaseLLM):
    DEFAULT_MODEL = "llama3.2"

    def __init__(self, config: LLMConfig):
        super().__init__(config)
        self._base_url = (config.base_url or "http://127.0.0.1:11434").rstrip("/")

    async def chat(
        self,
        messages: list[LLMMessage],
        system: Optional[str] = None,
        max_tokens: int = 4096,
        temperature: float = 0.3,
    ) -> LLMResponse:
        model = self.config.model or self.DEFAULT_MODEL
        prompt_parts: list[str] = []
        if system:
            prompt_parts.append(f"[System]\n{system}")
        for m in messages:
            prompt_parts.append(f"[{m.role}]\n{m.content}")

        payload = {
            "model": model,
            "prompt": "\n\n".join(prompt_parts),
            "stream": False,
            "options": {
                "temperature": temperature,
                "num_predict": max_tokens,
            },
        }

        client = get_async_client()
        resp = await client.post(
            f"{self._base_url}/api/generate",
            json=payload,
            timeout=300,
        )
        resp.raise_for_status()
        data = resp.json()

        return LLMResponse(
            content=data.get("response", "") or "",
            model=model,
            provider="ollama",
        )
