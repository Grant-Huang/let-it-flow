def skill_active_event(skill_id: str) -> tuple[str, dict]:
    labels = {
        "literature-review": "文献综述",
    }
    return (
        "skill_active",
        {
            "id": skill_id,
            "name": labels.get(skill_id, skill_id),
            "provider": "local",
        },
    )


def capabilities_payload() -> dict:
    return {
        "tools": [
            {
                "name": "web_search",
                "provider": "api",
                "risk": "safe",
                "description": "web_search 学术检索",
            },
            {
                "name": "web_fetch",
                "provider": "api",
                "risk": "safe",
                "description": "web_fetch 网页抓取",
            },
            {
                "name": "extract_citation",
                "provider": "local",
                "risk": "safe",
                "description": "APA/ACM 引用抽取",
            },
        ],
        "skills": [
            {
                "id": "literature-review",
                "name": "文献综述",
                "provider": "local",
            },
        ],
        "resources": [],
        "mcp_servers": [],
    }
