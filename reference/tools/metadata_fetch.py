"""Metadata-first fetch: OpenAlex / Crossref / Unpaywall before HTML scraping."""
from __future__ import annotations

import re
import urllib.parse
import xml.etree.ElementTree as ET
from typing import Any
from urllib.parse import urlparse

import httpx

from app.agents.tools.pdf_text import pdf_bytes_to_text
from app.agents.retry_utils import retry_async
from app.agents.ttl_cache import TTLCache, normalize_cache_key

_MAILTO = "support@litpilot.local"
_USER_AGENT = f"LitPilot/1.0 (mailto:{_MAILTO})"
_BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/120.0.0.0 Safari/537.36"
)
_MIN_USEFUL_CHARS = 80
_MAX_BYTES = 10 * 1024 * 1024

_PAYWALLED_HOST_FRAGMENTS = (
    "ieeexplore.ieee.org",
    "sciencedirect.com",
    "ncbi.nlm.nih.gov",
    "springer.com",
    "link.springer.com",
    "onlinelibrary.wiley.com",
    "elsevier.com",
)

_openalex_cache: TTLCache[dict[str, Any] | None] = TTLCache(max_entries=256, ttl_sec=3600)
_unpaywall_cache: TTLCache[str | None] = TTLCache(max_entries=256, ttl_sec=3600)
_doi_redirect_cache: TTLCache[str | None] = TTLCache(max_entries=256, ttl_sec=3600)

_ARXIV_ABS_RE = re.compile(
    r"arxiv\.org/(?:abs|pdf)/([\d.]+(?:v\d+)?)",
    re.I,
)
_DOI_IN_PATH_RE = re.compile(r"10\.\d{4,9}/[-._;()/:A-Z0-9]+", re.I)
_PMC_ID_RE = re.compile(r"(PMC\d+)", re.I)
_SSRN_HOSTS = ("ssrn.com", "papers.ssrn.com")

_JUNK_CONTENT_PATTERNS = (
    re.compile(r"preparing to download", re.I),
    re.compile(r"hhs vulnerability disclosure", re.I),
    re.compile(r"g-recaptcha|recaptcha", re.I),
    re.compile(r"verify you are human", re.I),
    re.compile(r"are you a robot", re.I),
    re.compile(r"just a moment", re.I),
    re.compile(r"challenges\.cloudflare\.com", re.I),
)
_SSRN_ID_RE = re.compile(r"10\.2139/ssrn\.(\d+)", re.I)

_europepmc_cache: TTLCache[tuple[str, str, str]] = TTLCache(max_entries=256, ttl_sec=3600)


def normalize_doi(raw: str) -> str:
    d = (raw or "").strip().rstrip(".")
    d = re.sub(r"^https?://(dx\.)?doi\.org/", "", d, flags=re.I)
    m = _DOI_IN_PATH_RE.search(d)
    return m.group(0) if m else d


def browser_headers() -> dict[str, str]:
    return {
        "Accept": "text/html,application/xhtml+xml,text/plain,application/pdf,*/*",
        "User-Agent": _BROWSER_UA,
    }


def is_doi_url(url: str) -> bool:
    host = (urlparse(url).netloc or "").lower()
    return host in ("doi.org", "dx.doi.org") or host.endswith(".doi.org")


def is_paywalled_host(url: str) -> bool:
    host = (urlparse(url).netloc or "").lower()
    return any(frag in host for frag in _PAYWALLED_HOST_FRAGMENTS)


def is_junk_fetch_content(text: str) -> bool:
    """Detect anti-bot placeholders and other non-content fetch results."""
    body = (text or "").strip()
    if not body:
        return True
    lower = body.lower()
    if any(pat.search(lower) for pat in _JUNK_CONTENT_PATTERNS):
        return True
    if "preparing to download" in lower and len(body) < 400:
        return True
    return False


def extract_pmc_id_from_url(url: str) -> str:
    m = _PMC_ID_RE.search(url or "")
    if not m:
        return ""
    return m.group(1).upper()


def is_pmc_url(url: str) -> bool:
    host = (urlparse(url).netloc or "").lower()
    return "ncbi.nlm.nih.gov" in host and bool(extract_pmc_id_from_url(url))


