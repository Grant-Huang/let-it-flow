"""File-based persistence — no database."""
from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from filelock import FileLock

from app.agents.tools.search_hits import ACADEMIC_SEARCH_DOMAINS, DEFAULT_EXCLUDE_DOMAINS
from app.core.config import DATA_DIR
from app.core.deploy_defaults import (
    SENSITIVE_SETTING_KEYS,
    build_instance_lookup,
    deploy_capability_instance_bindings,
    deploy_credentials,
    deploy_instances,
    deploy_prompt_instance_bindings,
    deploy_settings,
    resolve_instance_id_for_binding,
    resolved_prompt_instance_params,
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


_DEFAULT_SESSION_TITLES = frozenset({"新综述", "新对话", "未命名"})


def is_default_session_title(title: str) -> bool:
    t = (title or "").strip()
    return not t or t in _DEFAULT_SESSION_TITLES


def _read_json(path: Path, default: Any) -> Any:
    if not path.is_file():
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _write_json_atomic(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    lock_path = path.with_suffix(path.suffix + ".lock")
    with FileLock(str(lock_path)):
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)


class FileStore:
    def __init__(self, root: Path | None = None) -> None:
        self.root = (root or DATA_DIR).resolve()
        self._ensure_layout()

    def _ensure_layout(self) -> None:
        for sub in (
            "config",
            "sessions",
            "refs",
            "sources",
            "pdfs",
            "artifacts",
            "cache/web_search",
        ):
            (self.root / sub).mkdir(parents=True, exist_ok=True)
        idx = self.root / "sessions" / "index.json"
        if not idx.is_file():
            _write_json_atomic(idx, {"sessions": []})
        ref_list = self.root / "refs" / "ref-list.txt"
        if not ref_list.is_file():
            ref_list.write_text("", encoding="utf-8")
        ref_idx = self.root / "refs" / "index.json"
        if not ref_idx.is_file():
            _write_json_atomic(ref_idx, {"refs": []})

    @property
    def agent_config_path(self) -> Path:
        return self.root / "config" / "agent.json"

    # --- v2 settings layout (system/personal split) ---
    @property
    def system_credentials_path(self) -> Path:
        return self.root / "config" / "system.credentials.json"

    @property
    def system_instances_path(self) -> Path:
        return self.root / "config" / "system.instances.json"

    @property
    def system_capabilities_path(self) -> Path:
        return self.root / "config" / "system.capabilities.json"

    @property
    def personal_preferences_path(self) -> Path:
        return self.root / "config" / "personal.preferences.json"

    @property
    def system_storage_path(self) -> Path:
        return self.root / "config" / "system.storage.json"

    def load_agent_settings(self) -> dict[str, Any]:
        data = _read_json(self.agent_config_path, {})
        if not isinstance(data, dict):
            return {}
        return data

    def save_agent_settings(self, partial: dict[str, Any]) -> dict[str, Any]:
        current = self.load_agent_settings()
        for k, v in partial.items():
            if v is None:
                continue
            if isinstance(v, str) and v.startswith("***"):
                continue
            current[k] = v
        _write_json_atomic(self.agent_config_path, current)
        return self.get_agent_settings_merged()

    def get_agent_settings_merged(self) -> dict[str, Any]:
        """Merge v2 system/personal config with environment variables for secrets."""
        import os

        from app.storage.runtime_settings import build_runtime_settings

        self.ensure_settings_v2_migrated()
        runtime = build_runtime_settings(
            credentials=self.list_system_credentials(),
            instances=self.list_system_instances(),
            capabilities=self.list_system_capabilities(),
            personal=self.get_personal_preferences(),
        )
        env_map = {
            "web_search_api_key": os.getenv("TAVILY_API_KEY", ""),
            "fetch_api_key": os.getenv("JINA_API_KEY", ""),
            "llm_provider": os.getenv("LLM_PROVIDER", "openai"),
            "llm_api_key": os.getenv("OPENAI_API_KEY", ""),
            "llm_model": os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
            "llm_base_url": os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1"),
            "llm_group_id": os.getenv("MINIMAX_GROUP_ID", ""),
        }
        merged = dict(runtime)
        if not merged.get("web_search_api_key") and str(merged.get("search_provider") or "") == "tavily":
            merged["web_search_api_key"] = env_map["web_search_api_key"]
        if not merged.get("fetch_api_key") and str(merged.get("fetch_provider") or "") == "jina":
            merged["fetch_api_key"] = env_map["fetch_api_key"]
        if not merged.get("llm_api_key"):
            merged["llm_api_key"] = env_map["llm_api_key"]
        if not merged.get("llm_provider"):
            merged["llm_provider"] = env_map["llm_provider"]
        if not merged.get("llm_model"):
            merged["llm_model"] = env_map["llm_model"]
        if not merged.get("llm_base_url"):
            merged["llm_base_url"] = env_map["llm_base_url"]
        if not merged.get("llm_group_id"):
            merged["llm_group_id"] = env_map["llm_group_id"]
        return merged

    def _pick_legacy_value(
        self,
        cfg: dict[str, Any],
        defaults: dict[str, Any],
        key: str,
        *,
        env_var: str | None = None,
        fallback: Any = "",
    ) -> Any:
        """agent.json > env (secrets only) > deploy.defaults.json > fallback."""
        import os

        raw_cfg = cfg.get(key)
        if raw_cfg not in (None, ""):
            return raw_cfg
        if key in SENSITIVE_SETTING_KEYS:
            if env_var:
                return os.getenv(env_var, "") or fallback
            return fallback
        raw_default = defaults.get(key)
        if raw_default not in (None, ""):
            return raw_default
        if env_var:
            env_val = os.getenv(env_var)
            if env_val not in (None, ""):
                return env_val
        return fallback

    def _legacy_agent_settings_merged(self) -> dict[str, Any]:
        """Read legacy agent.json merged with env secrets and deploy.defaults.json."""
        cfg = self.load_agent_settings()
        defaults = deploy_settings()

        return {
            "tavily_api_key": self._pick_legacy_value(
                cfg, defaults, "tavily_api_key", env_var="TAVILY_API_KEY"
            ),
            "jina_api_key": self._pick_legacy_value(
                cfg, defaults, "jina_api_key", env_var="JINA_API_KEY"
            ),
            "llm_provider": str(
                self._pick_legacy_value(
                    cfg, defaults, "llm_provider", env_var="LLM_PROVIDER", fallback="openai"
                )
            ),
            "llm_api_key": self._pick_legacy_value(
                cfg, defaults, "llm_api_key", env_var="OPENAI_API_KEY"
            ),
            "llm_model": str(
                self._pick_legacy_value(
                    cfg, defaults, "llm_model", env_var="OPENAI_MODEL", fallback="gpt-4o-mini"
                )
            ),
            "llm_base_url": str(
                self._pick_legacy_value(
                    cfg,
                    defaults,
                    "llm_base_url",
                    env_var="OPENAI_BASE_URL",
                    fallback="https://api.openai.com/v1",
                )
            ),
            "llm_group_id": self._pick_legacy_value(
                cfg, defaults, "llm_group_id", env_var="MINIMAX_GROUP_ID"
            ),
            "fetch_parallel": int(
                self._pick_legacy_value(cfg, defaults, "fetch_parallel", fallback=3)
            ),
            "fetch_timeout_sec": float(
                self._pick_legacy_value(cfg, defaults, "fetch_timeout_sec", fallback=45)
            ),
            "tavily_max_results": int(
                self._pick_legacy_value(cfg, defaults, "tavily_max_results", fallback=8)
            ),
            "max_fetch_urls": int(
                self._pick_legacy_value(cfg, defaults, "max_fetch_urls", fallback=5)
            ),
            "tavily_retry_count": int(
                self._pick_legacy_value(cfg, defaults, "tavily_retry_count", fallback=0)
            ),
            "fetch_retry_count": int(
                self._pick_legacy_value(cfg, defaults, "fetch_retry_count", fallback=0)
            ),
            "fetch_retry_delay_ms": int(
                self._pick_legacy_value(cfg, defaults, "fetch_retry_delay_ms", fallback=500)
            ),
            "max_source_chars": int(
                self._pick_legacy_value(cfg, defaults, "max_source_chars", fallback=14_000)
            ),
            "citation_format": str(
                self._pick_legacy_value(cfg, defaults, "citation_format", fallback="apa")
            )
            .strip()
            .lower(),
            "use_llm_planner": bool(
                self._pick_legacy_value(cfg, defaults, "use_llm_planner", fallback=True)
            ),
            "orchestrator_mode": str(
                self._pick_legacy_value(cfg, defaults, "orchestrator_mode", fallback="lite")
            )
            .strip()
            .lower(),
            "orchestrator_use_reasoning": bool(
                self._pick_legacy_value(
                    cfg, defaults, "orchestrator_use_reasoning", fallback=False
                )
            ),
            "orchestrator_model": str(
                self._pick_legacy_value(cfg, defaults, "orchestrator_model", fallback="")
            ).strip(),
            "orchestrator_max_tokens_per_phase": int(
                self._pick_legacy_value(
                    cfg, defaults, "orchestrator_max_tokens_per_phase", fallback=420
                )
            ),
        }

    # --- v2 settings helpers ---
    def _config_path_exists(self, path: Path) -> bool:
        return path.is_file()

    def _write_config_json(self, path: Path, data: Any) -> None:
        _write_json_atomic(path, data)

    def read_library_db(self) -> dict[str, Any]:
        path = self.root / "refs" / "library.json"
        data = _read_json(
            path,
            {"version": 1, "next_display_index": 0, "items": {}, "keys": {}},
        )
        if not isinstance(data, dict):
            return {"version": 1, "next_display_index": 0, "items": {}, "keys": {}}
        return data

    def write_library_db(self, data: dict[str, Any]) -> None:
        _write_json_atomic(self.root / "refs" / "library.json", data)

    def library_delete_item_files(self, item_id: str) -> None:
        src = self.root / "sources" / f"{item_id}.md"
        if src.is_file():
            src.unlink()

    def read_source_text(self, item_id: str) -> str:
        path = self.root / "sources" / f"{item_id}.md"
        if not path.is_file():
            return ""
        return path.read_text(encoding="utf-8")

    def write_source_text(self, item_id: str, text: str) -> None:
        body = (text or "").strip()
        if not body:
            return
        path = self.root / "sources" / f"{item_id}.md"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body[:500_000], encoding="utf-8")

    def save_pdf_bytes(self, filename: str, content: bytes) -> Path:
        safe = Path(filename).name
        path = self.root / "pdfs" / safe
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        return path

    def tenant_id(self) -> str:
        return "default"

    def get_storage_settings(self) -> dict[str, Any]:
        data = _read_json(self.system_storage_path, {})
        return dict(data) if isinstance(data, dict) else {}

    def save_storage_settings(self, partial: dict[str, Any]) -> dict[str, Any]:
        current = self.get_storage_settings()
        for key, value in partial.items():
            if value is None:
                continue
            if key == "auth_token" and str(value).startswith("***"):
                continue
            if key == "auth_token" and not str(value).strip():
                current.pop("auth_token", None)
                continue
            current[key] = value
        current["updated_at"] = _utc_now()
        _write_json_atomic(self.system_storage_path, current)
        from app.storage.turso_store import resolve_turso_credentials_merged
        from app.storage.storage_settings import set_runtime_turso_credentials

        url, token = resolve_turso_credentials_merged(current)
        if url:
            set_runtime_turso_credentials(url, token)
        return self.get_storage_settings_public()

    def get_storage_settings_public(self) -> dict[str, Any]:
        from app.storage.storage_settings import build_storage_status

        return build_storage_status(self)

    def _load_config_list(self, path: Path) -> list[dict[str, Any]]:
        data = _read_json(path, {"items": []})
        if not isinstance(data, dict):
            return []
        items = data.get("items") or []
        if not isinstance(items, list):
            return []
        out: list[dict[str, Any]] = []
        for it in items:
            if isinstance(it, dict):
                out.append(it)
        return out

    def _save_config_list(self, path: Path, items: list[dict[str, Any]]) -> None:
        _write_json_atomic(path, {"items": items, "updated_at": _utc_now()})

    def _load_config_obj(self, path: Path, default: dict[str, Any]) -> dict[str, Any]:
        data = _read_json(path, default)
        if not isinstance(data, dict):
            return dict(default)
        return data

    def ensure_settings_v2_migrated(self) -> None:
        """
        One-time migration to v2 settings layout.

        Creates:
        - config/system.credentials.json
        - config/system.instances.json
        - config/system.capabilities.json
        - config/personal.preferences.json

        Data source: merged legacy agent settings (agent.json + env).
        """
        creds_exists = self._config_path_exists(self.system_credentials_path)
        inst_exists = self._config_path_exists(self.system_instances_path)
        caps_exists = self._config_path_exists(self.system_capabilities_path)
        prefs_exists = self._config_path_exists(self.personal_preferences_path)
        if creds_exists and inst_exists and caps_exists and prefs_exists:
            self._ensure_default_capabilities()
            self._ensure_capability_param_defaults()
            self._ensure_default_instances()
            self._ensure_deploy_catalog()
            self._ensure_prompt_instance_bindings()
            return

        legacy = self._legacy_agent_settings_merged()
        now = _utc_now()

        # credentials
        credentials: list[dict[str, Any]] = []
        cred_by_key: dict[str, str] = {}

        def _template_cred_id(key: str) -> str | None:
            for tpl in deploy_credentials():
                if str(tpl.get("key") or "") == key:
                    return str(tpl.get("id") or "") or None
            return None

        def add_cred(*, key: str, type_: str, name: str, secret: str, extra: dict[str, Any] | None = None) -> None:
            if key in cred_by_key:
                return
            cid = _template_cred_id(key) or uuid.uuid4().hex
            cred_by_key[key] = cid
            item: dict[str, Any] = {
                "id": cid,
                "type": type_,
                "name": name,
                "has_secret": bool(secret),
                "secret": secret,
                "created_at": now,
                "updated_at": now,
                "status": "unknown",
                "last_verified_at": None,
            }
            if extra:
                item.update(extra)
            credentials.append(item)

        add_cred(
            key="tavily",
            type_="tavily",
            name="web_search · default",
            secret=str(legacy.get("web_search_api_key") or ""),
        )
        add_cred(
            key="jina",
            type_="jina",
            name="web_fetch · default",
            secret=str(legacy.get("fetch_api_key") or ""),
        )
        add_cred(
            key="brave",
            type_="brave",
            name="Brave Search · default",
            secret="",
        )
        llm_provider = str(legacy.get("llm_provider") or "openai")
        add_cred(
            key="llm_primary",
            type_=f"llm:{llm_provider}",
            name=f"LLM · {llm_provider} · primary",
            secret=str(legacy.get("llm_api_key") or ""),
            extra={
                "base_url": str(legacy.get("llm_base_url") or ""),
                "group_id": str(legacy.get("llm_group_id") or ""),
            },
        )

        if not creds_exists:
            self._save_config_list(self.system_credentials_path, credentials)

        # instances
        instances: list[dict[str, Any]] = []
        inst_by_key: dict[str, str] = {}

        def _template_inst_id(key: str) -> str | None:
            for tpl in deploy_instances():
                if str(tpl.get("key") or "") == key:
                    return str(tpl.get("id") or "") or None
            return None

        def add_instance(*, key: str, name: str, provider: str, credential_id: str, model_name: str, default_params: dict[str, Any] | None = None) -> None:
            if key in inst_by_key:
                return
            iid = _template_inst_id(key) or uuid.uuid4().hex
            inst_by_key[key] = iid
            instances.append(
                {
                    "id": iid,
                    "name": name,
                    "provider": provider,
                    "credential_id": credential_id,
                    "model_name": model_name,
                    "default_params": default_params or {},
                    "created_at": now,
                    "updated_at": now,
                    "status": "unknown",
                    "last_verified_at": None,
                }
            )

        primary_cred_id = cred_by_key.get("llm_primary") or ""
        raw_review_model = str(legacy.get("llm_model") or "").strip()
        if not raw_review_model or raw_review_model == "gpt-4o-mini":
            primary_model = deploy_settings().get("llm_model") or "deepseek-v4-pro"
        elif raw_review_model:
            primary_model = raw_review_model
        else:
            primary_model = "gpt-4o-mini"
        add_instance(
            key="review_main",
            name="review-main",
            provider=llm_provider,
            credential_id=primary_cred_id,
            model_name=primary_model,
        )
        orch_model = (
            str(legacy.get("orchestrator_model") or "").strip()
            or deploy_settings().get("orchestrator_model")
            or "deepseek-v4-flash"
        )
        add_instance(
            key="orchestrator",
            name="orchestrator",
            provider=llm_provider,
            credential_id=primary_cred_id,
            model_name=orch_model,
        )

        if not inst_exists:
            self._save_config_list(self.system_instances_path, instances)

        # capabilities (bindings + system params)
        from app.storage.runtime_settings import PROMPTS_PARAM_DEFAULTS, WEB_SEARCH_PARAM_DEFAULTS

        capabilities: list[dict[str, Any]] = []

        def cap(
            capability_id: str,
            label: str,
            *,
            primary_ref: dict[str, Any] | None,
            override_params: dict[str, Any] | None = None,
            params: dict[str, Any] | None = None,
            enabled: bool = True,
        ) -> None:
            capabilities.append(
                {
                    "capability_id": capability_id,
                    "label": label,
                    "enabled": enabled,
                    "primary_ref": primary_ref,
                    "override_params": override_params or {},
                    "params": params or {},
                    "created_at": now,
                    "updated_at": now,
                }
            )

        cap(
            "review_main",
            "文献综述生成",
            primary_ref={"kind": "instance", "id": inst_by_key.get("review_main")},
        )
        cap(
            "orchestrator",
            "编排与解说",
            primary_ref={
                "kind": "instance",
                "id": inst_by_key.get("orchestrator") or inst_by_key.get("review_main"),
            },
            params={
                "use_llm_planner": bool(legacy.get("use_llm_planner", True)),
                "orchestrator_mode": str(legacy.get("orchestrator_mode") or "lite"),
                "orchestrator_use_reasoning": bool(legacy.get("orchestrator_use_reasoning", False)),
                "orchestrator_max_tokens_per_phase": int(
                    legacy.get("orchestrator_max_tokens_per_phase") or 420
                ),
            },
        )
        cap(
            "web_search",
            "web_search",
            primary_ref={
                "kind": "credential",
                "id": cred_by_key.get("semantic_scholar") or cred_by_key.get("tavily"),
            },
            params={
                **WEB_SEARCH_PARAM_DEFAULTS,
                "search_provider": "multi_academic",
                "search_max_results": int(legacy.get("search_max_results") or 20),
                "search_retry_count": int(legacy.get("search_retry_count") or 3),
            },
        )
        cap(
            "web_fetch",
            "web_fetch",
            primary_ref={"kind": "credential", "id": cred_by_key.get("jina")},
            params={
                "max_fetch_urls": int(legacy.get("max_fetch_urls") or 5),
                "fetch_parallel": int(legacy.get("fetch_parallel") or 3),
                "fetch_timeout_sec": float(legacy.get("fetch_timeout_sec") or 45),
                "fetch_retry_count": int(legacy.get("fetch_retry_count") or 0),
                "fetch_retry_delay_ms": int(legacy.get("fetch_retry_delay_ms") or 500),
                "max_source_chars": int(legacy.get("max_source_chars") or 14_000),
            },
        )
        cap(
            "prompts",
            "提示词模板",
            primary_ref=None,
            params={
                **PROMPTS_PARAM_DEFAULTS,
                **resolved_prompt_instance_params(instances),
            },
        )

        if not caps_exists:
            self._save_config_list(self.system_capabilities_path, capabilities)

        # personal preferences
        if not prefs_exists:
            prefs = {
                "preferences": {
                    "citation_format": str(legacy.get("citation_format") or "apa"),
                },
                "created_at": now,
                "updated_at": now,
            }
            self._write_config_json(self.personal_preferences_path, prefs)

        self._ensure_default_capabilities()
        self._ensure_capability_param_defaults()
        self._ensure_deploy_catalog()
        self._ensure_prompt_instance_bindings()

    _REQUIRED_CAPABILITY_IDS: tuple[str, ...] = (
        "review_main",
        "orchestrator",
        "web_search",
        "web_fetch",
        "literature_source",
        "prompts",
    )

    def _credential_id_by_type(self, cred_type: str) -> str | None:
        for item in self._load_config_list(self.system_credentials_path):
            typ = str(item.get("type") or "")
            if typ == cred_type:
                cid = str(item.get("id") or "").strip()
                return cid or None
        return None

    def _instance_id_by_name(self, name: str) -> str | None:
        for item in self._load_config_list(self.system_instances_path):
            if str(item.get("name") or "") == name:
                iid = str(item.get("id") or "").strip()
                return iid or None
        return None

    def _ensure_default_capabilities(self) -> None:
        """Append missing v2 capability cards (e.g. web_search after partial Turso seed)."""
        if not self._config_path_exists(self.system_capabilities_path):
            return
        caps = self._load_config_list(self.system_capabilities_path)
        present = {str(c.get("capability_id") or "") for c in caps}
        missing = [cid for cid in self._REQUIRED_CAPABILITY_IDS if cid not in present]
        if not missing:
            return

        from app.storage.runtime_settings import (
            ORCHESTRATOR_PARAM_DEFAULTS,
            PROMPTS_PARAM_DEFAULTS,
            WEB_FETCH_PARAM_DEFAULTS,
            WEB_SEARCH_PARAM_DEFAULTS,
        )

        legacy = self._legacy_agent_settings_merged()
        now = _utc_now()
        review_id = self._instance_id_by_name("review-main")
        orch_id = self._instance_id_by_name("orchestrator") or review_id
        tavily_id = self._credential_id_by_type("tavily")
        ss_id = self._credential_id_by_type("semantic_scholar")
        jina_id = self._credential_id_by_type("jina")

        templates: dict[str, dict[str, Any]] = {
            "review_main": {
                "capability_id": "review_main",
                "label": "文献综述生成",
                "enabled": True,
                "primary_ref": {"kind": "instance", "id": review_id} if review_id else None,
                "override_params": {},
                "params": {},
            },
            "orchestrator": {
                "capability_id": "orchestrator",
                "label": "编排与解说",
                "enabled": True,
                "primary_ref": {"kind": "instance", "id": orch_id} if orch_id else None,
                "override_params": {},
                "params": {
                    **ORCHESTRATOR_PARAM_DEFAULTS,
                    "use_llm_planner": bool(legacy.get("use_llm_planner", True)),
                    "orchestrator_mode": str(legacy.get("orchestrator_mode") or "lite"),
                    "orchestrator_use_reasoning": bool(
                        legacy.get("orchestrator_use_reasoning", False)
                    ),
                    "orchestrator_max_tokens_per_phase": int(
                        legacy.get("orchestrator_max_tokens_per_phase") or 420
                    ),
                },
            },
            "web_search": {
                "capability_id": "web_search",
                "label": "web_search",
                "enabled": True,
                "primary_ref": {
                    "kind": "credential",
                    "id": ss_id or tavily_id,
                } if (ss_id or tavily_id) else None,
                "override_params": {},
                "params": {
                    **WEB_SEARCH_PARAM_DEFAULTS,
                    "search_provider": "multi_academic",
                    "search_max_results": int(
                        legacy.get("search_max_results")
                        or legacy.get("tavily_max_results")
                        or 20
                    ),
                    "search_retry_count": int(
                        legacy.get("search_retry_count")
                        or legacy.get("tavily_retry_count")
                        or 3
                    ),
                },
            },
            "web_fetch": {
                "capability_id": "web_fetch",
                "label": "web_fetch",
                "enabled": True,
                "primary_ref": {"kind": "credential", "id": jina_id} if jina_id else None,
                "override_params": {},
                "params": {
                    **WEB_FETCH_PARAM_DEFAULTS,
                    "max_fetch_urls": int(legacy.get("max_fetch_urls") or 5),
                    "fetch_parallel": int(legacy.get("fetch_parallel") or 3),
                    "fetch_timeout_sec": float(legacy.get("fetch_timeout_sec") or 45),
                    "fetch_retry_count": int(legacy.get("fetch_retry_count") or 0),
                    "fetch_retry_delay_ms": int(legacy.get("fetch_retry_delay_ms") or 500),
                    "max_source_chars": int(legacy.get("max_source_chars") or 14_000),
                },
            },
            "prompts": {
                "capability_id": "prompts",
                "label": "提示词模板",
                "enabled": True,
                "primary_ref": None,
                "override_params": {},
                "params": {
                    **PROMPTS_PARAM_DEFAULTS,
                },
            },
        }

        changed = False
        for cap_id in missing:
            tpl = templates.get(cap_id)
            if not tpl:
                continue
            item = dict(tpl)
            item["created_at"] = now
            item["updated_at"] = now
            caps.append(item)
            changed = True
        if changed:
            self._save_config_list(self.system_capabilities_path, caps)

    def _ensure_deploy_catalog(self) -> None:
        """Align credentials/instances/capability refs with deploy.defaults.json stable IDs."""
        cred_templates = deploy_credentials()
        inst_templates = deploy_instances()
        if not cred_templates and not inst_templates:
            return

        legacy = self._legacy_agent_settings_merged()
        llm_provider = str(
            legacy.get("llm_provider")
            or deploy_settings().get("llm_provider")
            or "openai"
        )
        now = _utc_now()

        cred_id_remap: dict[str, str] = {}
        inst_id_remap: dict[str, str] = {}
        cred_by_key: dict[str, str] = {}
        inst_by_key: dict[str, str] = {}

        credentials = (
            self._load_config_list(self.system_credentials_path)
            if self.system_credentials_path.is_file()
            else []
        )
        instances = (
            self._load_config_list(self.system_instances_path)
            if self.system_instances_path.is_file()
            else []
        )
        caps = (
            self._load_config_list(self.system_capabilities_path)
            if self.system_capabilities_path.is_file()
            else []
        )

        def secret_for_key(key: str) -> str:
            if key == "tavily":
                return str(legacy.get("tavily_api_key") or "")
            if key == "jina":
                return str(legacy.get("jina_api_key") or "")
            if key == "llm_primary":
                return str(legacy.get("llm_api_key") or "")
            return ""

        changed_creds = False
        for tpl in cred_templates:
            stable_id = str(tpl["id"])
            key = str(tpl["key"])
            cred_by_key[key] = stable_id
            name = str(tpl.get("name") or key)
            type_ = str(tpl.get("type") or "")
            if type_.startswith("llm:"):
                type_ = f"llm:{llm_provider}"

            match_idx: int | None = None
            for idx, cred in enumerate(credentials):
                if str(cred.get("id") or "") == stable_id:
                    match_idx = idx
                    break
            if match_idx is None:
                for idx, cred in enumerate(credentials):
                    if str(cred.get("name") or "") == name:
                        match_idx = idx
                        old_id = str(credentials[idx].get("id") or "")
                        if old_id and old_id != stable_id:
                            cred_id_remap[old_id] = stable_id
                        break
            if match_idx is None and key == "llm_primary":
                for idx, cred in enumerate(credentials):
                    if str(cred.get("type") or "").startswith("llm:"):
                        match_idx = idx
                        old_id = str(credentials[idx].get("id") or "")
                        if old_id and old_id != stable_id:
                            cred_id_remap[old_id] = stable_id
                        break

            secret = secret_for_key(key)
            if match_idx is not None:
                cred = credentials[match_idx]
                if str(cred.get("id") or "") != stable_id:
                    cred["id"] = stable_id
                    changed_creds = True
                if type_ and str(cred.get("type") or "") != type_:
                    cred["type"] = type_
                    changed_creds = True
                if not str(cred.get("name") or ""):
                    cred["name"] = name
                    changed_creds = True
                if secret and not str(cred.get("secret") or ""):
                    cred["secret"] = secret
                    cred["has_secret"] = True
                    changed_creds = True
                if tpl.get("base_url") and not str(cred.get("base_url") or ""):
                    cred["base_url"] = str(tpl.get("base_url") or "")
                    changed_creds = True
                group_id = str(tpl.get("group_id") or "") or str(legacy.get("llm_group_id") or "")
                if group_id and not str(cred.get("group_id") or ""):
                    cred["group_id"] = group_id
                    changed_creds = True
                cred.setdefault("status", "unknown")
                cred.setdefault("created_at", now)
                if changed_creds:
                    cred["updated_at"] = now
            else:
                extra: dict[str, Any] = {}
                if tpl.get("base_url"):
                    extra["base_url"] = str(tpl["base_url"])
                group_id = str(tpl.get("group_id") or "") or str(legacy.get("llm_group_id") or "")
                if group_id:
                    extra["group_id"] = group_id
                credentials.append(
                    {
                        "id": stable_id,
                        "type": type_,
                        "name": name,
                        "has_secret": bool(secret),
                        "secret": secret,
                        **extra,
                        "created_at": now,
                        "updated_at": now,
                        "status": "unknown",
                        "last_verified_at": None,
                    }
                )
                changed_creds = True

        changed_insts = False
        for inst in instances:
            old_cid = str(inst.get("credential_id") or "")
            if old_cid in cred_id_remap:
                inst["credential_id"] = cred_id_remap[old_cid]
                inst["updated_at"] = now
                changed_insts = True

        for tpl in inst_templates:
            stable_id = str(tpl["id"])
            key = str(tpl["key"])
            inst_by_key[key] = stable_id
            name = str(tpl.get("name") or key)
            cred_key = str(tpl.get("credential_key") or "llm_primary")
            target_cred_id = cred_by_key.get(cred_key, "")
            model_default = str(tpl.get("model_name") or "")

            match_idx: int | None = None
            for idx, inst in enumerate(instances):
                if str(inst.get("id") or "") == stable_id:
                    match_idx = idx
                    break
            if match_idx is None:
                for idx, inst in enumerate(instances):
                    if str(inst.get("name") or "") == name:
                        match_idx = idx
                        old_id = str(instances[idx].get("id") or "")
                        if old_id and old_id != stable_id:
                            inst_id_remap[old_id] = stable_id
                        break

            if match_idx is not None:
                inst = instances[match_idx]
                if str(inst.get("id") or "") != stable_id:
                    inst["id"] = stable_id
                    changed_insts = True
                if target_cred_id and not str(inst.get("credential_id") or ""):
                    inst["credential_id"] = target_cred_id
                    changed_insts = True
                elif target_cred_id and str(inst.get("credential_id") or "") in cred_id_remap:
                    inst["credential_id"] = cred_id_remap[str(inst.get("credential_id"))]
                    changed_insts = True
                if model_default and not str(inst.get("model_name") or "").strip():
                    inst["model_name"] = model_default
                    changed_insts = True
                if not str(inst.get("provider") or ""):
                    inst["provider"] = llm_provider
                    changed_insts = True
                if changed_insts:
                    inst["updated_at"] = now
            else:
                instances.append(
                    {
                        "id": stable_id,
                        "name": name,
                        "provider": llm_provider,
                        "credential_id": target_cred_id,
                        "model_name": model_default or deploy_settings().get("llm_model") or "deepseek-v4-pro",
                        "default_params": {},
                        "created_at": now,
                        "updated_at": now,
                        "status": "unknown",
                        "last_verified_at": None,
                    }
                )
                changed_insts = True

        changed_caps = False
        cap_inst_by_capability = {
            "review_main": inst_by_key.get("review_main"),
            "orchestrator": inst_by_key.get("orchestrator"),
        }
        cap_cred_by_capability = {
            "web_search": cred_by_key.get("semantic_scholar") or cred_by_key.get("tavily"),
            "web_fetch": cred_by_key.get("jina"),
        }
        for cap in caps:
            cap_id = str(cap.get("capability_id") or "")
            ref = cap.get("primary_ref")
            if not isinstance(ref, dict):
                continue
            kind = str(ref.get("kind") or "")
            rid = str(ref.get("id") or "")
            if kind == "instance" and rid in inst_id_remap:
                ref["id"] = inst_id_remap[rid]
                cap["updated_at"] = now
                changed_caps = True
            elif kind == "credential" and rid in cred_id_remap:
                ref["id"] = cred_id_remap[rid]
                cap["updated_at"] = now
                changed_caps = True
            elif cap_id in cap_inst_by_capability and kind == "instance":
                want = cap_inst_by_capability[cap_id]
                if want and rid != want:
                    ref["id"] = want
                    cap["updated_at"] = now
                    changed_caps = True
            elif cap_id in cap_cred_by_capability and kind == "credential":
                want = cap_cred_by_capability[cap_id]
                if want and rid != want:
                    ref["id"] = want
                    cap["updated_at"] = now
                    changed_caps = True

        if changed_creds:
            self._save_config_list(self.system_credentials_path, credentials)
        if changed_insts:
            self._save_config_list(self.system_instances_path, instances)
        if changed_caps:
            self._save_config_list(self.system_capabilities_path, caps)

    def _ensure_capability_param_defaults(self) -> None:
        """Backfill new capability params on existing v2 installs."""
        from app.storage.runtime_settings import (
            ORCHESTRATOR_PARAM_DEFAULTS,
            PROMPTS_PARAM_DEFAULTS,
            WEB_FETCH_PARAM_DEFAULTS,
            WEB_SEARCH_PARAM_DEFAULTS,
        )

        if not self._config_path_exists(self.system_capabilities_path):
            return
        caps = self._load_config_list(self.system_capabilities_path)
        defaults_by_cap = {
            "web_search": WEB_SEARCH_PARAM_DEFAULTS,
            "web_fetch": WEB_FETCH_PARAM_DEFAULTS,
            "orchestrator": ORCHESTRATOR_PARAM_DEFAULTS,
            "prompts": PROMPTS_PARAM_DEFAULTS,
        }
        changed = False
        for cap in caps:
            cap_id = str(cap.get("capability_id") or "")
            defaults = defaults_by_cap.get(cap_id)
            if not defaults:
                continue
            params = cap.get("params") if isinstance(cap.get("params"), dict) else {}
            merged = dict(params)
            cap_changed = False
            for key, val in defaults.items():
                if key not in merged:
                    merged[key] = val
                    cap_changed = True
            if cap_id == "web_fetch" and "max_source_chars" not in merged:
                merged["max_source_chars"] = 14_000
                cap_changed = True
            if cap_changed:
                cap["params"] = merged
                changed = True
        if changed:
            self._save_config_list(self.system_capabilities_path, caps)
        self._ensure_brave_credential()
        self._ensure_semantic_scholar_credential()
        self._ensure_provider_capability_labels()

    def _ensure_prompt_instance_bindings(self) -> None:
        """Seed empty prompt/capability instance bindings from deploy.defaults.json + env."""
        if not self._config_path_exists(self.system_capabilities_path):
            return
        instances = (
            self._load_config_list(self.system_instances_path)
            if self.system_instances_path.is_file()
            else []
        )
        inst_by_key, inst_by_name = build_instance_lookup(instances)
        caps = self._load_config_list(self.system_capabilities_path)
        changed = False
        now = _utc_now()

        for cap_id, binding in deploy_capability_instance_bindings().items():
            cap = next((c for c in caps if str(c.get("capability_id") or "") == cap_id), None)
            if not cap:
                continue
            if "primary_ref" in cap and cap.get("primary_ref") is None:
                continue
            ref = cap.get("primary_ref")
            current_id = str(ref.get("id") or "") if isinstance(ref, dict) else ""
            if current_id:
                continue
            want = resolve_instance_id_for_binding(
                binding,
                inst_by_key=inst_by_key,
                inst_by_name=inst_by_name,
            )
            if not want:
                continue
            cap["primary_ref"] = {"kind": "instance", "id": want}
            cap["updated_at"] = now
            changed = True

        prompts_cap = next(
            (c for c in caps if str(c.get("capability_id") or "") == "prompts"),
            None,
        )
        if prompts_cap is not None:
            params = dict(prompts_cap.get("params") or {})
            params_changed = False
            for param_key, binding in deploy_prompt_instance_bindings().items():
                if str(params.get(param_key) or "").strip():
                    continue
                want = resolve_instance_id_for_binding(
                    binding,
                    inst_by_key=inst_by_key,
                    inst_by_name=inst_by_name,
                )
                if not want:
                    continue
                params[param_key] = want
                params_changed = True
            if params_changed:
                prompts_cap["params"] = params
                prompts_cap["updated_at"] = now
                changed = True

        if changed:
            self._save_config_list(self.system_capabilities_path, caps)

    def _ensure_provider_capability_labels(self) -> None:
        if not self.system_capabilities_path.is_file():
            return
        label_by_id = {
            "web_search": "web_search",
            "web_fetch": "web_fetch",
        }
        caps = self._load_config_list(self.system_capabilities_path)
        changed = False
        for cap in caps:
            cap_id = str(cap.get("capability_id") or "")
            want = label_by_id.get(cap_id)
            if want and cap.get("label") != want:
                cap["label"] = want
                changed = True
        if changed:
            self._save_config_list(self.system_capabilities_path, caps)

    def _ensure_brave_credential(self) -> None:
        creds = self._load_config_list(self.system_credentials_path)
        if any(str(c.get("type") or "") == "brave" for c in creds):
            return
        from datetime import datetime, timezone as _tz

        now = datetime.now(_tz.utc).isoformat()
        creds.append(
            {
                "id": uuid.uuid4().hex,
                "type": "brave",
                "name": "Brave Search · default",
                "secret": "",
                "base_url": "",
                "group_id": "",
                "status": "unknown",
                "last_verified_at": None,
                "created_at": now,
                "updated_at": now,
            }
        )
        self._save_config_list(self.system_credentials_path, creds)

    def _ensure_semantic_scholar_credential(self) -> None:
        creds = self._load_config_list(self.system_credentials_path)
        if any(str(c.get("type") or "") == "semantic_scholar" for c in creds):
            return
        from datetime import datetime, timezone as _tz

        now = datetime.now(_tz.utc).isoformat()
        creds.append(
            {
                "id": uuid.uuid4().hex,
                "type": "semantic_scholar",
                "name": "Semantic Scholar · default",
                "secret": "",
                "base_url": "",
                "group_id": "",
                "status": "unknown",
                "last_verified_at": None,
                "created_at": now,
                "updated_at": now,
            }
        )
        self._save_config_list(self.system_credentials_path, creds)

    def _ensure_default_instances(self) -> None:
        """Backfill orchestrator instance and align review-main model on existing v2 installs."""
        if not self.system_instances_path.is_file():
            return

        instances = self._load_config_list(self.system_instances_path)
        if not instances:
            return

        legacy = self._legacy_agent_settings_merged()
        llm_provider = str(legacy.get("llm_provider") or "openai")
        creds = self._load_config_list(self.system_credentials_path)
        primary_cred = next(
            (c for c in creds if str(c.get("type") or "").startswith("llm:")),
            None,
        )
        primary_cred_id = str(primary_cred.get("id") or "") if primary_cred else ""

        changed = False
        by_name = {str(i.get("name") or ""): i for i in instances if isinstance(i, dict)}

        review = by_name.get("review-main")
        if review and review.get("model_name") == "MiniMax-M2.7":
            review["model_name"] = deploy_settings().get("llm_model") or "deepseek-v4-pro"
            review["updated_at"] = _utc_now()
            changed = True

        if "orchestrator" not in by_name and primary_cred_id:
            now = _utc_now()
            orch_tpl = next(
                (t for t in deploy_instances() if str(t.get("key") or "") == "orchestrator"),
                None,
            )
            orch_id = str(orch_tpl.get("id") or "") if orch_tpl else uuid.uuid4().hex
            orch_model = (
                str(legacy.get("orchestrator_model") or "").strip()
                or deploy_settings().get("orchestrator_model")
                or "deepseek-v4-flash"
            )
            instances.append(
                {
                    "id": orch_id,
                    "name": "orchestrator",
                    "provider": llm_provider,
                    "credential_id": primary_cred_id,
                    "model_name": orch_model,
                    "default_params": {},
                    "created_at": now,
                    "updated_at": now,
                    "status": "unknown",
                    "last_verified_at": None,
                }
            )
            changed = True
            if self.system_capabilities_path.is_file():
                caps = self._load_config_list(self.system_capabilities_path)
                for cap in caps:
                    if cap.get("capability_id") != "orchestrator":
                        continue
                    ref = cap.get("primary_ref")
                    review_id = str((review or {}).get("id") or "")
                    if isinstance(ref, dict) and str(ref.get("id") or "") == review_id:
                        cap["primary_ref"] = {"kind": "instance", "id": orch_id}
                        cap["updated_at"] = now
                        self._save_config_list(self.system_capabilities_path, caps)
                    break

        if changed:
            self._save_config_list(self.system_instances_path, instances)

    def list_system_credentials(self) -> list[dict[str, Any]]:
        self.ensure_settings_v2_migrated()
        return self._load_config_list(self.system_credentials_path)

    def save_system_credentials(self, items: list[dict[str, Any]]) -> None:
        self.ensure_settings_v2_migrated()
        self._save_config_list(self.system_credentials_path, items)

    def list_system_instances(self) -> list[dict[str, Any]]:
        self.ensure_settings_v2_migrated()
        return self._load_config_list(self.system_instances_path)

    def save_system_instances(self, items: list[dict[str, Any]]) -> None:
        self.ensure_settings_v2_migrated()
        self._save_config_list(self.system_instances_path, items)

    def list_system_capabilities(self) -> list[dict[str, Any]]:
        self.ensure_settings_v2_migrated()
        return self._load_config_list(self.system_capabilities_path)

    def save_system_capabilities(self, items: list[dict[str, Any]]) -> None:
        self.ensure_settings_v2_migrated()
        self._save_config_list(self.system_capabilities_path, items)

    def get_personal_preferences(self) -> dict[str, Any]:
        self.ensure_settings_v2_migrated()
        data = self._load_config_obj(self.personal_preferences_path, {"preferences": {}})
        prefs = data.get("preferences") or {}
        if not isinstance(prefs, dict):
            prefs = {}
        return {
            "citation_format": str(prefs.get("citation_format") or "apa").strip().lower(),
        }

    def save_personal_preferences(self, partial: dict[str, Any]) -> dict[str, Any]:
        self.ensure_settings_v2_migrated()
        current = self._load_config_obj(self.personal_preferences_path, {"preferences": {}})
        prefs = current.get("preferences") if isinstance(current.get("preferences"), dict) else {}
        for k, v in partial.items():
            if v is None:
                continue
            prefs[k] = v
        out = dict(current)
        out["preferences"] = prefs
        out["updated_at"] = _utc_now()
        self._write_config_json(self.personal_preferences_path, out)
        return self.get_personal_preferences()

    def list_sessions(self) -> list[dict[str, Any]]:
        idx = _read_json(self.root / "sessions" / "index.json", {"sessions": []})
        sessions = idx.get("sessions") or []
        enriched: list[dict[str, Any]] = []
        for s in sessions:
            sid = s.get("id")
            if not sid:
                continue
            meta = self.get_session(str(sid)) or s
            enriched.append(
                {
                    "id": sid,
                    "title": meta.get("title") or s.get("title") or "新综述",
                    "created_at": meta.get("created_at") or s.get("created_at"),
                    "updated_at": meta.get("updated_at") or s.get("updated_at"),
                    "pinned": bool(meta.get("pinned", False)),
                }
            )
        enriched.sort(
            key=lambda s: (
                -int(bool(s.get("pinned"))),
                s.get("updated_at") or "",
            ),
            reverse=True,
        )
        return enriched

    def create_session(self, title: str = "新综述") -> dict[str, Any]:
        sid = uuid.uuid4().hex
        now = _utc_now()
        meta = {
            "id": sid,
            "title": title,
            "created_at": now,
            "updated_at": now,
            "pinned": False,
        }
        sess_dir = self.root / "sessions" / sid
        sess_dir.mkdir(parents=True, exist_ok=True)
        _write_json_atomic(sess_dir / "meta.json", meta)
        idx_path = self.root / "sessions" / "index.json"
        lock_path = idx_path.with_suffix(".lock")
        with FileLock(str(lock_path)):
            idx = _read_json(idx_path, {"sessions": []})
            sessions = idx.get("sessions") or []
            sessions.insert(
                0,
                {"id": sid, "title": title, "updated_at": now, "pinned": False},
            )
            _write_json_atomic(idx_path, {"sessions": sessions})
        return meta

    def get_session(self, session_id: str) -> Optional[dict[str, Any]]:
        meta_path = self.root / "sessions" / session_id / "meta.json"
        if not meta_path.is_file():
            return None
        return _read_json(meta_path, None)

    def update_session(
        self,
        session_id: str,
        *,
        title: str | None = None,
        pinned: bool | None = None,
        title_auto_set: bool | None = None,
    ) -> Optional[dict[str, Any]]:
        meta = self.get_session(session_id)
        if not meta:
            return None
        now = _utc_now()
        if title is not None:
            meta["title"] = title
        if pinned is not None:
            meta["pinned"] = pinned
        if title_auto_set is not None:
            meta["title_auto_set"] = title_auto_set
        meta["updated_at"] = now
        _write_json_atomic(self.root / "sessions" / session_id / "meta.json", meta)
        idx_path = self.root / "sessions" / "index.json"
        lock_path = idx_path.with_suffix(".lock")
        with FileLock(str(lock_path)):
            idx = _read_json(idx_path, {"sessions": []})
            for s in idx.get("sessions") or []:
                if s.get("id") == session_id:
                    if title is not None:
                        s["title"] = title
                    if pinned is not None:
                        s["pinned"] = pinned
                    s["updated_at"] = now
            _write_json_atomic(idx_path, idx)
        return meta

    def patch_session_meta(
        self,
        session_id: str,
        patch: dict[str, Any],
    ) -> Optional[dict[str, Any]]:
        meta = self.get_session(session_id)
        if not meta:
            return None
        now = _utc_now()
        for key, value in patch.items():
            if value is not None:
                meta[key] = value
        meta["updated_at"] = now
        _write_json_atomic(self.root / "sessions" / session_id / "meta.json", meta)
        return meta

    def save_corpus(self, session_id: str, data: dict[str, Any]) -> None:
        data = dict(data)
        data["updated_at"] = _utc_now()
        path = self.root / "sessions" / session_id / "corpus.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        _write_json_atomic(path, data)

    def load_corpus(self, session_id: str) -> dict[str, Any] | None:
        path = self.root / "sessions" / session_id / "corpus.json"
        if not path.is_file():
            return None
        data = _read_json(path, None)
        return data if isinstance(data, dict) else None

    def save_outline(self, session_id: str, data: dict[str, Any]) -> None:
        payload = dict(data)
        payload["updated_at"] = _utc_now()
        path = self.root / "sessions" / session_id / "outline.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        _write_json_atomic(path, payload)

    def load_outline(self, session_id: str) -> dict[str, Any] | None:
        path = self.root / "sessions" / session_id / "outline.json"
        if not path.is_file():
            return None
        data = _read_json(path, None)
        return data if isinstance(data, dict) else None

    def has_corpus(self, session_id: str) -> bool:
        return self.load_corpus(session_id) is not None

    def delete_session(self, session_id: str) -> bool:
        import shutil

        sess_dir = self.root / "sessions" / session_id
        if sess_dir.is_dir():
            shutil.rmtree(sess_dir)
        art_dir = self.root / "artifacts" / session_id
        if art_dir.is_dir():
            shutil.rmtree(art_dir)
        idx_path = self.root / "sessions" / "index.json"
        lock_path = idx_path.with_suffix(".lock")
        with FileLock(str(lock_path)):
            idx = _read_json(idx_path, {"sessions": []})
            sessions = [s for s in (idx.get("sessions") or []) if s.get("id") != session_id]
            _write_json_atomic(idx_path, {"sessions": sessions})
        return True

    def append_message(
        self,
        session_id: str,
        role: str,
        content: str,
        *,
        meta: dict[str, Any] | None = None,
    ) -> None:
        msg_path = self.root / "sessions" / session_id / "messages.jsonl"
        msg_path.parent.mkdir(parents=True, exist_ok=True)
        rec: dict[str, Any] = {
            "role": role,
            "content": content,
            "ts": _utc_now(),
        }
        if meta:
            rec["meta"] = meta
        line = json.dumps(rec, ensure_ascii=False)
        with open(msg_path, "a", encoding="utf-8") as f:
            f.write(line + "\n")
        meta = self.get_session(session_id)
        if meta:
            meta["updated_at"] = _utc_now()
            _write_json_atomic(
                self.root / "sessions" / session_id / "meta.json",
                meta,
            )
            idx_path = self.root / "sessions" / "index.json"
            lock_path = idx_path.with_suffix(".lock")
            with FileLock(str(lock_path)):
                idx = _read_json(idx_path, {"sessions": []})
                for s in idx.get("sessions") or []:
                    if s.get("id") == session_id:
                        s["updated_at"] = meta["updated_at"]
                _write_json_atomic(idx_path, idx)

    def load_messages(
        self,
        session_id: str,
        *,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        msg_path = self.root / "sessions" / session_id / "messages.jsonl"
        if not msg_path.is_file():
            return []
        lines = msg_path.read_text(encoding="utf-8").strip().splitlines()
        msgs = []
        for ln in lines[-limit:]:
            if ln.strip():
                try:
                    msgs.append(json.loads(ln))
                except json.JSONDecodeError:
                    continue
        return msgs

    def load_first_user_message(self, session_id: str, *, max_chars: int = 800) -> str:
        """First user turn in session (for library provenance preview)."""
        msg_path = self.root / "sessions" / session_id / "messages.jsonl"
        if not msg_path.is_file():
            return ""
        try:
            with open(msg_path, encoding="utf-8") as f:
                for ln in f:
                    line = ln.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if rec.get("role") != "user":
                        continue
                    content = rec.get("content") or ""
                    if isinstance(content, list):
                        parts = []
                        for block in content:
                            if isinstance(block, dict) and block.get("type") == "text":
                                parts.append(str(block.get("text") or ""))
                            elif isinstance(block, str):
                                parts.append(block)
                        content = "\n".join(parts)
                    text = str(content).strip()
                    if text:
                        return text[:max_chars]
        except OSError:
            return ""
        return ""

    def save_review_artifact(
        self,
        session_id: str,
        content: str,
        *,
        version_id: str | None = None,
        version_kind: str = "full",
        parent_version: str | None = None,
    ) -> tuple[Path, str]:
        return self._save_markdown_artifact(
            session_id,
            content,
            kind="review",
            meta_key="review_versions",
            version_id=version_id,
            version_kind=version_kind,
            parent_version=parent_version,
        )

    def save_matrix_artifact(
        self,
        session_id: str,
        content: str,
    ) -> tuple[Path, str]:
        return self._save_markdown_artifact(
            session_id,
            content,
            kind="matrix",
            meta_key="matrix_versions",
        )

    def _save_markdown_artifact(
        self,
        session_id: str,
        content: str,
        *,
        kind: str,
        meta_key: str,
        version_id: str | None = None,
        version_kind: str = "full",
        parent_version: str | None = None,
    ) -> tuple[Path, str]:
        art_dir = self.root / "artifacts" / session_id
        art_dir.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
        resolved_id = (version_id or "").strip() or f"{kind}_{uuid.uuid4().hex[:12]}"
        safe_id = re.sub(r"[^a-zA-Z0-9._-]", "", resolved_id) or resolved_id
        filename = f"{kind}-{safe_id}.md"
        path = art_dir / filename
        path.write_text(content, encoding="utf-8")
        latest = art_dir / f"{kind}-latest.md"
        latest.write_text(content, encoding="utf-8")
        meta = self.get_session(session_id)
        if meta is not None:
            versions = list(meta.get(meta_key) or [])
            versions.append(
                {
                    "id": safe_id,
                    "version": safe_id,
                    "filename": filename,
                    "created_at": _utc_now(),
                    "kind": version_kind,
                    "parent": parent_version,
                }
            )
            meta[meta_key] = versions[-20:]
            meta["updated_at"] = _utc_now()
            _write_json_atomic(
                self.root / "sessions" / session_id / "meta.json",
                meta,
            )
        return path, safe_id

    def get_latest_review(self, session_id: str) -> dict[str, Any] | None:
        art_dir = self.root / "artifacts" / session_id
        latest = art_dir / "review-latest.md"
        if latest.is_file():
            return {
                "filename": "review-latest.md",
                "content": latest.read_text(encoding="utf-8"),
                "updated_at": datetime.fromtimestamp(
                    latest.stat().st_mtime, tz=timezone.utc
                ).isoformat(),
            }
        if not art_dir.is_dir():
            return None
        files = sorted(art_dir.glob("review-*.md"), key=lambda p: p.stat().st_mtime)
        if not files:
            return None
        path = files[-1]
        return {
            "filename": path.name,
            "content": path.read_text(encoding="utf-8"),
            "updated_at": datetime.fromtimestamp(
                path.stat().st_mtime, tz=timezone.utc
            ).isoformat(),
        }

    def get_review_by_filename(
        self, session_id: str, filename: str
    ) -> dict[str, Any] | None:
        if ".." in filename or "/" in filename or "\\" in filename:
            return None
        if not filename.startswith("review-") or not filename.endswith(".md"):
            return None
        path = self.root / "artifacts" / session_id / filename
        if not path.is_file():
            return None
        return {
            "filename": path.name,
            "content": path.read_text(encoding="utf-8"),
            "updated_at": datetime.fromtimestamp(
                path.stat().st_mtime, tz=timezone.utc
            ).isoformat(),
        }

    def get_latest_matrix(self, session_id: str) -> dict[str, Any] | None:
        art_dir = self.root / "artifacts" / session_id
        latest = art_dir / "matrix-latest.md"
        if latest.is_file():
            return {
                "filename": "matrix-latest.md",
                "content": latest.read_text(encoding="utf-8"),
                "updated_at": datetime.fromtimestamp(
                    latest.stat().st_mtime, tz=timezone.utc
                ).isoformat(),
            }
        if not art_dir.is_dir():
            return None
        files = sorted(art_dir.glob("matrix-*.md"), key=lambda p: p.stat().st_mtime)
        if not files:
            return None
        path = files[-1]
        return {
            "filename": path.name,
            "content": path.read_text(encoding="utf-8"),
            "updated_at": datetime.fromtimestamp(
                path.stat().st_mtime, tz=timezone.utc
            ).isoformat(),
        }

    def append_ref_line(self, line: str) -> None:
        ref_path = self.root / "refs" / "ref-list.txt"
        lock_path = ref_path.with_suffix(".lock")
        with FileLock(str(lock_path)):
            with open(ref_path, "a", encoding="utf-8") as f:
                f.write(line.rstrip() + "\n\n")

    def read_ref_list(self) -> str:
        ref_path = self.root / "refs" / "ref-list.txt"
        if not ref_path.is_file():
            return ""
        return ref_path.read_text(encoding="utf-8")

    def load_ref_index(self) -> dict[str, Any]:
        return _read_json(self.root / "refs" / "index.json", {"refs": []})

    def append_ref_index(self, entry: dict[str, Any]) -> dict[str, Any]:
        idx_path = self.root / "refs" / "index.json"
        lock_path = idx_path.with_suffix(".lock")
        with FileLock(str(lock_path)):
            idx = _read_json(idx_path, {"refs": []})
            refs = idx.get("refs") or []
            refs.append(entry)
            _write_json_atomic(idx_path, {"refs": refs})
        return entry

    def list_pdfs(self) -> list[str]:
        pdf_dir = self.root / "pdfs"
        if not pdf_dir.is_dir():
            return []
        return sorted(f.name for f in pdf_dir.iterdir() if f.suffix.lower() == ".pdf")

    def pdf_path(self, filename: str) -> Path:
        safe = Path(filename).name
        return self.root / "pdfs" / safe


def get_store() -> FileStore:
    """Delegate to storage factory (file / turso / hybrid)."""
    from app.storage.backend import get_store as _factory_get_store

    return _factory_get_store()
