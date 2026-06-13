"""Parallel multi-source academic web_search (arXiv, CrossRef, PMC, OpenAlex, SS)."""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Mapping

from app.agents.tools.providers import openalex as openalex_provider
from app.agents.tools.providers.academic import arxiv, crossref, pubmed, semantic_scholar
from app.agents.tools.providers.academic.source_gate import (
    SOURCE_NAMES,
    source_count,
    source_slot,
)
from app.agents.tools.providers.academic.query_sanitize import sanitize_academic_search_query
from app.agents.tools.search_hits import restrict_hits_to_domains
from app.agents.search_aspects import query_for_source

_log = logging.getLogger(__name__)

DEFAULT_MIN_YEAR = 2019
SOURCE_TIMEOUT_SEC = 90.0
SOURCE_TIMEOUTS: dict[str, float] = {
    "semantic_scholar": 60.0,
}
MULTI_PASS_EVENT_POLL_SEC = 5.0
MULTI_PASS_EXTRA_SEC = 15.0

SOURCE_LABELS = {
    "openalex": "OpenAlex",
    "arxiv": "arXiv",
    "crossref": "CrossRef",
    "pubmed": "PubMed",
    "semantic_scholar": "Semantic Scholar",
}


@dataclass(frozen=True)
class PassSpec:
    pass_index: int
    pass_total: int
    query: str
    topic_title: str
    max_results: int
    source_queries: Mapping[str, str] = field(default_factory=dict)
    skip_sources: frozenset[str] = frozenset()


async def _run_source(name: str, coro) -> list[dict[str, str]]:
    try:
        rows = await coro
        if isinstance(rows, dict):
            return list(rows.get("results") or [])
        return list(rows or [])
    except Exception as exc:
        _log.warning("multi_academic source %s failed: %s", name, exc)
        return []


def _top_hits(rows: list[dict[str, str]], limit: int = 3) -> list[dict[str, str]]:
    from app.agents.url_list import title_from_search_hit

    out: list[dict[str, str]] = []
    for row in rows:
        url = str(row.get("url") or "").strip()
        if not url:
            continue
        title = str(row.get("title") or "").strip()
        if not title or title == url:
            title = title_from_search_hit(row)
        out.append({"url": url, "title": (title or url)[:200]})
        if len(out) >= limit:
            break
    return out


def _top_urls(rows: list[dict[str, str]], limit: int = 3) -> list[str]:
    return [h["url"] for h in _top_hits(rows, limit=limit)]


def _source_coro(
    name: str,
    query: str,
    *,
    per_source: int,
    min_year: int,
    s2_api_key: str,
):
    q = sanitize_academic_search_query(query)
    if name == "openalex":
        return openalex_provider.search(
            q,
            max_results=per_source,
            include_domains=None,
        )
    if name == "arxiv":
        return arxiv.search(q, limit=per_source, min_year=min_year)
    if name == "crossref":
        return crossref.search(q, limit=per_source, min_year=min_year)
    if name == "pubmed":
        return pubmed.search(q, limit=per_source, min_year=min_year)
    if name == "semantic_scholar":
        return semantic_scholar.search(
            q,
            limit=per_source,
            min_year=min_year,
            api_key=s2_api_key,
        )
    raise KeyError(name)


async def _search_one_source(
    name: str,
    query: str,
    *,
    max_results: int,
    min_year: int,
    s2_api_key: str,
    max_retries: int = 0,
    delay_ms: int = 500,
) -> tuple[str, list[dict[str, str]], bool]:
    """Run one source for one query; holds the global per-source slot.

    Retries up to *max_retries* additional times when the source returns
    zero results or fails.  Breaks out of the retry loop as soon as any
    attempt yields hits > 0.
    """
    per_source = max(1, int(max_results))
    attempts = max(0, max_retries) + 1
    best_rows: list[dict[str, str]] = []
    best_failed = True

    async with source_slot(name):
        for attempt in range(attempts):
            _, rows, failed = await _bounded(
                name,
                _source_coro(
                    name,
                    query,
                    per_source=per_source,
                    min_year=min_year,
                    s2_api_key=s2_api_key,
                ),
            )
            if rows:
                best_rows = rows
                best_failed = failed
                break
            if not failed:
                best_rows = rows
                best_failed = False
            if attempt + 1 < attempts and delay_ms > 0:
                await asyncio.sleep(delay_ms / 1000.0)

    return name, best_rows, best_failed