def is_ssrn_host(host: str) -> bool:
    h = (host or "").lower().lstrip("www.")
    return any(h == s or h.endswith(f".{s}") for s in _SSRN_HOSTS)


def is_ssrn_url(url: str) -> bool:
    return is_ssrn_host(urlparse(url).netloc or "")


def is_ssrn_doi(doi: str) -> bool:
    d = normalize_doi(doi).lower()
    return d.startswith("10.2139/ssrn")


def ssrn_abstract_id_from_doi(doi: str) -> str:
    m = _SSRN_ID_RE.search(normalize_doi(doi))
    return m.group(1) if m else ""


def ssrn_page_url_from_doi(doi: str) -> str:
    aid = ssrn_abstract_id_from_doi(doi)
    if not aid:
        return ""
    return f"https://papers.ssrn.com/sol3/papers.cfm?abstract_id={aid}"


def _pmc_numeric_id(pmc_id: str) -> str:
    return (pmc_id or "").upper().removeprefix("PMC")


def extract_doi_from_url(url: str) -> str:
    """Extract normalized DOI from doi.org URL or embedded DOI in path."""
    if not url:
        return ""
    if is_doi_url(url):
        path = urlparse(url).path.lstrip("/")
        return normalize_doi(path)
    m = _DOI_IN_PATH_RE.search(url)
    if m:
        return normalize_doi(m.group(0))
    return ""


def arxiv_abs_url(url: str) -> str | None:
    """Normalize arxiv URL to /abs/ page for abstract HTML."""
    m = _ARXIV_ABS_RE.search(url or "")
    if not m:
        return None
    paper_id = m.group(1).rstrip(".pdf")
    return f"https://arxiv.org/abs/{paper_id}"


def normalize_native_fetch_url(url: str) -> str:
    """Native fetch URL normalization (arxiv /abs/ kept for HTML abstract)."""
    target = url.strip()
    if not target.startswith(("http://", "https://")):
        target = f"https://{target}"
    parsed = urlparse(target)
    if parsed.netloc.lower() == "arxiv.org" and parsed.path.startswith("/pdf/"):
        paper_id = parsed.path.removeprefix("/pdf/").strip("/")
        if paper_id:
            suffix = "" if paper_id.endswith(".pdf") else ".pdf"
            return f"https://arxiv.org/pdf/{paper_id}{suffix}"
    return target


def reconstruct_openalex_abstract(work: dict[str, Any]) -> str:
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
            return " ".join(w for _, w in pos_word)
    recon = work.get("abstract")
    if isinstance(recon, str):
        return recon.strip()
    return ""


def _openalex_title(work: dict[str, Any]) -> str:
    return str(work.get("title") or work.get("display_name") or "").strip()


def format_metadata_text(
    *,
    title: str,
    abstract: str,
    source_url: str,
    doi: str = "",
    metadata_source: str = "OpenAlex",
) -> str:
    header = f"# {title or 'Untitled'}\n\n"
    header += f"来源: {source_url}\n"
    if doi:
        header += f"DOI: {doi}\n"
    header += f"元数据来源: {metadata_source}\n\n"
    header += f"## 摘要\n\n{abstract.strip()}\n"
    return header[:120_000]


def format_metadata_only_text(
    *,
    title: str,
    source_url: str,
    doi: str = "",
    metadata_source: str = "OpenAlex",
) -> str:
    header = f"# {title or 'Untitled'}\n\n"
    header += f"来源: {source_url}\n"
    if doi:
        header += f"DOI: {doi}\n"
    header += f"元数据来源: {metadata_source}\n"
    header += "获取状态: 仅元数据（未能获取摘要或全文）\n\n"
    header += "## 摘要\n\n（未能获取摘要或全文，仅保留书目元数据。）\n"
    return header[:120_000]


def _meta_tuple(
    text: str,
    final_url: str,
    *,
    resolved_pdf_url: str | None = None,
    is_pdf: bool = False,
) -> tuple[str, str, str | None, bool]:
    return text, final_url, resolved_pdf_url, is_pdf


