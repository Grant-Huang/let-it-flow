"""Extract plain text from PDF bytes (pypdf | pymupdf4llm)."""
from __future__ import annotations

import io
import logging

logger = logging.getLogger(__name__)

PDF_EXTRACT_BACKENDS = frozenset({"pypdf", "pymupdf4llm"})

PYMUPDF4LLM_LICENSE_NOTE = (
    "PyMuPDF / pymupdf4llm 基于 AGPL；在闭源或商业产品中使用需向 "
    "Artifex Software 购买商业许可证。"
)


def normalize_pdf_extract_backend(raw: str | None) -> str:
    b = (raw or "pymupdf4llm").strip().lower()
    return b if b in PDF_EXTRACT_BACKENDS else "pypdf"


def pymupdf4llm_available() -> bool:
    try:
        import pymupdf  # noqa: F401
        import pymupdf4llm  # noqa: F401

        return True
    except ImportError:
        return False


def _extract_pypdf(raw: bytes, *, max_chars: int) -> str:
    try:
        from pypdf import PdfReader
    except ImportError:
        return ""
    try:
        reader = PdfReader(io.BytesIO(raw))
        parts: list[str] = []
        for page in reader.pages:
            text = page.extract_text() or ""
            if text.strip():
                parts.append(text.strip())
            if sum(len(p) for p in parts) >= max_chars:
                break
        return "\n\n".join(parts)[:max_chars]
    except Exception:
        logger.debug("pypdf extract failed", exc_info=True)
        return ""


def _extract_pymupdf4llm(raw: bytes, *, max_chars: int) -> str:
    try:
        import pymupdf
        import pymupdf4llm
    except ImportError:
        return ""
    doc = None
    try:
        doc = pymupdf.open(stream=raw, filetype="pdf")
        md = pymupdf4llm.to_markdown(
            doc,
            write_images=False,
            embed_images=False,
            ignore_images=True,
        )
        text = str(md or "").strip()
        return text[:max_chars]
    except Exception:
        logger.debug("pymupdf4llm extract failed", exc_info=True)
        return ""
    finally:
        if doc is not None:
            doc.close()


def pdf_bytes_to_text(
    raw: bytes,
    *,
    backend: str = "pymupdf4llm",
    max_chars: int = 120_000,
) -> str:
    if not raw or raw[:5] != b"%PDF-":
        return ""
    chosen = normalize_pdf_extract_backend(backend)
    if chosen == "pymupdf4llm":
        text = _extract_pymupdf4llm(raw, max_chars=max_chars)
        if text:
            return text
        logger.info("pymupdf4llm unavailable or failed; falling back to pypdf")
        return _extract_pypdf(raw, max_chars=max_chars)
    return _extract_pypdf(raw, max_chars=max_chars)
