"""SSE event helpers — text delivery routing and turn boundaries."""
from __future__ import annotations

from typing import Any

TEXT_DELIVERY_CHAT = "chat"
TEXT_DELIVERY_PROCESS = "process"

CORPUS_QA_MAX_CHARS = 800


def text_event(delta: str, *, delivery: str = TEXT_DELIVERY_CHAT) -> tuple[str, dict[str, Any]]:
    return ("text", {"delta": delta, "delivery": delivery})


def chat_text(delta: str) -> tuple[str, dict[str, Any]]:
    return text_event(delta, delivery=TEXT_DELIVERY_CHAT)


def process_text(delta: str) -> tuple[str, dict[str, Any]]:
    return text_event(delta, delivery=TEXT_DELIVERY_PROCESS)


def process_text_extension(delta: str) -> tuple[str, dict[str, Any]]:
    """Extension mirror of process_text for streaming UI (Meso text drops delivery)."""
    return (
        "extension",
        {
            "name": "process_text",
            "version": "1.0",
            "data": {"delta": delta},
        },
    )


def literature_phase_think(stage: str, content: str) -> tuple[str, dict[str, Any]]:
    """Pin phase think snapshot so UI keeps it after stage transitions."""
    return (
        "extension",
        {
            "name": "literature_phase_think",
            "version": "1.0",
            "data": {"stage": stage, "content": content},
        },
    )


def literature_brief_assessment(data: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    return (
        "extension",
        {
            "name": "literature_brief_assessment",
            "version": "1.0",
            "data": data,
        },
    )


def turn_start(*, turn_index: int, intent: str) -> tuple[str, dict[str, Any]]:
    return (
        "extension",
        {
            "name": "turn_start",
            "version": "1.0",
            "data": {"turn_index": turn_index, "intent": intent},
        },
    )


def turn_end(*, turn_index: int, summary: str) -> tuple[str, dict[str, Any]]:
    return (
        "extension",
        {
            "name": "turn_end",
            "version": "1.0",
            "data": {"turn_index": turn_index, "summary": summary},
        },
    )


def artifact_stream_delta(
    art_id: str,
    delta: str,
    *,
    lang: str = "markdown",
    version_id: str | None = None,
    done: bool = False,
) -> tuple[str, dict[str, Any]]:
    payload: dict[str, Any] = {
        "id": art_id,
        "lang": lang,
        "delta": delta,
        "done": done,
    }
    if version_id:
        payload["version_id"] = version_id
    return ("artifact", payload)


def clamp_corpus_answer(text: str, *, max_chars: int = CORPUS_QA_MAX_CHARS) -> str:
    body = (text or "").strip()
    if len(body) <= max_chars:
        return body
    return body[: max_chars - 1].rstrip() + "…"