async def fetch_crossref_abstract_by_doi(
    doi: str,
    *,
    timeout: float = 10.0,
) -> tuple[str, str]:
    """Return (title, abstract) from Crossref API."""
    d = normalize_doi(doi)
    if not d:
        return "", ""
    url = f"https://api.crossref.org/works/{urllib.parse.quote(d)}"
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            resp = await client.get(url, headers={"User-Agent": _USER_AGENT})
            if resp.status_code == 404:
                return "", ""
            resp.raise_for_status()
            data = resp.json()
    except Exception:
        return "", ""
    msg = data.get("message") or {}
    if not isinstance(msg, dict):
        return "", ""
    title_list = msg.get("title") or []
    title = str(title_list[0]).strip() if title_list else ""
    abstract_raw = str(msg.get("abstract") or "").strip()
    abstract = re.sub(r"<[^>]+>", " ", abstract_raw)
    abstract = re.sub(r"\s+", " ", abstract).strip()
    return title, abstract


async def fetch_openalex_work_by_doi(
    doi: str,
    *,
    timeout: float = 15.0,
) -> dict[str, Any] | None:
    d = normalize_doi(doi)
    if not d:
        return None
    cache_key = normalize_cache_key("openalex_doi", d)
    cached = _openalex_cache.get(cache_key)
    if cached is not None:
        return cached or None

    encoded = urllib.parse.quote(f"https://doi.org/{d}", safe="")
    url = f"https://api.openalex.org/works/{encoded}?mailto={_MAILTO}"

    async def _load() -> dict[str, Any] | None:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            resp = await client.get(url, headers={"User-Agent": _USER_AGENT})
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            data = resp.json()
        return data if isinstance(data, dict) else None

    try:
        work = await _load()
    except Exception:
        work = None
    _openalex_cache.set(cache_key, work or {})
    return work


async def fetch_unpaywall_oa_pdf(
    doi: str,
    *,
    timeout: float = 12.0,
) -> str | None:
    d = normalize_doi(doi)
    if not d:
        return None
    cache_key = normalize_cache_key("unpaywall", d)
    cached = _unpaywall_cache.get(cache_key)
    if cached is not None:
        return cached or None

    url = f"https://api.unpaywall.org/v2/{urllib.parse.quote(d, safe='')}"

    async def _load() -> str | None:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            resp = await client.get(
                url,
                params={"email": _MAILTO},
                headers={"User-Agent": _USER_AGENT},
            )
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            data = resp.json()
        if not isinstance(data, dict):
            return None
        best = data.get("best_oa_location") or {}
        if isinstance(best, dict):
            for key in ("url_for_pdf", "url"):
                candidate = str(best.get(key) or "").strip()
                if candidate.startswith(("http://", "https://")):
                    return candidate
        for loc in data.get("oa_locations") or []:
            if not isinstance(loc, dict):
                continue
            for key in ("url_for_pdf", "url"):
                candidate = str(loc.get(key) or "").strip()
                if candidate.startswith(("http://", "https://")):
                    return candidate
        return None

    try:
        pdf_url = await _load()
    except Exception:
        pdf_url = None
    _unpaywall_cache.set(cache_key, pdf_url or "")
    return pdf_url


async def resolve_doi_redirect_url(
    doi_url: str,
    *,
    timeout: float = 15.0,
    headers: dict[str, str] | None = None,
) -> str | None:
    """HEAD/GET follow redirects; return final URL without fetching publisher HTML."""
    target = (doi_url or "").strip()
    if not target.startswith(("http://", "https://")):
        return None
    cache_key = normalize_cache_key("doi_redirect", target)
    cached = _doi_redirect_cache.get(cache_key)
    if cached is not None:
        return cached or None

    hdrs = headers or browser_headers()

    async def _load() -> str | None:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            try:
                resp = await client.head(target, headers=hdrs)
                if resp.status_code >= 400:
                    resp = await client.get(target, headers=hdrs)
                resp.raise_for_status()
                return str(resp.url)
            except Exception:
                return None

    final = await _load()
    _doi_redirect_cache.set(cache_key, final or "")
    return final


