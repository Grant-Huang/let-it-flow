"""Non-sensitive deploy defaults bundled with the backend (Vercel seed fallback)."""
from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import Any

_BACKEND_ROOT = Path(__file__).resolve().parents[2]
_DEFAULTS_PATH = _BACKEND_ROOT / "config" / "deploy.defaults.json"

# Never load secrets from deploy.defaults.json — keys come from env / agent.json only.
SENSITIVE_SETTING_KEYS = frozenset(
    {
        "tavily_api_key",
        "jina_api_key",
        "llm_api_key",
        "llm_group_id",
    }
)


@lru_cache(maxsize=1)
def load_deploy_defaults_raw() -> dict[str, Any]:
    if not _DEFAULTS_PATH.is_file():
        return {}
    try:
        data = json.loads(_DEFAULTS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def deploy_settings() -> dict[str, Any]:
    """Flat non-sensitive settings for v2 migration seeding.

    Sources (priority): env var → deploy.defaults.json → hardcoded fallback.
    """
    raw = load_deploy_defaults_raw()
    settings = dict(raw.get("settings") or {})

    settings["llm_model"] = (
        os.environ.get("OPENAI_MODEL")
        or str(settings.get("llm_model") or "")
    ).strip() or "deepseek-v4-pro"

    settings["orchestrator_model"] = (
        os.environ.get("ORCHESTRATOR_MODEL")
        or str(settings.get("orchestrator_model") or "")
    ).strip() or "deepseek-v4-flash"

    settings["llm_base_url"] = (
        os.environ.get("OPENAI_BASE_URL")
        or str(settings.get("llm_base_url") or "")
    ).strip() or "https://api.deepseek.com"

    settings["llm_provider"] = (
        os.environ.get("LLM_PROVIDER")
        or str(settings.get("llm_provider") or "")
    ).strip() or "openai"

    return settings


PROMPT_INSTANCE_BINDING_ENV: dict[str, str] = {
    "router_instance_id": "ROUTER_INSTANCE_KEY",
    "search_instance_id": "SEARCH_INSTANCE_KEY",
    "assessor_instance_id": "ASSESSOR_INSTANCE_KEY",
    "pipeline_instance_id": "PIPELINE_INSTANCE_KEY",
}

CAPABILITY_INSTANCE_BINDING_ENV: dict[str, str] = {
    "orchestrator": "ORCHESTRATOR_INSTANCE_KEY",
    "review_main": "REVIEW_INSTANCE_KEY",
}

DEFAULT_PROMPT_INSTANCE_BINDINGS: dict[str, str] = {
    "router_instance_id": "orchestrator",
    "search_instance_id": "orchestrator",
    "assessor_instance_id": "orchestrator",
    "pipeline_instance_id": "orchestrator",
}

DEFAULT_CAPABILITY_INSTANCE_BINDINGS: dict[str, str] = {
    "orchestrator": "orchestrator",
    "review_main": "review_main",
}


def deploy_prompt_instance_bindings() -> dict[str, str]:
    """Prompt param key → instance key or stable instance id (env/json/default)."""
    raw = load_deploy_defaults_raw()
    file_bindings = raw.get("prompt_instance_bindings")
    file_map = file_bindings if isinstance(file_bindings, dict) else {}
    out: dict[str, str] = {}
    for param_key, default_key in DEFAULT_PROMPT_INSTANCE_BINDINGS.items():
        env_key = PROMPT_INSTANCE_BINDING_ENV[param_key]
        env_id = env_key.replace("_KEY", "_ID")
        val = (
            os.environ.get(env_id)
            or os.environ.get(env_key)
            or file_map.get(param_key)
            or file_map.get(param_key.replace("_instance_id", ""))
            or default_key
        )
        out[param_key] = str(val).strip()
    return out


def deploy_capability_instance_bindings() -> dict[str, str]:
    """Capability id → instance key or stable instance id (env/json/default)."""
    raw = load_deploy_defaults_raw()
    file_bindings = raw.get("capability_instance_bindings")
    file_map = file_bindings if isinstance(file_bindings, dict) else {}
    out: dict[str, str] = {}
    for cap_id, default_key in DEFAULT_CAPABILITY_INSTANCE_BINDINGS.items():
        env_key = CAPABILITY_INSTANCE_BINDING_ENV[cap_id]
        env_id = env_key.replace("_KEY", "_ID")
        val = (
            os.environ.get(env_id)
            or os.environ.get(env_key)
            or file_map.get(cap_id)
            or default_key
        )
        out[cap_id] = str(val).strip()
    return out


def build_instance_lookup(
    instances: list[dict[str, Any]] | None = None,
) -> tuple[dict[str, str], dict[str, str]]:
    """Return (inst_by_key, inst_by_name) for binding resolution."""
    inst_by_key: dict[str, str] = {}
    for tpl in deploy_instances():
        key = str(tpl.get("key") or "").strip()
        iid = str(tpl.get("id") or "").strip()
        if key and iid:
            inst_by_key[key] = iid
    inst_by_name: dict[str, str] = {}
    for inst in instances or []:
        if not isinstance(inst, dict):
            continue
        iid = str(inst.get("id") or "").strip()
        name = str(inst.get("name") or "").strip()
        if not iid or not name:
            continue
        inst_by_name[name] = iid
        for tpl in deploy_instances():
            if str(tpl.get("name") or "") == name:
                key = str(tpl.get("key") or "").strip()
                if key:
                    inst_by_key[key] = iid
    return inst_by_key, inst_by_name


def resolve_instance_id_for_binding(
    binding: str,
    *,
    inst_by_key: dict[str, str] | None = None,
    inst_by_name: dict[str, str] | None = None,
) -> str:
    """Resolve deploy key / stable id / instance name to a runtime instance id."""
    token = str(binding or "").strip()
    if not token:
        return ""
    by_key = inst_by_key or {}
    by_name = inst_by_name or {}
    for tpl in deploy_instances():
        if str(tpl.get("id") or "") == token:
            return token
    if token in by_key:
        return by_key[token]
    if token in by_name:
        return by_name[token]
    alias = token.replace("_", "-")
    if alias in by_name:
        return by_name[alias]
    return ""


def resolved_prompt_instance_params(
    instances: list[dict[str, Any]] | None = None,
) -> dict[str, str]:
    inst_by_key, inst_by_name = build_instance_lookup(instances)
    out: dict[str, str] = {}
    for param_key, binding in deploy_prompt_instance_bindings().items():
        iid = resolve_instance_id_for_binding(
            binding,
            inst_by_key=inst_by_key,
            inst_by_name=inst_by_name,
        )
        if iid:
            out[param_key] = iid
    return out


def deploy_credentials() -> list[dict[str, Any]]:
    raw = load_deploy_defaults_raw()
    items = raw.get("credentials")
    if not isinstance(items, list):
        return []
    return [dict(it) for it in items if isinstance(it, dict) and it.get("id") and it.get("key")]


def deploy_instances() -> list[dict[str, Any]]:
    raw = load_deploy_defaults_raw()
    items = raw.get("instances")
    if not isinstance(items, list):
        return []
    return [dict(it) for it in items if isinstance(it, dict) and it.get("id") and it.get("key")]


def defaults_path() -> Path:
    return _DEFAULTS_PATH
