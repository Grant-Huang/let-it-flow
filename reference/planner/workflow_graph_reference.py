"""Workflow execution plan (v2): understand → per-subtopic search/filter/fetch → review chapters + matrix."""
from __future__ import annotations

import json
from copy import deepcopy
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

NodeStatus = Literal["pending", "active", "done", "skipped", "error"]
NodeKind = Literal[
    "router",
    "search",
    "fetch",
    "llm",
    "deliver",
    "chat",
]


@dataclass
class WorkflowNode:
    id: str
    label: str
    kind: NodeKind
    status: NodeStatus = "pending"
    description: str = ""
    meta: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class WorkflowEdge:
    id: str
    source: str
    target: str
    label: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class WorkflowGraph:
    id: str
    title: str
    version: str = "1.0"
    nodes: list[WorkflowNode] = field(default_factory=list)
    edges: list[WorkflowEdge] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "id": self.id,
            "title": self.title,
            "nodes": [n.to_dict() for n in self.nodes],
            "edges": [e.to_dict() for e in self.edges],
        }

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), ensure_ascii=False)

    def node(self, node_id: str) -> WorkflowNode | None:
        for n in self.nodes:
            if n.id == node_id:
                return n
        return None

    def set_node_status(self, node_id: str, status: NodeStatus) -> None:
        n = self.node(node_id)
        if n:
            n.status = status

    def clone(self) -> WorkflowGraph:
        return deepcopy(self)


def fetch_node_description(fetch_provider: str) -> str:
    """Human-readable fetch backend label for the execution plan UI."""
    p = (fetch_provider or "native").strip().lower()
    if p == "native":
        return "native 直连 HTTP / web_fetch"
    from app.agents.tools.web_providers import fetch_provider_display

    return f"{fetch_provider_display(p)} / web_fetch"


def apply_fetch_provider_label(graph: WorkflowGraph, fetch_provider: str) -> None:
    n = graph.node("fetch")
    if n:
        n.description = fetch_node_description(fetch_provider)


def build_literature_graph(
    section_specs: list[tuple[str, str]] | None = None,
) -> WorkflowGraph:
    """
    v2 执行计划：理解 → 检索/过滤/抓取（按子主题）→ 分章综述 + 矩阵。

    section_specs: [(node_id, label), ...] — one node per chapter.
    """
    section_specs = section_specs or []
    nodes: list[WorkflowNode] = [
        WorkflowNode("understand", "理解研究问题", "router", description="Brief + 子主题识别"),
        WorkflowNode("search", "子主题检索", "search", description="每子主题并行"),
        WorkflowNode("filter", "子主题过滤", "llm", description="LLM 二次过滤"),
        WorkflowNode("fetch", "抓取全文", "fetch", description=fetch_node_description("native")),
    ]
    edges: list[WorkflowEdge] = [
        WorkflowEdge("e1", "understand", "search"),
        WorkflowEdge("e2", "search", "filter"),
        WorkflowEdge("e3", "filter", "fetch"),
    ]

    prev = "fetch"
    for i, (sid, label) in enumerate(section_specs):
        nodes.append(
            WorkflowNode(
                sid,
                label[:24],
                "llm",
                description="分章综述",
                meta={"chapter": True},
            )
        )
        edges.append(WorkflowEdge(f"es{i}", prev, sid))
        prev = sid

    nodes.append(WorkflowNode("matrix", "文献矩阵", "llm", description="论文 × 主题对比"))
    nodes.append(WorkflowNode("deliver", "交付", "deliver", description="保存引用与 Artifact"))
    edges.append(WorkflowEdge("em", prev, "matrix"))
    edges.append(WorkflowEdge("ed", "matrix", "deliver"))

    return WorkflowGraph(
        id="literature-agent",
        title="文献综述执行计划",
        nodes=nodes,
        edges=edges,
    )