def extract_arxiv_abstract(html: str) -> str:
    if not html:
        return ""
    m = re.search(
        r'<blockquote[^>]*class=["\']abstract[^"\']*["\'][^>]*>(.*?)</blockquote>',
        html,
        re.I | re.S,
    )
    if m:
        text = re.sub(r"<[^>]+>", " ", m.group(1))
        text = re.sub(r"\s+", " ", text).strip()
        text = re.sub(r"^Abstract:\s*", "", text, flags=re.I)
        return text
    m = re.search(r'<meta[^>]+name=["\']citation_abstract["\'][^>]+content=["\']([^"\']+)', html, re.I)
    if m:
        return m.group(1).strip()
    return ""


def _strip_html_text(raw: str) -> str:
    text = re.sub(r"<[^>]+>", " ", raw or "")
    return re.sub(r"\s+", " ", text).strip()


async def fetch_ncbi_pmc_by_pmcid(
    pmc_id: str,
    *,
    timeout: float = 20.0,
) -> tuple[str, str, str]:
    """Return (title, abstract, doi) via NCBI E-utilities efetch (JATS XML)."""
    numeric = _pmc_numeric_id(pmc_id)
    if not numeric.isdigit():
        return "", "", ""
    cache_key = normalize_cache_key("ncbi_pmc", numeric)
    cached = _europepmc_cache.get(cache_key)
    if cached is not None:
        return cached

    params = {"db": "pmc", "id": numeric, "retmode": "xml"}

    async def _load() -> tuple[str, str, str]:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            resp = await client.get(
                "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi",
                params=params,
                headers={"User-Agent": _USER_AGENT},
            )
            resp.raise_for_status()
            root = ET.fromstring(resp.text)
        title = ""
        for node in root.iter("article-title"):
            title = _strip_html_text("".join(node.itertext()))
            if title:
                break
        abstract = ""
        for node in root.iter("abstract"):
            abstract = _strip_html_text("".join(node.itertext()))
            if abstract:
                break
        doi = ""
        for node in root.iter("article-id"):
            if (node.attrib.get("pub-id-type") or "").lower() == "doi":
                doi = normalize_doi("".join(node.itertext()))
                if doi:
                    break
        return title, abstract, doi

    try:
        row = await _load()
    except Exception:
        row = ("", "", "")
    _europepmc_cache.set(cache_key, row)
    return row


async def fetch_pmc_metadata_by_pmcid(
    pmc_id: str,
    *,
    timeout: float = 20.0,
) -> tuple[str, str, str]:
    """PMC metadata: NCBI efetch first, Europe PMC API as fallback."""
    title, abstract, doi = await fetch_ncbi_pmc_by_pmcid(pmc_id, timeout=timeout)
    if len(abstract) >= _MIN_USEFUL_CHARS:
        return title, abstract, doi
    return await fetch_europe_pmc_by_pmcid(pmc_id, timeout=timeout)


async def fetch_pmc_metadata_by_doi(
    doi: str,
    *,
    timeout: float = 20.0,
) -> tuple[str, str, str]:
    """Resolve PMC article by DOI via NCBI esearch, then efetch abstract."""
    d = normalize_doi(doi)
    if not d:
        return "", "", ""
    cache_key = normalize_cache_key("ncbi_pmc_doi", d)
    cached = _europepmc_cache.get(cache_key)
    if cached is not None:
        return cached

    async def _search() -> str:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            resp = await client.get(
                "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi",
                params={"db": "pmc", "term": d, "retmode": "json", "retmax": "1"},
                headers={"User-Agent": _USER_AGENT},
            )
            resp.raise_for_status()
            data = resp.json()
        ids = (data.get("esearchresult") or {}).get("idlist") or []
        return str(ids[0]) if ids else ""

    try:
        numeric = await _search()
    except Exception:
        numeric = ""
    row = ("", "", "")
    if numeric:
        row = await fetch_ncbi_pmc_by_pmcid(f"PMC{numeric}", timeout=timeout)
    _europepmc_cache.set(cache_key, row)
    return row