async def _bounded(name: str, coro) -> tuple[str, list[dict[str, str]], bool]:
    timeout = SOURCE_TIMEOUTS.get(name, SOURCE_TIMEOUT_SEC)
    try:
        async with asyncio.timeout(timeout):
            rows = await _run_source(name, coro)
        return name, rows, False
    except TimeoutError:
        _log.warning("multi_academic source %s timed out after %.0fs", name, timeout)
        return name, [], True
    except Exception as exc:
        _log.warning("multi_academic source %s failed: %s", name, exc)
        return name, [], True


def _source_done_payload(
    name: str,
    rows: list[dict[str, str]],
    *,
    max_results: int,
    failed: bool,
    query: str,
) -> dict[str, Any]:
    found = len(rows)
    taken = min(found, max_results)
    return {
        "source": name,
        "label": SOURCE_LABELS.get(name, name),
        "query": query,
        "hits": found,
        "hits_found": found,
        "hits_taken": taken,
        "max_results": max_results,
        "top_urls": _top_urls(rows[:max_results]),
        "top_hits": _top_hits(rows[:max_results]),
        "failed": failed,
    }


async def search(
    query: str,
    *,
    max_results: int = 8,
    min_year: int = DEFAULT_MIN_YEAR,
    include_domains: list[str] | tuple[str, ...] | None = None,
    exclude_domains: list[str] | tuple[str, ...] | None = None,
    s2_api_key: str = "",
    **_kwargs: Any,
) -> dict[str, Any]:
    merged: dict[str, Any] = {"results": [], "answer": "", "source_counts": {}}
    async for kind, payload in iter_search_events(
        query,
        max_results=max_results,
        min_year=min_year,
        include_domains=include_domains,
        exclude_domains=exclude_domains,
        s2_api_key=s2_api_key,
    ):
        if kind == "complete":
            merged = payload
    return merged


