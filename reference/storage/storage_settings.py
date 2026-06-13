"""Resolve effective storage / Turso connection settings (env + admin overrides)."""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from app.core.config import DATA_DIR
from app.storage.backend import storage_backend_name

_STORAGE_DOC_KEY = "system.storage"
_RUNTIME: dict[str, str] = {}


def _mask_secret(secret: str) -> str:
    s = str(secret or "")
    if not s:
        return ""
    return "***" + s[-4:]


def _read_admin_storage_file() -> dict[str, Any]:
    path = DATA_DIR / "config" / "system.storage.json"
    if not path.is_file():
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        return dict(data) if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _fetch_admin_storage_from_turso(database_url: str, auth_token: str) -> dict[str, Any]:
    from app.storage.turso_http import TursoHttpConnection

    conn = TursoHttpConnection(database_url, auth_token)
    try:
        row = conn.execute(
            "SELECT content_json FROM config_documents WHERE doc_key = ?",
            (_STORAGE_DOC_KEY,),
        ).fetchone()
    finally:
        conn.close()
    if not row or not row[0]:
        return {}
    try:
        data = json.loads(row[0])
        return dict(data) if isinstance(data, dict) else {}
    except json.JSONDecodeError:
        return {}


def set_runtime_turso_credentials(database_url: str, auth_token: str) -> None:
    global _RUNTIME
    _RUNTIME = {
        "database_url": database_url.strip(),
        "auth_token": auth_token.strip(),
    }


def clear_runtime_turso_credentials() -> None:
    global _RUNTIME
    _RUNTIME = {}


def resolve_turso_credentials() -> tuple[str, str]:
    """Merge runtime override, admin config, and environment variables."""
    if _RUNTIME.get("database_url"):
        return _RUNTIME["database_url"], _RUNTIME.get("auth_token", "")

    env_url = os.getenv("TURSO_DATABASE_URL", "").strip()
    env_token = os.getenv("TURSO_AUTH_TOKEN", "").strip()
    admin = _read_admin_storage_file()
    admin_url = str(admin.get("database_url") or "").strip()
    admin_token = str(admin.get("auth_token") or "").strip()

    if env_url and env_token:
        try:
            remote = _fetch_admin_storage_from_turso(env_url, env_token)
            if remote.get("database_url"):
                admin_url = str(remote["database_url"]).strip()
            if remote.get("auth_token"):
                admin_token = str(remote["auth_token"]).strip()
        except Exception:
            pass

    url = admin_url or env_url
    token = admin_token or env_token
    return url, token


def _source_label(has_admin: bool, has_env: bool) -> str:
    if has_admin and has_env:
        return "admin+env"
    if has_admin:
        return "admin"
    if has_env:
        return "env"
    return "none"


def build_storage_status(store: Any | None = None) -> dict[str, Any]:
    env_url = os.getenv("TURSO_DATABASE_URL", "").strip()
    env_token = os.getenv("TURSO_AUTH_TOKEN", "").strip()
    admin: dict[str, Any] = {}
    if store is not None and hasattr(store, "get_storage_settings"):
        try:
            admin = store.get_storage_settings()
        except Exception:
            admin = {}
    if not admin:
        admin = _read_admin_storage_file()

    admin_url = str(admin.get("database_url") or "").strip()
    admin_token = str(admin.get("auth_token") or "").strip()
    url, token = resolve_turso_credentials()
    backend = storage_backend_name()
    data_dir = str(DATA_DIR)

    return {
        "backend": backend,
        "data_dir": data_dir,
        "tenant_id": str(os.getenv("LITPILOT_TENANT_ID", "default") or "default"),
        "database_url": url,
        "database_url_source": _source_label(bool(admin_url), bool(env_url)),
        "has_auth_token": bool(token),
        "masked_auth_token": _mask_secret(token),
        "auth_token_source": _source_label(bool(admin_token), bool(env_token)),
        "turso_ready": bool(url and token),
        "turso_configured": bool(url),
        "admin_has_url": bool(admin_url),
        "admin_has_token": bool(admin_token),
        "env_has_url": bool(env_url),
        "env_has_token": bool(env_token),
    }
