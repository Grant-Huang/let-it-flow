from __future__ import annotations

from app.llm.base import BaseLLM, LLMConfig
from app.llm.openai_llm import OpenAILLM

PROVIDER_REGISTRY: dict[str, dict] = {
    "openai": {
        "label": "OpenAI (GPT)",
        "default_model": "gpt-4o-mini",
        "default_base_url": "https://api.openai.com/v1",
        "requires_api_key": True,
    },
    "zhipu": {
        "label": "智谱 GLM (ZhipuAI)",
        "default_model": "glm-4-flash",
        "default_base_url": "https://open.bigmodel.cn/api/paas/v4",
        "requires_api_key": True,
    },
    "alibaba": {
        "label": "阿里云百炼 (Qwen)",
        "default_model": "qwen-turbo",
        "default_base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "requires_api_key": True,
    },
    "qwen": {
        "label": "通义千问 Qwen (DashScope)",
        "default_model": "qwen-plus",
        "default_base_url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "requires_api_key": True,
    },
    "deepseek": {
        "label": "DeepSeek",
        "default_model": "deepseek-chat",
        "default_base_url": "https://api.deepseek.com",
        "requires_api_key": True,
    },
    "minimax_intl": {
        "label": "MiniMax 国际版",
        "default_model": "MiniMax-Text-01",
        "default_base_url": "https://api.minimaxi.chat/v1",
        "requires_api_key": True,
    },
    "minimax_cn": {
        "label": "MiniMax 国内版",
        "default_model": "MiniMax-M2.7",
        "default_base_url": "https://api.minimaxi.com/v1",
        "requires_api_key": True,
        "optional_fields": ["group_id"],
    },
    "ollama": {
        "label": "Ollama (本地)",
        "default_model": "llama3.2",
        "default_base_url": "http://127.0.0.1:11434",
        "requires_api_key": False,
    },
}


def build_llm(config: LLMConfig) -> BaseLLM:
    provider = config.provider or "openai"

    if provider == "minimax_cn":
        from app.llm.minimax_cn_llm import MinimaxCNLLM

        return MinimaxCNLLM(config)

    if provider == "ollama":
        from app.llm.ollama_llm import OllamaLLM

        return OllamaLLM(config)

    if provider in ("openai", "zhipu", "alibaba", "minimax_intl", "deepseek", "qwen"):
        meta = PROVIDER_REGISTRY.get(provider, {})
        if not config.base_url and meta.get("default_base_url"):
            config.base_url = meta["default_base_url"]
        return OpenAILLM(config)

    raise ValueError(f"Unsupported LLM provider: {provider}")
