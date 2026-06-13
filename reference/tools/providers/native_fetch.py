"""Direct HTTP web_fetch (native), inspired by docs/WebFetchTool."""
from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable
from urllib.parse import urljoin, urlparse

import httpx

from app.agents.tools.metadata_fetch import (
    arxiv_abs_url,
    browser_headers,
    fetch_arxiv_abs_page,
    is_junk_fetch_content,
    normalize_native_fetch_url,
    resolve_oa_fetch_urls,
    try_api_abstract_fetch,
    try_jina_reader_fetch,
    try_metadata_only_fallback,
)
from app.agents.tools.pdf_text import pdf_bytes_to_text
from app.agents.tools.source_resolve import (
    is_pdf_bytes,
    is_pdf_content_type,
    resolve_fetch_url,
    resolve_pdf_from_html,
)

_MAX_BYTES = 10 * 1024 * 1024
_MAX_REDIRECTS = 10
_OJS_PDF_RE = re.compile(
    r'href=["\']([^"\']*/(?:article/download|viewFile)/[^"\']+)["\']',
    re.I,
)


@dataclass
class FetchResult:
    text: str
    final_url: str
    resolved_pdf_url: str | None = None
    is_pdf: bool = False
    via_jina: bool = False
    metadata_only: bool = False


def _strip_www(host: str) -> str:
    return host[4:] if host.lower().startswith("www.") else host


def permitted_redirect(original: str, redirect: str) -> bool:
    try:
        a, b = urlparse(original), urlparse(redirect)
        if a.scheme != b.scheme or a.port != b.port:
            return False
        if b.username or b.password:
            return False
        return _strip_www(a.hostname or "") == _strip_www(b.hostname or "")
    except Exception:
        return False


def pick_ojs_pdf_url(html: str, page_url: str) -> str | None:
    resolved = resolve_pdf_from_html(html, page_url)
    if resolved:
        return resolved
    for m in _OJS_PDF_RE.finditer(html or ""):
        href = m.group(1).strip()
        if href:
            return urljoin(page_url, href)
    return None


def _default_headers() -> dict[str, str]:
    return browser_headers()


def _is_useful_text(text: str) -> bool:
    return bool(text.strip()) and not is_junk_fetch_content(text)


async def _direct_http_fetch(
    url: str,
    *,
    timeout: float,
    redirect_checker: Callable[[str, str], bool],
    pdf_extract_backend: str,
    s2_api_key: str | None,
    pre_resolved_pdf: str | None = None,
) -> FetchResult | None:
    """Stage ③ — lightweight httpx fetch (PDF / HTML / OJS)."""
    target = normalize_native_fetch_url(url)
    headers = _default_headers()
    resolved_pdf_url = pre_resolved_pdf

    if arxiv_abs_url(target) == target and "/abs/" in target:
        try:
            text = await fetch_arxiv_abs_page(target, timeout=min(timeout, 30.0))
            if _is_useful_text(text):
                return FetchResult(text=text[:120_000], final_url=target, is_pdf=False)
        except Exception:
            pass

    parsed = urlparse(target)
    if not parsed.path.lower().endswith(".pdf") and not resolved_pdf_url:
        try:
            better = await resolve_fetch_url(
                target,
                timeout=timeout,
                s2_api_key=s2_api_key,
            )
            if better and better != target:
                target = normalize_native_fetch_url(better)
                if "download" in target.lower() or target.lower().endswith(".pdf"):
                    resolved_pdf_url = target
        except Exception:
            pass

    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        current = target
        for _ in range(_MAX_REDIRECTS + 1):
            try:
                resp = await client.get(current, headers=headers)
            except Exception:
                return None
            if resp.status_code in (301, 302, 307, 308):
                loc = resp.headers.get("location")
                if not loc:
                    resp.raise_for_status()
                nxt = urljoin(current, loc)
                if not redirect_checker(current, nxt):
                    break
                current = nxt
                continue
            try:
                resp.raise_for_status()
            except Exception:
                return None
            raw = resp.content[:_MAX_BYTES]
            ctype = (resp.headers.get("content-type") or "").lower()
            final_url = str(resp.url)

            if is_pdf_content_type(ctype) or is_pdf_bytes(raw):
                text = pdf_bytes_to_text(raw, backend=pdf_extract_backend)
                if not _is_useful_text(text):
                    return None
                return FetchResult(
                    text=text[:120_000],
                    final_url=final_url,
                    resolved_pdf_url=resolved_pdf_url or final_url,
                    is_pdf=True,
                )

            text = raw.decode(resp.encoding or "utf-8", errors="replace")
            if "text/html" in ctype or "<html" in text[:2000].lower():
                pdf = pick_ojs_pdf_url(text, final_url)
                if pdf and pdf != current:
                    resolved_pdf_url = pdf
                    current = normalize_native_fetch_url(pdf)
                    continue
            if not _is_useful_text(text):
                return None
            return FetchResult(
                text=text[:120_000],
                final_url=final_url,
                resolved_pdf_url=resolved_pdf_url,
                is_pdf=False,
            )
    return None


