from __future__ import annotations

from typing import Any

from app.agents.ttl_cache import fetch_cache, normalize_cache_key, search_cache
from app.agents.tools.web_providers import (
    normalize_fetch_provider,
    normalize_search_provider,
    web_fetch_url,
    web_search_query,
)


async def cached_web_search(
    api_key: str,
    query: str,
    *,
    provider: str | None = None,
    max_results: int = 8,
    search_depth: str = "advanced",
    include_domains: list[str] | tuple[str, ...] | None = None,
    exclude_domains: list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
    if provider is None:
        from app.agents.agent_settings import get_web_search_provider

        provider = await get_web_search_provider()
    prov = normalize_search_provider(provider)
    key = normalize_cache_key(
        prov,
        query,
        {
            "max_results": max_results,
            "search_depth": search_depth,
            "include_domains": list(include_domains) if include_domains else None,
            "exclude_domains": list(exclude_domains) if exclude_domains else None,
        },
    )
    hit = search_cache.get(key)
    if hit is not None:
        return hit
    data = await web_search_query(
        query,
        provider=prov,
        api_key=api_key,
        max_results=max_results,
        search_depth=search_depth,
        include_domains=include_domains,
        exclude_domains=exclude_domains,
    )
    search_cache.set(key, data)
    return data


async def cached_web_fetch(
    url: str,
    *,
    provider: str | None = None,
    api_key: str | None = None,
    timeout: float = 60.0,
    pdf_extract_backend: str | None = None,
) -> str:
    if provider is None:
        from app.agents.agent_settings import get_web_fetch_provider

        provider = await get_web_fetch_provider()
    prov = normalize_fetch_provider(provider)
    if pdf_extract_backend is None and prov == "native":
        from app.agents.agent_settings import get_pdf_extract_backend

        pdf_extract_backend = await get_pdf_extract_backend()
    cache_extra = {"timeout": timeout}
    if prov == "native" and pdf_extract_backend:
        cache_extra["pdf_extract_backend"] = pdf_extract_backend
    key = normalize_cache_key(prov, url, cache_extra)
    hit = fetch_cache.get(key)
    if hit is not None:
        return hit
    text = await web_fetch_url(
        url,
        provider=prov,
        api_key=api_key if prov == "jina" else None,
        timeout=timeout,
        pdf_extract_backend=pdf_extract_backend,
    )
    if text and text.strip():
        fetch_cache.set(key, text)
    return text