async def fetch_s2_abstract_by_doi(
    doi: str,
    *,
    timeout: float = 15.0,
    api_key: str | None = None,
) -> tuple[str, str]:
    d = normalize_doi(doi)
    if not d:
        return "", ""
    headers: dict[str, str] = {"Accept": "application/json"}
    if api_key:
        headers["x-api-key"] = api_key
    url = f"https://api.semanticscholar.org/graph/v1/paper/DOI:{urllib.parse.quote(d, safe='')}"

    async def _once() -> tuple[str, str]:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            resp = await client.get(
                url,
                params={"fields": "title,abstract"},
                headers=headers,
            )
            if resp.status_code == 404:
                return "", ""
            if resp.status_code == 429:
                resp.raise_for_status()
            resp.raise_for_status()
            data = resp.json()
        if not isinstance(data, dict):
            return "", ""
        title = str(data.get("title") or "").strip()
        abstract = str(data.get("abstract") or "").strip()
        return title, abstract

    try:
        title, abstract = await retry_async(_once, max_retries=3, delay_ms=2500)
    except Exception:
        return "", ""
    return title, abstract


async def fetch_europe_pmc_by_pmcid(
    pmc_id: str,
    *,
    timeout: float = 15.0,
) -> tuple[str, str, str]:
    """Return (title, abstract, doi) from Europe PMC REST API."""
    pid = (pmc_id or "").strip().upper()
    if not pid.startswith("PMC"):
        return "", "", ""
    cache_key = normalize_cache_key("europepmc", pid)
    cached = _europepmc_cache.get(cache_key)
    if cached is not None:
        return cached

    query = urllib.parse.urlencode({
        "query": f"PMCID:{pid}",
        "format": "json",
        "pageSize": "1",
    })
    url = f"https://www.ebi.ac.uk/europepmc/webservices/rest/search?{query}"

    async def _load() -> tuple[str, str, str]:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            resp = await client.get(url, headers={"User-Agent": _USER_AGENT})
            resp.raise_for_status()
            data = resp.json()
        results = (data.get("resultList") or {}).get("result") or []
        if not results or not isinstance(results[0], dict):
            return "", "", ""
        row = results[0]
        title = str(row.get("title") or "").strip()
        abstract = _strip_html_text(str(row.get("abstractText") or ""))
        doi = normalize_doi(str(row.get("doi") or ""))
        return title, abstract, doi

    try:
        row = await _load()
    except Exception:
        row = ("", "", "")
    _europepmc_cache.set(cache_key, row)
    return row


