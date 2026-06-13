"""Brave Search web_search provider."""
from __future__ import annotations

from typing import Any

import httpx

from app.agents.tools.search_hits import DEFAULT_EXCLUDE_DOMAINS


async def search(
    api_key: str,
    query: str,
    *,
    max_results: int = 8,
    include_domains: list[str] | tuple[str, ...] | None = None,
    exclude_domains: list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
    if not api_key:
        raise ValueError("Brave Search API Key 未配置")

    params: dict[str, Any] = {
        "q": query,
        "count": max(1, min(max_results, 20)),
    }
    if include_domains:
        site_parts = [f"site:{d.strip()}" for d in include_domains if str(d).strip()]
        if site_parts:
            params["q"] = f"{query} ({' OR '.join(site_parts)})"

    headers = {
        "Accept": "application/json",
        "X-Subscription-Token": api_key,
    }
    async with httpx.AsyncClient(timeout=45.0) as client:
        resp = await client.get(
            "https://api.search.brave.com/res/v1/web/search",
            params=params,
            headers=headers,
        )
        resp.raise_for_status()
        data = resp.json()

    blocked = {d.lower().strip() for d in (exclude_domains or ())}
    for d in DEFAULT_EXCLUDE_DOMAINS:
        blocked.add(d.lower())

    rows: list[dict[str, str]] = []
    web = data.get("web") if isinstance(data, dict) else None
    for item in (web or {}).get("results") or []:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").strip()
        if not url:
            continue
        host = url.split("/")[2].lower() if "://" in url else ""
        if blocked and any(host == b or host.endswith(f".{b}") for b in blocked):
            continue
        rows.append({
            "url": url,
            "title": str(item.get("title") or ""),
            "content": str(item.get("description") or "")[:800],
        })
        if len(rows) >= max_results:
            break

    return {"results": rows, "answer": ""}