async def _try_jina_fallback(
    urls: list[str],
    *,
    api_key: str | None,
    timeout: float,
    original_url: str,
) -> FetchResult | None:
    """Stage ④ — Jina Reader for Cloudflare / anti-bot pages."""
    candidates: list[str] = []
    seen: set[str] = set()
    for u in [original_url, *urls]:
        if u and u not in seen:
            seen.add(u)
            candidates.append(u)

    for candidate in candidates:
        try:
            text = await try_jina_reader_fetch(
                candidate,
                api_key=api_key,
                timeout=timeout,
            )
        except Exception:
            continue
        if _is_useful_text(text):
            return FetchResult(
                text=text[:120_000],
                final_url=candidate,
                via_jina=True,
            )
    return None


async def fetch_bytes(
    url: str,
    *,
    timeout: float = 60.0,
    redirect_checker: Callable[[str, str], bool] | None = None,
    s2_api_key: str | None = None,
    pdf_extract_backend: str = "pymupdf4llm",
    jina_api_key: str | None = None,
) -> FetchResult:
    """
    Staged fetch pipeline:
    ① API abstracts → ② Unpaywall URLs → ③ direct HTTP → ④ Jina → ⑤ metadata-only.
    """
    checker = redirect_checker or permitted_redirect
    target = url.strip()
    if not target.startswith(("http://", "https://")):
        target = f"https://{target}"

    # ① OpenAlex / Crossref / PMC API / Semantic Scholar
    api = await try_api_abstract_fetch(target, timeout=timeout)
    if api:
        text, final_url, resolved_pdf_url, is_pdf = api
        if _is_useful_text(text):
            return FetchResult(
                text=text,
                final_url=final_url,
                resolved_pdf_url=resolved_pdf_url,
                is_pdf=is_pdf,
            )

    # ② Unpaywall → candidate OA URLs
    oa_urls = await resolve_oa_fetch_urls(target, timeout=timeout)

    # ③ Direct HTTP on OA URLs, then original URL
    fetch_queue = [*oa_urls]
    if target not in fetch_queue:
        fetch_queue.append(target)

    for fetch_url in fetch_queue:
        got = await _direct_http_fetch(
            fetch_url,
            timeout=timeout,
            redirect_checker=checker,
            pdf_extract_backend=pdf_extract_backend,
            s2_api_key=s2_api_key,
        )
        if got is not None:
            return got

    # ④ Jina Reader fallback
    if jina_api_key is None:
        from app.agents.agent_settings import get_jina_reader_api_key

        jina_api_key = await get_jina_reader_api_key()
    jina_got = await _try_jina_fallback(
        oa_urls,
        api_key=jina_api_key or None,
        timeout=timeout,
        original_url=target,
    )
    if jina_got is not None:
        return jina_got

    # ⑤ Metadata-only (title/DOI from OpenAlex)
    meta_only = await try_metadata_only_fallback(target, timeout=timeout)
    if meta_only:
        text, final_url, resolved_pdf_url, is_pdf = meta_only
        if _is_useful_text(text):
            return FetchResult(
                text=text,
                final_url=final_url,
                resolved_pdf_url=resolved_pdf_url,
                is_pdf=is_pdf,
                metadata_only=True,
            )

    return FetchResult(text="", final_url=target, is_pdf=False)


async def fetch(
    url: str,
    *,
    timeout: float = 60.0,
    redirect_checker: Callable[[str, str], bool] | None = None,
    s2_api_key: str | None = None,
    pdf_extract_backend: str = "pymupdf4llm",
    jina_api_key: str | None = None,
) -> str:
    """Fetch URL body as text/markdown-ish string (HTML decoded or PDF extracted)."""
    result = await fetch_bytes(
        url,
        timeout=timeout,
        redirect_checker=redirect_checker,
        s2_api_key=s2_api_key,
        pdf_extract_backend=pdf_extract_backend,
        jina_api_key=jina_api_key,
    )
    return result.text
