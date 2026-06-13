"""Storage backend selection for LitPilot."""
from __future__ import annotations

import os
from typing import Literal

from app.storage.file_store import FileStore

StorageBackendName = Literal["file", "turso", "hybrid"]

_store: FileStore | None = None


def storage_backend_name() -> StorageBackendName:
    raw = os.getenv("LITPILOT_STORAGE_BACKEND", "file").strip().lower()
    if raw in ("file", "turso", "hybrid"):
        return raw  # type: ignore[return-value]
    return "file"


def get_store() -> FileStore:
    """
    Return the active storage implementation.

    Set LITPILOT_STORAGE_BACKEND=turso (or hybrid) when TURSO_DATABASE_URL is set.
    """
    global _store
    if _store is not None:
        return _store

    backend = storage_backend_name()
    if backend in ("turso", "hybrid"):
        from app.storage.turso_db import turso_configured

        if turso_configured():
            try:
                from app.storage.turso_store import TursoStore

                _store = TursoStore()
                return _store
            except ImportError:
                pass

    _store = FileStore()
    return _store


def reset_store_for_tests() -> None:
    """Clear singleton between tests."""
    global _store
    _store = None
