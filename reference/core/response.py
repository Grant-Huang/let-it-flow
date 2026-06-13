"""Unified JSON API responses."""
from typing import Any


def ok(data: Any = None, message: str = "") -> dict:
    out: dict = {"status": "success", "data": data}
    if message:
        out["message"] = message
    return out


def err(message: str, data: Any = None) -> dict:
    out: dict = {"status": "error", "message": message}
    if data is not None:
        out["data"] = data
    return out
