"""Build flat runtime settings dict from v2 system/personal config."""

from __future__ import annotations



from typing import Any



from app.agents.prompt_registry import (
    PROMPT_TEMPLATE_PARAM_DEFAULTS,
    PROMPT_SPECS,
    clamp_prompt_max_tokens_value,
    prompt_max_tokens_param,
)
from app.agents.tools.search_hits import ACADEMIC_SEARCH_DOMAINS, DEFAULT_EXCLUDE_DOMAINS



WEB_SEARCH_PARAM_DEFAULTS: dict[str, Any] = {

    "search_provider": "multi_academic",

    "search_max_results": 20,

    "search_retry_count": 3,

    "include_domains": list(ACADEMIC_SEARCH_DOMAINS),

    "exclude_domains": list(DEFAULT_EXCLUDE_DOMAINS),

    "search_depth": "advanced",

    "enforce_domain_filter": True,

    "enable_junk_filter": True,

}



WEB_FETCH_PARAM_DEFAULTS: dict[str, Any] = {

    "fetch_provider": "native",

    "pdf_extract_backend": "pymupdf4llm",

    "max_fetch_urls": 5,

    "fetch_parallel": 3,

    "fetch_timeout_sec": 45.0,

    "fetch_retry_count": 0,

    "fetch_retry_delay_ms": 500,

    "max_source_chars": 14_000,

}



ORCHESTRATOR_PARAM_DEFAULTS: dict[str, Any] = {

    "use_llm_planner": True,

    "orchestrator_mode": "lite",

    "orchestrator_use_reasoning": False,

    "orchestrator_max_tokens_per_phase": 420,

}



# 全部 6 个提示词分组各自的独立模型实例 ID（统一在 prompts.params 中存储）
_PROMPT_GROUP_INSTANCE_PARAMS: list[str] = [
    "orchestrator_instance_id",
    "generation_instance_id",
    "router_instance_id",
    "search_instance_id",
    "assessor_instance_id",
    "pipeline_instance_id",
]

PROMPTS_PARAM_DEFAULTS: dict[str, Any] = {
    **PROMPT_TEMPLATE_PARAM_DEFAULTS,
    **{k: "" for k in _PROMPT_GROUP_INSTANCE_PARAMS},
}



_WEB_SEARCH_LEGACY_PARAM_KEYS = (

    ("search_max_results", "search_max_results"),

    ("search_retry_count", "search_retry_count"),

)





def _find_cap(caps: list[dict[str, Any]], cap_id: str) -> dict[str, Any] | None:

    for c in caps:

        if str(c.get("capability_id") or "") == cap_id:

            return c

    return None





def _find_by_id(items: list[dict[str, Any]], id_: str) -> dict[str, Any] | None:

    for it in items:

        if str(it.get("id") or "") == str(id_):

            return it

    return None





def _normalize_web_search_params(params: dict[str, Any]) -> dict[str, Any]:

    out = dict(params)

    for new_key, legacy_key in _WEB_SEARCH_LEGACY_PARAM_KEYS:

        if new_key not in out and legacy_key in out:

            out[new_key] = out[legacy_key]

    return out





def _cap_params(caps: list[dict[str, Any]], cap_id: str, defaults: dict[str, Any]) -> dict[str, Any]:

    cap = _find_cap(caps, cap_id)

    raw = cap.get("params") if cap else None
    override_raw = cap.get("override_params") if cap else None

    params = dict(raw) if isinstance(raw, dict) else {}
    if isinstance(override_raw, dict) and override_raw:
        params.update(override_raw)

    if cap_id == "web_search":

        params = _normalize_web_search_params(params)

    out = dict(defaults)

    out.update(params)

    return out





def _parse_domain_list(raw: Any) -> tuple[str, ...]:

    if isinstance(raw, (list, tuple)):

        return tuple(str(d).strip() for d in raw if str(d).strip())

    if isinstance(raw, str):

        parts = [p.strip() for p in raw.replace(",", "\n").splitlines() if p.strip()]

        return tuple(parts)

    return ()





