"""OpenAlex academic web_search provider (no API key)."""
from __future__ import annotations

import json
import urllib.parse
import urllib.request
from typing import Any

from app.agents.tools.providers.academic.query_sanitize import sanitize_academic_search_query
from app.agents.tools.search_hits import restrict_hits_to_domains

_MAILTO = "support@litpilot.local"
_USER_AGENT = f"LitPilot/1.0 (mailto:{_MAILTO})"


def _work_url(work: dict[str, Any]) -> str:
    loc = work.get("primary_location") or {}
    if isinstance(loc, dict):
        u = str(loc.get("landing_page_url") or loc.get("pdf_url") or "").strip()
        if u:
            return u
    oa = work.get("open_access") or {}
    if isinstance(oa, dict):
        u = str(oa.get("oa_url") or "").strip()
        if u:
            return u
    doi = str(work.get("doi") or "").strip()
    if doi.startswith("http"):
        return doi
    if doi:
        return f"https://doi.org/{doi.lstrip('https://doi.org/')}"
    return ""


def _work_snippet(work: dict[str, Any]) -> str:
    inv = work.get("abstract_inverted_index")
    if isinstance(inv, dict) and inv:
        pos_word: list[tuple[int, str]] = []
        for word, positions in inv.items():
            if not isinstance(positions, list):
                continue
            for p in positions:
                if isinstance(p, int):
                    pos_word.append((p, str(word)))
        if pos_word:
            pos_word.sort(key=lambda x: x[0])
            return " ".join(w for _, w in pos_word)[:800]
    recon = work.get("abstract")
    if isinstance(recon, str):
        return recon[:800]
    return ""


def _openalex_title(work: dict[str, Any]) -> str:
    t = work.get("title") or work.get("display_name") or ""
    return str(t).strip()


async def search(
    query: str,
    *,
    max_results: int = 8,
    include_domains: list[str] | tuple[str, ...] | None = None,
) -> dict[str, Any]:
    q = sanitize_academic_search_query((query or "").strip())
    if not q:
        return {"results": [], "answer": ""}

    params = urllib.parse.urlencode(
        {
            "search": q[:300],
            "per-page": str(max(1, min(max_results, 25))),
            "mailto": _MAILTO,
        }
    )
    url = f"https://api.openalex.org/works?{params}"
    req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})

    def _load() -> dict[str, Any]:
        with urllib.request.urlopen(req, timeout=45) as resp:  # noqa: S310
            return json.loads(resp.read().decode())

    import asyncio

    data = await asyncio.to_thread(_load)
    rows: list[dict[str, str]] = []
    for work in data.get("results") or []:
        if not isinstance(work, dict):
            continue
        page_url = _work_url(work)
        if not page_url:
            continue
        rows.append({
            "url": page_url,
            "title": _openalex_title(work),
            "snippet": _work_snippet(work),
            "source": "OpenAlex",
        })

    if include_domains:
        rows = restrict_hits_to_domains(rows, include_domains=include_domains)

    return {
        "results": rows[:max_results],
        "answer": "",
    }
