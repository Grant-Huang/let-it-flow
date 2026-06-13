"""SSE event formatting — Meso platform protocol v1.0."""
from __future__ import annotations

import json
from typing import Any

PROTOCOL_VERSION = "1.0"

STANDARD_TYPES = frozenset({
    "capabilities",
    "stage",
    "memory",
    "think",
    "text",
    "artifact",
    "tool_call",
    "tool_result",
    "skill_active",
    "soul",
    "workflow_node",
    "done",
    "error",
})

EXTENSION_TYPES = frozenset({"session"})


def sse_event(event_type: str, payload: dict[str, Any] | None = None) -> str:
    body = {
        "type": event_type,
        "schema_version": PROTOCOL_VERSION,
        "payload": payload or {},
    }
    return f"data: {json.dumps(body, ensure_ascii=False)}\n\n"


def normalize_chat_event(
    event_type: str,
    payload: dict[str, Any] | None = None,
) -> list[tuple[str, dict[str, Any]]]:
    payload = dict(payload or {})

    if event_type == "artifact":
        if "delta" in payload:
            return [("artifact", payload)]
        content = str(payload.get("content") or "")
        art_id = str(payload.get("id") or "artifact")
        lang = str(payload.get("lang") or "markdown")
        if not content:
            return [("artifact", {"id": art_id, "lang": lang, "delta": "", "done": True})]
        return [(
            "artifact",
            {"id": art_id, "lang": lang, "delta": content, "done": True},
        )]

    if event_type == "extension":
        if payload.get("name"):
            return [("extension", payload)]
        return [(
            "extension",
            {"name": "extension", "version": "1.0", "data": payload},
        )]

    if event_type in EXTENSION_TYPES:
        return [(
            "extension",
            {"name": event_type, "version": "1.0", "data": payload},
        )]

    if event_type in STANDARD_TYPES:
        return [(event_type, payload)]

    return [(
        "extension",
        {"name": event_type, "version": "1.0", "data": payload},
    )]