def _resolve_instance_llm(

    instances: list[dict[str, Any]],

    credentials: list[dict[str, Any]],

    inst_id: str | None,

) -> dict[str, Any]:

    if not inst_id:

        return {}

    inst = _find_by_id(instances, inst_id)

    if not inst:

        return {}

    cred = _find_by_id(credentials, str(inst.get("credential_id") or ""))

    if not cred:

        return {}

    ctype = str(cred.get("type") or "")

    provider = str(inst.get("provider") or "")

    if not provider and ctype.startswith("llm:"):

        provider = ctype.split(":", 1)[1]

    return {

        "llm_provider": provider or "openai",

        "llm_api_key": str(cred.get("secret") or ""),

        "llm_model": str(inst.get("model_name") or "").strip(),

        "llm_base_url": str(cred.get("base_url") or "").strip(),

        "llm_group_id": str(cred.get("group_id") or "").strip(),

    }


def _prefixed_llm_fields(prefix: str, llm: dict[str, Any], *, fallback: dict[str, Any]) -> dict[str, str]:
    """Map resolved instance dict to flat ``{prefix}_provider`` keys with fallback."""
    src = llm if llm.get("llm_model") else fallback
    return {
        f"{prefix}_provider": str(src.get("llm_provider") or fallback.get("llm_provider") or "openai"),
        f"{prefix}_api_key": str(src.get("llm_api_key") or fallback.get("llm_api_key") or ""),
        f"{prefix}_model": str(src.get("llm_model") or fallback.get("llm_model") or "gpt-4o-mini"),
        f"{prefix}_base_url": str(src.get("llm_base_url") or fallback.get("llm_base_url") or ""),
        f"{prefix}_group_id": str(src.get("llm_group_id") or fallback.get("llm_group_id") or ""),
    }


def _resolve_group_instance_id(
    prompts: dict[str, Any],
    param_key: str,
    *,
    fallback: str = "",
) -> str:
    """Read a group instance ID from ``prompts.params``, with optional fallback."""
    return str(prompts.get(param_key) or "").strip() or fallback





def _credential_secret(credentials: list[dict[str, Any]], cred_id: str | None) -> str:

    if not cred_id:

        return ""

    cred = _find_by_id(credentials, cred_id)

    if not cred:

        return ""

    return str(cred.get("secret") or "")


def _credential_secret_by_type(credentials: list[dict[str, Any]], cred_type: str) -> str:
    for cred in credentials:
        if str(cred.get("type") or "") == cred_type:
            secret = str(cred.get("secret") or "").strip()
            if secret:
                return secret
    return ""