async def iter_search_events(
    query: str,
    *,
    max_results: int = 8,
    min_year: int = DEFAULT_MIN_YEAR,
    include_domains: list[str] | tuple[str, ...] | None = None,
    exclude_domains: list[str] | tuple[str, ...] | None = None,
    s2_api_key: str = "",
    source_queries: Mapping[str, str] | None = None,
    skip_sources: frozenset[str] | None = None,
    source_locks: dict[str, asyncio.Lock] | None = None,
    seen_source_hits: set[str] | None = None,
    search_retry_count: int = 0,
    search_retry_delay_ms: int = 500,
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """Single pass: parallel across sources (each source at most one slot).

    When *source_locks* and *seen_source_hits* are provided, each source
    acquires a per-source lock before searching. After the lock is acquired
    it double-checks *seen_source_hits* — if another subtopic already found
    hits for this source, the search is skipped (no redundant query).
    """
    _ = exclude_domains
    q = (query or "").strip()
    if len(q) < 2:
        yield ("complete", {"results": [], "answer": "", "source_counts": {}})
        return

    per_source = max(1, int(max_results))
    sq = dict(source_queries or {})
    skip = skip_sources or frozenset()

    _retry_kwargs = dict(
        max_retries=max(0, search_retry_count),
        delay_ms=max(0, search_retry_delay_ms),
    )

    async def _run_one(name: str) -> tuple[str, list[dict[str, str]], bool, bool]:
        if name in skip:
            return name, [], False, True
        source_q = query_for_source(name, source_queries=sq, fallback=q)
        if len(source_q) < 2:
            return name, [], False, True
        # Per-source lock: if this source is being searched concurrently by
        # another subtopic, wait for it; then double-check seen_source_hits.
        lock = (source_locks or {}).setdefault(name, asyncio.Lock()) if source_locks is not None else None
        if lock:
            async with lock:
                if seen_source_hits and name in seen_source_hits:
                    return name, [], False, True
                _name, rows, failed = await _search_one_source(
                    name,
                    source_q,
                    max_results=max_results,
                    min_year=min_year,
                    s2_api_key=s2_api_key,
                    **_retry_kwargs,
                )
                # Record result into seen_source_hits *inside* the lock so that
                # another subtopic waiting on this lock immediately sees it.
                if seen_source_hits is not None and rows:
                    seen_source_hits.add(name)
        else:
            _name, rows, failed = await _search_one_source(
                name,
                source_q,
                max_results=max_results,
                min_year=min_year,
                s2_api_key=s2_api_key,
                **_retry_kwargs,
            )
        return _name, rows, failed, False

    tasks: dict[str, asyncio.Task[tuple[str, list[dict[str, str]], bool, bool]]] = {}
    for name in SOURCE_NAMES:
        if name in skip:
            continue
        tasks[name] = asyncio.create_task(_run_one(name))

    by_name: dict[str, list[dict[str, str]]] = {}
    skipped_names: set[str] = set()
    pending = set(tasks.keys())
    loop_deadline = time.monotonic() + SOURCE_TIMEOUT_SEC + 15.0
    try:
        while pending:
            wait_sec = max(0.1, loop_deadline - time.monotonic())
            if wait_sec <= 0:
                _log.warning(
                    "multi_academic gather deadline exceeded; pending=%s query=%r",
                    sorted(pending),
                    q[:80],
                )
                break
            done_set, _pending_set = await asyncio.wait(
                [tasks[n] for n in pending],
                timeout=wait_sec,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if not done_set:
                _log.warning(
                    "multi_academic wait stalled; pending=%s query=%r",
                    sorted(pending),
                    q[:80],
                )
                break
            for finished in done_set:
                name, rows, failed, skipped = await finished
                pending.discard(name)
                if skipped:
                    skipped_names.add(name)
                    continue
                by_name[name] = rows
                source_q = query_for_source(name, source_queries=sq, fallback=q)
                yield (
                    "source_start",
                    {
                        "source": name,
                        "label": SOURCE_LABELS.get(name, name),
                        "query": source_q,
                        "max_results": max_results,
                    },
                )
                yield (
                    "source_done",
                    _source_done_payload(
                        name,
                        rows,
                        max_results=max_results,
                        failed=failed,
                        query=q,
                    ),
                )
    finally:
        for task in tasks.values():
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks.values(), return_exceptions=True)

    for name in pending:
        if name in skipped_names:
            continue
        by_name.setdefault(name, [])
        yield (
            "source_done",
            _source_done_payload(
                name,
                [],
                max_results=max_results,
                failed=True,
                query=q,
            ),
        )

    async for kind, payload in _complete_from_by_name(
        by_name,
        query=q,
        max_results=max_results,
        per_source=per_source,
        include_domains=include_domains,
    ):
        yield kind, payload


async def _complete_from_by_name(
    by_name: dict[str, list[dict[str, str]]],
    *,
    query: str,
    max_results: int,
    per_source: int,
    include_domains: list[str] | tuple[str, ...] | None,
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    from app.agents.search_merge import merge_search_hits

    hit_lists = [rows for rows in by_name.values() if rows]
    raw_found_total = sum(len(rows) for rows in by_name.values())
    merged = merge_search_hits(hit_lists)
    if include_domains:
        merged = restrict_hits_to_domains(merged, include_domains=include_domains)

    counts = {k: len(v) for k, v in by_name.items()}
    _log.info(
        "multi_academic query=%r per_source=%s counts=%s merged=%s",
        query[:80],
        per_source,
        counts,
        len(merged),
    )
    yield (
        "complete",
        {
            "results": merged,
            "answer": "",
            "source_counts": counts,
            "per_source": per_source,
            "raw_found_total": raw_found_total,
            "hits_taken": len(merged),
        },
    )


async def iter_multi_pass_by_source_events(
    passes: list[PassSpec],
    *,
    min_year: int = DEFAULT_MIN_YEAR,
    include_domains: list[str] | tuple[str, ...] | None = None,
    exclude_domains: list[str] | tuple[str, ...] | None = None,
    s2_api_key: str = "",
    search_retry_count: int = 0,
    search_retry_delay_ms: int = 500,
) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    """Multi pass: one worker per source; topics serialized per source, sources in parallel."""
    _ = exclude_domains
    if not passes:
        return

    event_q: asyncio.Queue[tuple[str, dict[str, Any]] | None] = asyncio.Queue()
    pass_rows: dict[int, dict[str, list[dict[str, str]]]] = {
        spec.pass_index: {} for spec in passes
    }

    _retry_kwargs = dict(
        max_retries=max(0, search_retry_count),
        delay_ms=max(0, search_retry_delay_ms),
    )

    async def _source_worker(source_name: str) -> None:
        for spec in passes:
            if source_name in spec.skip_sources:
                continue
            q = query_for_source(
                source_name,
                source_queries=dict(spec.source_queries or {}),
                fallback=(spec.query or "").strip(),
            )
            if len(q) < 2:
                continue
            pass_meta = {
                "query": q,
                "pass_index": spec.pass_index,
                "pass_total": spec.pass_total,
                "topic_title": spec.topic_title or "",
                "provider": "multi_academic",
            }
            await event_q.put(
                (
                    "source_start",
                    {
                        **pass_meta,
                        "source": source_name,
                        "label": SOURCE_LABELS.get(source_name, source_name),
                        "max_results": spec.max_results,
                    },
                ),
            )
            _name, rows, failed = await _search_one_source(
                source_name,
                q,
                max_results=spec.max_results,
                min_year=min_year,
                s2_api_key=s2_api_key,
                **_retry_kwargs,
            )
            pass_rows[spec.pass_index][source_name] = rows
            await event_q.put(
                (
                    "source_done",
                    {
                        **pass_meta,
                        **_source_done_payload(
                            source_name,
                            rows,
                            max_results=spec.max_results,
                            failed=failed,
                            query=q,
                        ),
                    },
                ),
            )
        await event_q.put(None)

    workers = [asyncio.create_task(_source_worker(name)) for name in SOURCE_NAMES]
    finished_workers = 0
    in_flight: dict[tuple[int, str], dict[str, Any]] = {}
    loop_deadline = time.monotonic() + len(passes) * (
        SOURCE_TIMEOUT_SEC + MULTI_PASS_EXTRA_SEC
    ) + MULTI_PASS_EXTRA_SEC
    stalled = False
    try:
        while finished_workers < len(workers):
            if time.monotonic() >= loop_deadline:
                _log.warning(
                    "multi_academic multi_pass deadline exceeded; in_flight=%s",
                    sorted(in_flight.keys()),
                )
                stalled = True
                break
            try:
                item = await asyncio.wait_for(
                    event_q.get(),
                    timeout=MULTI_PASS_EVENT_POLL_SEC,
                )
            except TimeoutError:
                continue
            if item is None:
                finished_workers += 1
                continue
            kind, payload = item
            key = (int(payload.get("pass_index") or 0), str(payload.get("source") or ""))
            if kind == "source_start" and key[0] > 0 and key[1]:
                in_flight[key] = payload
            elif kind == "source_done":
                in_flight.pop(key, None)
            yield kind, payload
    finally:
        for w in workers:
            if not w.done():
                w.cancel()
        await asyncio.gather(*workers, return_exceptions=True)

    if stalled:
        for (pass_index, source_name), meta in list(in_flight.items()):
            q = str(meta.get("query") or "")
            pass_rows.setdefault(pass_index, {})[source_name] = []
            yield (
                "source_done",
                {
                    **meta,
                    **_source_done_payload(
                        source_name,
                        [],
                        max_results=int(meta.get("max_results") or 8),
                        failed=True,
                        query=q,
                    ),
                },
            )

    from app.agents.search_merge import merge_search_hits

    for spec in passes:
        q = (spec.query or "").strip()
        by_name = pass_rows.get(spec.pass_index) or {}
        hit_lists = [rows for rows in by_name.values() if rows]
        raw_found_total = sum(len(rows) for rows in by_name.values())
        merged = merge_search_hits(hit_lists)
        if include_domains:
            merged = restrict_hits_to_domains(merged, include_domains=include_domains)
        counts = {k: len(v) for k, v in by_name.items()}
        yield (
            "pass_complete",
            {
                "pass_index": spec.pass_index,
                "pass_total": spec.pass_total,
                "query": q,
                "topic_title": spec.topic_title,
                "results": merged,
                "source_counts": counts,
                "raw_found_total": raw_found_total,
                "hits_taken": len(merged),
            },
        )
