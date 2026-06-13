"""Unified web_search / web_fetch providers.

web_search backends:
- tavily: LitPilot default (API key)
- brave: Brave Search API (API key)
- openalex: academic index (no key)
- native: DuckDuckGo HTML + domain filters (docs/WebSearchTool semantics, no Anthropic)

web_fetch backends: jina | native (docs/WebFetchTool)
"""
from __future__ import annotations

from typing import Any

from app.agents.tools.pdf_text import normalize_pdf_extract_backend
from app.agents.tools.providers import brave as brave_provider
from app.agents.tools.providers import jina as jina_provider
from app.agents.tools.providers import multi_academic as multi_academic_provider
from app.agents.tools.providers import native_fetch as native_fetch_provider
from app.agents.tools.providers import native_search as native_search_provider
from app.agents.tools.providers import openalex as openalex_provider
from app.agents.tools.providers import tavily as tavily_provider
FETCH_PROVIDERS = frozenset({"jina", "native"})
SEARCH_PROVIDERS = frozenset({"tavily", "brave", "openalex", "native", "multi_academic"})


def normalize_fetch_provider(raw: str | None) -> str:
    p = (raw or "native").strip().lower()
    return p if p in FETCH_PROVIDERS else "native"


def normalize_search_provider(raw: str | None) -> str:
    p = (raw or "multi_academic").strip().lower()
    return p if p in SEARCH_PROVIDERS else "multi_academic"


SEARCH_PROVIDER_LABELS: dict[str, str] = {
    "tavily": "Tavily",
    "brave": "Brave Search",
    "openalex": "OpenAlex",
    "native": "native (DDG)",
    "multi_academic": "multi_academic (arXiv+OA+SS)",
}

FETCH_PROVIDER_LABELS: dict[str, str] = {
    "jina": "Jina Reader",
    "native": "native HTTP",
}


def search_provider_display(provider: str | None) -> str:
    p = normalize_search_provider(provider)
    return SEARCH_PROVIDER_LABELS.get(p, p)


def fetch_provider_display(provider: str | None) -> str:
    p = normalize_fetch_provider(provider)
    return FETCH_PROVIDER_LABELS.get(p, p)


async def _resolve_pdf_extract_backend(pdf_extract_backend: str | None) -> str:
    if pdf_extract_backend is not None:
        return normalize_pdf_extract_backend(pdf_extract_backend)
    from app.agents.agent_settings import get_pdf_extract_backend

    return await get_pdf_extract_backend()


async def _resolve_s2_api_key(s2_api_key: str | None) -> str | None:
    if s2_api_key:
        return s2_api_key
    from app.agents.agent_settings import get_s2_api_key

    key = await get_s2_api_key()
    return key or None


async def web_fetch_url(
    url: str,
    *,
    provider: str = "native",
    api_key: str | None = None,
    timeout: float = 60.0,
    pdf_extract_backend: str | None = None,
    s2_api_key: str | None = None,
) -> str:
    p = normalize_fetch_provider(provider)
    if p == "native":
        backend = await _resolve_pdf_extract_backend(pdf_extract_backend)
        s2_key = await _resolve_s2_api_key(s2_api_key)
        return await native_fetch_provider.fetch(
            url,
            timeout=timeout,
            pdf_extract_backend=backend,
            s2_api_key=s2_key,
        )
    return await jina_provider.fetch(url, api_key=api_key, timeout=timeout)


async def web_fetch_url_with_meta(
    url: str,
    *,
    provider: str = "native",
    api_key: str | None = None,
    timeout: float = 60.0,
    pdf_extract_backend: str | None = None,
    s2_api_key: str | None = None,
) -> dict[str, object]:
    p = normalize_fetch_provider(provider)
    if p == "native":
        backend = await _resolve_pdf_extract_backend(pdf_extract_backend)
        s2_key = await _resolve_s2_api_key(s2_api_key)
        from app.agents.agent_settings import get_jina_reader_api_key

        jina_key = await get_jina_reader_api_key()
        result = await native_fetch_provider.fetch_bytes(
            url,
            timeout=timeout,
            pdf_extract_backend=backend,
            s2_api_key=s2_key,
            jina_api_key=jina_key or None,
        )
        effective_provider = "jina" if result.via_jina else p
        return {
            "text": result.text,
            "final_url": result.final_url,
            "resolved_pdf_url": result.resolved_pdf_url,
            "is_pdf": result.is_pdf,
            "provider": effective_provider,
            "pdf_extract_backend": backend,
            "via_jina": result.via_jina,
            "metadata_only": result.metadata_only,
        }
    text = await jina_provider.fetch(url, api_key=api_key, timeout=timeout)
    return {
        "text": text,
        "final_url": url,
        "resolved_pdf_url": None,
        "is_pdf": False,
        "provider": p,
        "pdf_extract_backend": None,
    }


async def web_search_query(
    query: str,
    *,
    provider: str = "native",
    api_key: str = "",
    max_results: int = 8,
    search_depth: str = "advanced",
    include_domains: list[str] | tuple[str, ...] | None = None,
    exclude_domains: list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
    p = normalize_search_provider(provider)
    if p == "multi_academic":
        s2_key = await _resolve_s2_api_key(None)
        return await multi_academic_provider.search(
            query,
            max_results=max_results,
            include_domains=include_domains,
            exclude_domains=exclude_domains,
            s2_api_key=s2_key or "",
        )
    if p == "openalex":
        return await openalex_provider.search(
            query,
            max_results=max_results,
            include_domains=include_domains,
        )
    if p == "native":
        return await native_search_provider.search(
            query,
            max_results=max_results,
            include_domains=include_domains,
            exclude_domains=exclude_domains,
        )
    if p == "brave":
        return await brave_provider.search(
            api_key,
            query,
            max_results=max_results,
            include_domains=include_domains,
            exclude_domains=exclude_domains,
        )
    return await tavily_provider.search(
        api_key,
        query,
        max_results=max_results,
        search_depth=search_depth,
        include_domains=include_domains,
        exclude_domains=exclude_domains,
    )