def extract_ssrn_abstract(html: str) -> str:
    if not html:
        return ""
    for pat in (
        r'<meta[^>]+name=["\']citation_abstract["\'][^>]+content=["\']([^"\']+)',
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+name=["\']citation_abstract["\']',
        r'<meta[^>]+property=["\']og:description["\'][^>]+content=["\']([^"\']+)',
    ):
        m = re.search(pat, html, re.I | re.S)
        if m:
            text = _strip_html_text(m.group(1))
            if len(text) >= _MIN_USEFUL_CHARS:
                return text
    m = re.search(
        r'<div[^>]+class=["\'][^"\']*abstract[^"\']*["\'][^>]*>(.*?)</div>',
        html,
        re.I | re.S,
    )
    if m:
        text = _strip_html_text(m.group(1))
        if len(text) >= _MIN_USEFUL_CHARS:
            return text
    return ""


async def fetch_ssrn_page(
    page_url: str,
    *,
    timeout: float = 30.0,
) -> str:
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        resp = await client.get(page_url, headers=browser_headers())
        resp.raise_for_status()
        html = resp.text or ""
        final_url = str(resp.url)
    abstract = extract_ssrn_abstract(html)
    if len(abstract) < _MIN_USEFUL_CHARS:
        return ""
    title_m = re.search(
        r'<meta[^>]+name=["\']citation_title["\'][^>]+content=["\']([^"\']+)',
        html,
        re.I,
    )
    title = title_m.group(1).strip() if title_m else ""
    doi_m = re.search(
        r'<meta[^>]+name=["\']citation_doi["\'][^>]+content=["\']([^"\']+)',
        html,
        re.I,
    )
    doi = normalize_doi(doi_m.group(1)) if doi_m else ""
    return format_metadata_text(
        title=title,
        abstract=abstract,
        source_url=final_url,
        doi=doi,
        metadata_source="SSRN",
    )


async def fetch_arxiv_abs_page(
    abs_url: str,
    *,
    timeout: float = 30.0,
) -> str:
    """Fetch arxiv /abs/ page and return formatted abstract text."""
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        resp = await client.get(abs_url, headers=browser_headers())
        resp.raise_for_status()
        html = resp.text or ""
    abstract = extract_arxiv_abstract(html)
    if len(abstract) < _MIN_USEFUL_CHARS:
        return ""
    title_m = re.search(
        r'<meta[^>]+name=["\']citation_title["\'][^>]+content=["\']([^"\']+)',
        html,
        re.I,
    )
    title = title_m.group(1).strip() if title_m else ""
    return format_metadata_text(
        title=title,
        abstract=abstract,
        source_url=abs_url,
        metadata_source="arXiv",
    )


async def _fetch_pdf_bytes(
    pdf_url: str,
    *,
    timeout: float,
    pdf_extract_backend: str,
) -> tuple[str, str]:
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        resp = await client.get(pdf_url, headers=browser_headers())
        resp.raise_for_status()
        raw = resp.content[:_MAX_BYTES]
        final_url = str(resp.url)
    text = pdf_bytes_to_text(raw, backend=pdf_extract_backend)
    return text[:120_000], final_url


async def try_api_abstract_fetch(
    url: str,
    *,
    timeout: float = 60.0,
) -> tuple[str, str, str | None, bool] | None:
    """
    Stage ① — structured APIs only (no publisher HTML/PDF fetch).
    OpenAlex → Crossref → PMC(NCBI) → Semantic Scholar.
    """
    target = url.strip()
    if not target.startswith(("http://", "https://")):
        target = f"https://{target}"

    parsed = urlparse(target)
    host = (parsed.netloc or "").lower()

    pmc_id = extract_pmc_id_from_url(target)
    if pmc_id:
        title, abstract, pmc_doi = await fetch_pmc_metadata_by_pmcid(
            pmc_id,
            timeout=min(timeout, 20.0),
        )
        if len(abstract) >= _MIN_USEFUL_CHARS:
            return _meta_tuple(
                format_metadata_text(
                    title=title,
                    abstract=abstract,
                    source_url=target,
                    doi=pmc_doi,
                    metadata_source="PMC",
                ),
                target,
            )

    doi = extract_doi_from_url(target)
    if not doi and is_doi_url(target):
        doi = normalize_doi(parsed.path.lstrip("/"))

    use_api = bool(doi) and (
        is_doi_url(target)
        or is_paywalled_host(target)
        or any(frag in host for frag in _PAYWALLED_HOST_FRAGMENTS)
    )
    if not doi or not use_api:
        return None

    work = await fetch_openalex_work_by_doi(doi, timeout=min(timeout, 15.0))
    if work:
        abstract = reconstruct_openalex_abstract(work)
        if len(abstract) >= _MIN_USEFUL_CHARS:
            return _meta_tuple(
                format_metadata_text(
                    title=_openalex_title(work),
                    abstract=abstract,
                    source_url=target,
                    doi=doi,
                    metadata_source="OpenAlex",
                ),
                target,
            )

    cr_title, abstract = await fetch_crossref_abstract_by_doi(
        doi,
        timeout=min(timeout, 10.0),
    )
    if len(abstract) >= _MIN_USEFUL_CHARS:
        return _meta_tuple(
            format_metadata_text(
                title=cr_title,
                abstract=abstract,
                source_url=target,
                doi=doi,
                metadata_source="Crossref",
            ),
            target,
        )

    pmc_title, pmc_abstract, _pmc_doi = await fetch_pmc_metadata_by_doi(
        doi,
        timeout=min(timeout, 20.0),
    )
    if len(pmc_abstract) >= _MIN_USEFUL_CHARS:
        return _meta_tuple(
            format_metadata_text(
                title=pmc_title,
                abstract=pmc_abstract,
                source_url=target,
                doi=doi,
                metadata_source="PMC",
            ),
            target,
        )

    s2_title, s2_abstract = await fetch_s2_abstract_by_doi(
        doi,
        timeout=min(timeout, 15.0),
    )
    if len(s2_abstract) >= _MIN_USEFUL_CHARS:
        return _meta_tuple(
            format_metadata_text(
                title=s2_title,
                abstract=s2_abstract,
                source_url=target,
                doi=doi,
                metadata_source="Semantic Scholar",
            ),
            target,
        )

    return None


async def resolve_oa_fetch_urls(
    url: str,
    *,
    timeout: float = 30.0,
) -> list[str]:
    """
    Stage ② — Unpaywall resolves OA URLs for stage ③ direct HTTP fetch.
    Returns deduplicated candidate URLs (arxiv abs preferred before PDF).
    """
    target = url.strip()
    if not target.startswith(("http://", "https://")):
        target = f"https://{target}"

    parsed = urlparse(target)
    host = (parsed.netloc or "").lower()
    out: list[str] = []
    seen: set[str] = set()

    def _add(candidate: str) -> None:
        c = (candidate or "").strip()
        if not c.startswith(("http://", "https://")):
            return
        if c in seen:
            return
        seen.add(c)
        out.append(c)

    if "arxiv.org" in host:
        abs_u = arxiv_abs_url(target)
        if abs_u:
            _add(abs_u)
        _add(normalize_native_fetch_url(target))

    doi = extract_doi_from_url(target)
    if not doi and is_doi_url(target):
        doi = normalize_doi(parsed.path.lstrip("/"))
    if not doi:
        return out

    oa_url = await fetch_unpaywall_oa_pdf(doi, timeout=min(timeout, 12.0))
    if oa_url and not is_paywalled_host(oa_url) and "idp.springer.com" not in oa_url:
        abs_u = arxiv_abs_url(oa_url)
        if abs_u:
            _add(abs_u)
        _add(oa_url)

    redirect = await resolve_doi_redirect_url(
        f"https://doi.org/{doi}",
        timeout=min(timeout, 15.0),
    )
    if redirect and "arxiv.org" in redirect:
        abs_u = arxiv_abs_url(redirect)
        if abs_u:
            _add(abs_u)

    if is_ssrn_doi(doi):
        ssrn_page = ssrn_page_url_from_doi(doi)
        if ssrn_page:
            _add(ssrn_page)

    return out


async def try_metadata_only_fallback(
    url: str,
    *,
    timeout: float = 30.0,
) -> tuple[str, str, str | None, bool] | None:
    """Stage ⑤ — title/DOI from OpenAlex when full text is unavailable."""
    target = url.strip()
    if not target.startswith(("http://", "https://")):
        target = f"https://{target}"

    doi = extract_doi_from_url(target)
    if not doi and is_doi_url(target):
        doi = normalize_doi(urlparse(target).path.lstrip("/"))
    if not doi:
        return None

    work = await fetch_openalex_work_by_doi(doi, timeout=min(timeout, 15.0))
    if not work:
        return None
    title = _openalex_title(work)
    if not title:
        return None
    return _meta_tuple(
        format_metadata_only_text(
            title=title,
            source_url=target,
            doi=doi,
            metadata_source="OpenAlex",
        ),
        target,
    )


async def try_jina_reader_fetch(
    url: str,
    *,
    api_key: str | None = None,
    timeout: float = 60.0,
) -> str:
    """Stage ④ — Jina Reader (headless) fallback."""
    from app.agents.tools.providers import jina as jina_provider

    text = await jina_provider.fetch(url, api_key=api_key, timeout=timeout)
    if is_junk_fetch_content(text):
        return ""
    return text


async def try_metadata_fetch(
    url: str,
    *,
    timeout: float = 60.0,
    pdf_extract_backend: str = "pymupdf4llm",
) -> tuple[str, str, str | None, bool] | None:
    """Backward-compatible alias for stage ① API abstract fetch."""
    _ = pdf_extract_backend
    return await try_api_abstract_fetch(url, timeout=timeout)
