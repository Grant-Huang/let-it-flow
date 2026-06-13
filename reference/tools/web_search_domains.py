"""Domain filters aligned with docs/WebSearchTool (allowed_domains / blocked_domains)."""
from __future__ import annotations

from urllib.parse import urlparse


def validate_search_domains(
    allowed_domains: list[str] | tuple[str, ...] | None,
    blocked_domains: list[str] | tuple[str, ...] | None,
) -> str | None:
    """Return error message if both lists set (Anthropic WebSearchTool rule).

    LitPilot native search applies allow+block in post-filter only; callers must not
    use this to reject default academic include+exclude configuration.
    """
    allow = [str(d).strip() for d in (allowed_domains or ()) if str(d).strip()]
    block = [str(d).strip() for d in (blocked_domains or ()) if str(d).strip()]
    if allow and block:
        return (
            "Cannot specify both allowed_domains and blocked_domains in the same request"
        )
    return None


def _host_allowed(host: str, domain: str) -> bool:
    h = host.lower()
    d = domain.lower().lstrip(".")
    return h == d or h.endswith(f".{d}")


def filter_hits_by_domains(
    hits: list[dict[str, str]],
    *,
    allowed_domains: list[str] | tuple[str, ...] | None = None,
    blocked_domains: list[str] | tuple[str, ...] | None = None,
) -> list[dict[str, str]]:
    allow = [str(d).strip() for d in (allowed_domains or ()) if str(d).strip()]
    block = [str(d).strip() for d in (blocked_domains or ()) if str(d).strip()]
    out: list[dict[str, str]] = []
    for hit in hits:
        url = str(hit.get("url") or "").strip()
        if not url:
            continue
        try:
            host = urlparse(url).netloc.lower()
        except Exception:
            continue
        if block and any(_host_allowed(host, d) for d in block):
            continue
        if allow and not any(_host_allowed(host, d) for d in allow):
            continue
        out.append(hit)
    return out
