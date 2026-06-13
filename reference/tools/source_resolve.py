"""Resolve landing pages to PDF / full-text fetch URLs (OJS, citation meta, S2, pdf.js)."""
from __future__ import annotations

import re
from html import unescape
from typing import Any
from urllib.parse import unquote, urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from app.agents.retry_utils import retry_async
from app.agents.ttl_cache import TTLCache, normalize_cache_key
from app.agents.tools.metadata_fetch import (
    browser_headers,
    extract_doi_from_url,
    fetch_unpaywall_oa_pdf,
    is_paywalled_host,
    resolve_doi_redirect_url,
)

_s2_paper_cache: TTLCache[dict[str, Any]] = TTLCache(max_entries=128, ttl_sec=3600)

_OJS_DOWNLOAD_RE = re.compile(
    r'href=["\']([^"\']*/(?:article/download|viewFile)/[^"\']+)["\']',
    re.I,
)
_PDFJS_FILE_RE = re.compile(r"file=([^&\"']+)", re.I)
_S2_PAPER_ID_RE = re.compile(
    r"semanticscholar\.org/paper/[^/]+/([a-f0-9]{40})\b",
    re.I,
)
_S2_SHORT_RE = re.compile(
    r"semanticscholar\.org/paper/([a-f0-9]{40})\b",
    re.I,
)
_CITATION_PDF_META_RE = re.compile(
    r'<meta[^>]+name=["\']citation_pdf_url["\'][^>]+content=["\']([^"\']+)["\']',
    re.I,
)
_CITATION_PDF_META_RE2 = re.compile(
    r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']citation_pdf_url["\']',
    re.I,
)


def extract_citation_pdf_url(html: str) -> str | None:
    if not html:
        return None
    for pat in (_CITATION_PDF_META_RE, _CITATION_PDF_META_RE2):
        m = pat.search(html)
        if m:
            url = unescape(m.group(1).strip())
            if url.startswith(("http://", "https://")):
                return url
    soup = BeautifulSoup(html, "lxml")
    tag = soup.find("meta", attrs={"name": "citation_pdf_url"})
    if tag and tag.get("content"):
        url = str(tag["content"]).strip()
        if url.startswith(("http://", "https://")):
            return url
    return None


def extract_pdfjs_embedded_url(html: str, page_url: str) -> str | None:
    if not html:
        return None
    for m in _PDFJS_FILE_RE.finditer(html):
        raw = unquote(m.group(1).strip())
        if raw.startswith(("http://", "https://")):
            return raw
        if raw.startswith("/"):
            return urljoin(page_url, raw)
    return None


def extract_ojs_download_url(html: str, page_url: str) -> str | None:
    pdf = extract_citation_pdf_url(html)
    if pdf:
        return pdf
    for m in _OJS_DOWNLOAD_RE.finditer(html or ""):
        href = m.group(1).strip()
        if href and "download" in href.lower():
            return urljoin(page_url, href)
    return None


def semantic_scholar_paper_id(url: str) -> str | None:
    for pat in (_S2_PAPER_ID_RE, _S2_SHORT_RE):
        m = pat.search(url or "")
        if m:
            return m.group(1)
    return None


def is_pdf_bytes(raw: bytes) -> bool:
    return bool(raw) and raw[:5] == b"%PDF-"


def is_pdf_content_type(content_type: str) -> bool:
    return "pdf" in (content_type or "").lower()


_S2_RESOLVE_FIELDS = "openAccessPdf,externalIds"
_FETCH_HEADERS = browser_headers()


def _normalize_doi(raw: str) -> str:
    doi = (raw or "").strip()
    for prefix in ("https://doi.org/", "http://doi.org/", "doi:"):
        if doi.lower().startswith(prefix):
            doi = doi[len(prefix) :]
            break
    return doi.strip()


def _is_doi_url(url: str) -> bool:
    host = (urlparse(url).netloc or "").lower()
    return host == "doi.org" or host.endswith(".doi.org")


async def fetch_s2_paper_record(
    paper_id: str,
    *,
    api_key: str | None = None,
    timeout: float = 30.0,
) -> dict[str, Any]:
    cache_key = normalize_cache_key("s2_paper", paper_id, api_key or "")
    cached = _s2_paper_cache.get(cache_key)
    if cached is not None:
        return cached

    headers: dict[str, str] = {"Accept": "application/json"}
    if api_key:
        headers["x-api-key"] = api_key
    url = f"https://api.semanticscholar.org/graph/v1/paper/{paper_id}"

    async def _once() -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            resp = await client.get(
                url,
                params={"fields": _S2_RESOLVE_FIELDS},
                headers=headers,
            )
            if resp.status_code == 404:
                return {}
            if resp.status_code == 429:
                resp.raise_for_status()
            resp.raise_for_status()
            data = resp.json()
        return data if isinstance(data, dict) else {}

    try:
        data = await retry_async(_once, max_retries=3, delay_ms=2500)
    except Exception:
        return {}

    _s2_paper_cache.set(cache_key, data)
    return data


async def resolve_landing_page_to_pdf_url(
    url: str,
    *,
    client: httpx.AsyncClient | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 60.0,
) -> str | None:
    """Follow redirects (doi.org → publisher); return a direct PDF URL when possible."""
    target = (url or "").strip()
    if not target.startswith(("http://", "https://")):
        return None
    hdrs = headers or _FETCH_HEADERS
    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(timeout=timeout, follow_redirects=True)
    assert client is not None
    try:
        resp = await client.get(target, headers=hdrs)
        resp.raise_for_status()
        final_url = str(resp.url)
        ctype = (resp.headers.get("content-type") or "").lower()
        raw_head = resp.content[:8192]
        if is_pdf_content_type(ctype) or is_pdf_bytes(raw_head):
            return final_url
        html = resp.text or ""
        pdf = resolve_pdf_from_html(html, final_url)
        if pdf and pdf != final_url:
            return pdf
    except Exception:
        return None
    finally:
        if own_client:
            await client.aclose()
    return None