def build_runtime_settings(

    *,

    credentials: list[dict[str, Any]],

    instances: list[dict[str, Any]],

    capabilities: list[dict[str, Any]],

    personal: dict[str, Any],

) -> dict[str, Any]:

    web = _cap_params(capabilities, "web_search", WEB_SEARCH_PARAM_DEFAULTS)

    fetch = _cap_params(capabilities, "web_fetch", WEB_FETCH_PARAM_DEFAULTS)

    orch = _cap_params(capabilities, "orchestrator", ORCHESTRATOR_PARAM_DEFAULTS)

    prompts = _cap_params(capabilities, "prompts", PROMPTS_PARAM_DEFAULTS)



    review_cap = _find_cap(capabilities, "review_main")

    orch_cap = _find_cap(capabilities, "orchestrator")

    search_cap = _find_cap(capabilities, "web_search")

    fetch_cap = _find_cap(capabilities, "web_fetch")



    review_ref = (review_cap or {}).get("primary_ref") if isinstance((review_cap or {}).get("primary_ref"), dict) else {}

    orch_ref = (orch_cap or {}).get("primary_ref") if isinstance((orch_cap or {}).get("primary_ref"), dict) else {}

    search_ref = (search_cap or {}).get("primary_ref") if isinstance((search_cap or {}).get("primary_ref"), dict) else {}

    fetch_ref = (fetch_cap or {}).get("primary_ref") if isinstance((fetch_cap or {}).get("primary_ref"), dict) else {}



    review_inst_id = str(review_ref.get("id") or "") if review_ref.get("kind") == "instance" else ""

    orch_inst_id = str(orch_ref.get("id") or "") if orch_ref.get("kind") == "instance" else ""

    fetch_provider = str(fetch.get("fetch_provider") or "native").strip().lower()

    search_provider = str(web.get("search_provider") or "multi_academic").strip().lower()

    fetch_cred_id = str(fetch_ref.get("id") or "") if fetch_ref.get("kind") == "credential" else ""

    search_cred_id = str(search_ref.get("id") or "") if search_ref.get("kind") == "credential" else ""

    search_cred = _find_by_id(credentials, search_cred_id)

    search_cred_type = str((search_cred or {}).get("type") or "")

    search_cred_secret = _credential_secret(credentials, search_cred_id)



    llm = _resolve_instance_llm(instances, credentials, review_inst_id)

    orch_llm = _resolve_instance_llm(instances, credentials, orch_inst_id)

    planner_llm = orch_llm if orch_llm.get("llm_model") else llm

    # 全部 6 个分组独立解析实例 ID，移除回退到 orchestrator 的逻辑
    orchestrator_inst_id = _resolve_group_instance_id(
        prompts, "orchestrator_instance_id", fallback=orch_inst_id
    )
    generation_inst_id = _resolve_group_instance_id(
        prompts, "generation_instance_id", fallback=review_inst_id
    )
    router_inst_id = _resolve_group_instance_id(prompts, "router_instance_id")
    search_inst_id = _resolve_group_instance_id(prompts, "search_instance_id")
    assessor_inst_id = _resolve_group_instance_id(prompts, "assessor_instance_id")
    pipeline_inst_id = _resolve_group_instance_id(prompts, "pipeline_instance_id")

    # 解析 LLM 配置：orchestrator 和 generation 支持 primary_ref 回退，其余仅从 prompts.params 读取
    resolved_orch_llm = _resolve_instance_llm(instances, credentials, orchestrator_inst_id) or planner_llm
    resolved_gen_llm = _resolve_instance_llm(instances, credentials, generation_inst_id) or llm
    router_llm = _resolve_instance_llm(instances, credentials, router_inst_id) or planner_llm
    search_llm = _resolve_instance_llm(instances, credentials, search_inst_id) or planner_llm
    assessor_llm = _resolve_instance_llm(instances, credentials, assessor_inst_id) or planner_llm
    pipeline_llm = _resolve_instance_llm(instances, credentials, pipeline_inst_id) or planner_llm

    include_domains = _parse_domain_list(web.get("include_domains")) or ACADEMIC_SEARCH_DOMAINS

    exclude_domains = _parse_domain_list(web.get("exclude_domains")) or DEFAULT_EXCLUDE_DOMAINS

    search_depth = str(web.get("search_depth") or "advanced").strip().lower()

    if search_depth not in ("basic", "advanced"):

        search_depth = "advanced"



    search_api_key = search_cred_secret if search_cred_type == "tavily" else ""

    brave_key = search_cred_secret if search_cred_type == "brave" else ""

    s2_api_key = search_cred_secret if search_cred_type == "semantic_scholar" else ""

    if search_provider == "tavily" and not search_api_key:

        search_api_key = _credential_secret_by_type(credentials, "tavily")

    if search_provider == "brave" and not brave_key:

        brave_key = _credential_secret_by_type(credentials, "brave")

    if search_provider == "multi_academic" and not s2_api_key:

        s2_api_key = _credential_secret_by_type(credentials, "semantic_scholar")



    web_search_key = (

        search_api_key

        if search_provider == "tavily"

        else brave_key

        if search_provider == "brave"

        else ""

    )



    return {

        "brave_api_key": brave_key if search_provider == "brave" else "",

        "web_search_api_key": web_search_key,

        "fetch_api_key": (

            _credential_secret(credentials, fetch_cred_id)

            if fetch_provider == "jina"

            else ""

        ),

        "search_provider": search_provider,

        "s2_api_key": s2_api_key,

        "fetch_provider": fetch_provider,

        "pdf_extract_backend": str(
            fetch.get("pdf_extract_backend") or "pymupdf4llm"
        ).strip().lower(),

        "llm_provider": resolved_gen_llm.get("llm_provider") or "openai",

        "llm_api_key": resolved_gen_llm.get("llm_api_key") or "",

        "llm_model": resolved_gen_llm.get("llm_model") or "gpt-4o-mini",

        "llm_base_url": resolved_gen_llm.get("llm_base_url") or "",

        "llm_group_id": resolved_gen_llm.get("llm_group_id") or "",

        "orchestrator_model": resolved_orch_llm.get("llm_model") or "",

        "planner_llm_provider": resolved_orch_llm.get("llm_provider") or llm.get("llm_provider") or "openai",

        "planner_llm_api_key": resolved_orch_llm.get("llm_api_key") or llm.get("llm_api_key") or "",

        "planner_llm_model": resolved_orch_llm.get("llm_model") or llm.get("llm_model") or "gpt-4o-mini",

        "planner_llm_base_url": resolved_orch_llm.get("llm_base_url") or llm.get("llm_base_url") or "",

        "planner_llm_group_id": resolved_orch_llm.get("llm_group_id") or llm.get("llm_group_id") or "",

        **_prefixed_llm_fields("router_llm", router_llm, fallback=resolved_orch_llm),

        **_prefixed_llm_fields("search_llm", search_llm, fallback=resolved_orch_llm),

        **_prefixed_llm_fields("assessor_llm", assessor_llm, fallback=resolved_orch_llm),

        **_prefixed_llm_fields("pipeline_llm", pipeline_llm, fallback=resolved_orch_llm),

        "fetch_parallel": int(fetch.get("fetch_parallel") or 3),

        "fetch_timeout_sec": float(fetch.get("fetch_timeout_sec") or 45),

        "search_max_results": int(web.get("search_max_results") or 20),

        "max_fetch_urls": int(fetch.get("max_fetch_urls") or 5),

                                "search_retry_count": int(web.get("search_retry_count") or 3),

        "fetch_retry_count": int(fetch.get("fetch_retry_count") or 0),

        "fetch_retry_delay_ms": int(fetch.get("fetch_retry_delay_ms") or 500),

                "citation_format": str(personal.get("citation_format") or "apa").strip().lower(),

        "use_llm_planner": bool(orch.get("use_llm_planner", True)),

        "orchestrator_mode": str(orch.get("orchestrator_mode") or "lite").strip().lower(),

        "orchestrator_use_reasoning": bool(orch.get("orchestrator_use_reasoning", False)),

        "orchestrator_max_tokens_per_phase": int(orch.get("orchestrator_max_tokens_per_phase") or 280),

        **{
            key: str(prompts.get(key) or "")
            for key in PROMPT_TEMPLATE_PARAM_DEFAULTS
        },
        **{
            prompt_max_tokens_param(key): clamp_prompt_max_tokens_value(
                key, prompts.get(prompt_max_tokens_param(key))
            )
            for key in PROMPT_SPECS
            if str(prompts.get(prompt_max_tokens_param(key)) or "").strip()
        },

        "search_include_domains": list(include_domains),

        "search_exclude_domains": list(exclude_domains),

        "search_depth": search_depth,

        "search_enforce_domain_filter": bool(web.get("enforce_domain_filter", True)),

        "search_enable_junk_filter": bool(web.get("enable_junk_filter", True)),

        "max_source_chars": int(fetch.get("max_source_chars") or 14_000),

                                            }

