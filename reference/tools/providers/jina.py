from __future__ import annotations

from urllib.parse import urlparse

import httpx


def normalize_reader_target_url(url: str) -> str:
    target = url.strip()
    if not target.startswith(("http://", "https://")):
        target = f"https://{target}"

    parsed = urlparse(target)
    if (
        parsed.netloc.lower() == "arxiv.org"
        and parsed.path.startswith("/abs/")
    ):
        paper_id = parsed.path.removeprefix("/abs/").strip("/")
        if paper_id:
            suffix = "" if paper_id.endswith(".pdf") else ".pdf"
            return f"https://arxiv.org/pdf/{paper_id}{suffix}"
    return target


async def fetch(
    url: str,
    *,
    api_key: str | None = None,
    timeout: float = 60.0,
) -> str:
    target = normalize_reader_target_url(url)

    headers: dict[str, str] = {"Accept": "text/markdown"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    reader_url = f"https://r.jina.ai/{target}"
    async with httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=True,
    ) as client:
        resp = await client.get(reader_url, headers=headers)
        resp.raise_for_status()
        text = resp.text or ""
        return text[:120_000]
