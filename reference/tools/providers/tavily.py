"""Tavily web_search provider (https://tavily.com)."""
from __future__ import annotations

from typing import Any

import httpx

from app.agents.tools.search_hits import DEFAULT_EXCLUDE_DOMAINS


def build_search_payload(
    api_key: str,
    query: str,
    *,
    max_results: int = 8,
    search_depth: str = "advanced",
    include_domains: list[str] | tuple[str, ...] | None = None,
    exclude_domains: list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "api_key": api_key,
        "query": query,
        "max_results": max_results,
        "search_depth": search_depth,
        "include_answer": True,
        "include_raw_content": False,
    }
    if include_domains:
        payload["include_domains"] = list(include_domains)
    merged_exclude = list(exclude_domains or ()) + [
        d for d in DEFAULT_EXCLUDE_DOMAINS if d not in (exclude_domains or ())
    ]
    if merged_exclude:
        payload["exclude_domains"] = merged_exclude
    return payload


async def search(
    api_key: str,
    query: str,
    *,
    max_results: int = 8,
    search_depth: str = "advanced",
    include_domains: list[str] | tuple[str, ...] | None = None,
    exclude_domains: list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
    if not api_key:
        raise ValueError("web_search（Tavily）API Key 未配置")

    payload = build_search_payload(
        api_key,
        query,
        max_results=max_results,
        search_depth=search_depth,
        include_domains=include_domains,
        exclude_domains=exclude_domains,
    )
    async with httpx.AsyncClient(timeout=45.0) as client:
        resp = await client.post("https://api.tavily.com/search", json=payload)
        resp.raise_for_status()
        return resp.json()