async def resolve_semantic_scholar_fetch_url(
    url: str,
    *,
    api_key: str | None = None,
    timeout: float = 60.0,
    headers: dict[str, str] | None = None,
) -> str | None:
    """S2 → PDF chain: ① openAccessPdf  ②/③ DOI → publisher → citation_pdf_url."""
    paper_id = semantic_scholar_paper_id(url)
    if not paper_id:
        return None
    hdrs = headers or _FETCH_HEADERS
    try:
        data = await fetch_s2_paper_record(
            paper_id,
            api_key=api_key,
            timeout=min(timeout, 30.0),
        )
    except Exception:
        return None
    if not data:
        return None

    oa = data.get("openAccessPdf")
    if isinstance(oa, dict):
        pdf_url = str(oa.get("url") or "").strip()
        if pdf_url.startswith(("http://", "https://")):
            return pdf_url

    ext = data.get("externalIds")
    if isinstance(ext, dict):
        doi = _normalize_doi(str(ext.get("DOI") or ""))
        if doi:
            try:
                oa_pdf = await fetch_unpaywall_oa_pdf(
                    doi,
                    timeout=min(timeout, 15.0),
                )
                if oa_pdf:
                    return oa_pdf
            except Exception:
                pass
            try:
                redirect = await resolve_doi_redirect_url(
                    f"https://doi.org/{doi}",
                    timeout=min(timeout, 15.0),
                    headers=hdrs,
                )
                if redirect and "arxiv.org" in redirect:
                    return redirect
                if redirect and not is_paywalled_host(redirect):
                    landing = await resolve_landing_page_to_pdf_url(
                        redirect,
                        headers=hdrs,
                        timeout=timeout,
                    )
                    if landing:
                        return landing
            except Exception:
                pass
            try:
                landing = await resolve_landing_page_to_pdf_url(
                    f"https://doi.org/{doi}",
                    headers=hdrs,
                    timeout=timeout,
                )
                if landing:
                    return landing
            except Exception:
                pass

    return None


async def fetch_semantic_scholar_open_access_pdf(
    paper_id: str,
    *,
    api_key: str | None = None,
    timeout: float = 30.0,
) -> str | None:
    """Resolve S2 paper id to a fetchable PDF URL (legacy name; full chain)."""
    fake_url = f"https://www.semanticscholar.org/paper/x/{paper_id}"
    return await resolve_semantic_scholar_fetch_url(
        fake_url,
        api_key=api_key,
        timeout=timeout,
    )


def resolve_pdf_from_html(html: str, page_url: str) -> str | None:
    for fn in (extract_citation_pdf_url, lambda h: extract_pdfjs_embedded_url(h, page_url)):
        got = fn(html)
        if got and got != page_url:
            return got
    return extract_ojs_download_url(html, page_url)


async def resolve_fetch_url(
    url: str,
    *,
    client: httpx.AsyncClient | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 60.0,
    s2_api_key: str | None = None,
) -> str:
    """Best-effort resolve to a PDF or stable content URL before full fetch."""
    target = url.strip()
    if not target.startswith(("http://", "https://")):
        target = f"https://{target}"

    hdrs = headers or _FETCH_HEADERS

    if semantic_scholar_paper_id(target):
        try:
            resolved = await resolve_semantic_scholar_fetch_url(
                target,
                api_key=s2_api_key,
                timeout=timeout,
                headers=hdrs,
            )
            if resolved:
                return resolved
        except Exception:
            pass

    if _is_doi_url(target):
        doi = extract_doi_from_url(target)
        if doi:
            try:
                oa_pdf = await fetch_unpaywall_oa_pdf(
                    doi,
                    timeout=min(timeout, 15.0),
                )
                if oa_pdf:
                    return oa_pdf
            except Exception:
                pass
            try:
                redirect = await resolve_doi_redirect_url(
                    target,
                    timeout=min(timeout, 15.0),
                    headers=hdrs,
                )
                if redirect and "arxiv.org" in redirect:
                    return redirect
            except Exception:
                pass
        try:
            redirect = await resolve_doi_redirect_url(
                target,
                timeout=min(timeout, 15.0),
                headers=hdrs,
            )
            if redirect and not is_paywalled_host(redirect):
                resolved = await resolve_landing_page_to_pdf_url(
                    redirect,
                    headers=hdrs,
                    timeout=timeout,
                )
                if resolved:
                    return resolved
        except Exception:
            pass
        try:
            resolved = await resolve_landing_page_to_pdf_url(
                target,
                headers=hdrs,
                timeout=timeout,
            )
            if resolved:
                return resolved
        except Exception:
            pass

    parsed = urlparse(target)
    if parsed.path.lower().endswith(".pdf"):
        return target

    own_client = client is None
    if own_client:
        client = httpx.AsyncClient(timeout=timeout, follow_redirects=True)
    assert client is not None
    try:
        resp = await client.get(target, headers=hdrs)
        resp.raise_for_status()
        ctype = (resp.headers.get("content-type") or "").lower()
        raw = resp.content[:8192]
        if is_pdf_content_type(ctype) or is_pdf_bytes(raw):
            return str(resp.url)
        html = resp.text or ""
        page_url = str(resp.url)
        resolved = resolve_pdf_from_html(html, page_url)
        if resolved and resolved != page_url:
            return resolved
    except Exception:
        return target
    finally:
        if own_client:
            await client.aclose()
    return target
