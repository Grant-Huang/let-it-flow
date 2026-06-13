"""进程级共享 httpx.AsyncClient：keep-alive 连接池 + HTTP/2 + 拆分超时。

为何共享：每次 LLM 调用新建 ``AsyncClient`` 会重复 DNS/TCP/TLS 握手，显著抬高
首 token 延迟（TTFT）。进程级复用连接池后，后续请求走 keep-alive，省去握手开销。

按事件循环隔离：pytest-asyncio 等会为不同测试创建新循环，跨循环复用同一
client 会触发 "attached to a different loop" 错误，故以 loop id 为键缓存。
"""
from __future__ import annotations

import asyncio

import httpx

DEFAULT_TIMEOUT = httpx.Timeout(connect=5.0, read=120.0, write=30.0, pool=5.0)
DEFAULT_LIMITS = httpx.Limits(
    max_keepalive_connections=20,
    max_connections=100,
    keepalive_expiry=60.0,
)

_clients: dict[int, httpx.AsyncClient] = {}


def _build_client() -> httpx.AsyncClient:
    """优先 HTTP/2；若环境未安装 h2 则回退 HTTP/1.1（仍保留连接池）。"""
    try:
        return httpx.AsyncClient(
            http2=True,
            timeout=DEFAULT_TIMEOUT,
            limits=DEFAULT_LIMITS,
        )
    except ImportError:
        return httpx.AsyncClient(
            http2=False,
            timeout=DEFAULT_TIMEOUT,
            limits=DEFAULT_LIMITS,
        )


def _loop_key() -> int:
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = asyncio.get_event_loop()
    return id(loop)


def get_async_client() -> httpx.AsyncClient:
    """返回当前事件循环上的共享客户端（懒创建，复用连接池）。"""
    key = _loop_key()
    client = _clients.get(key)
    if client is None or client.is_closed:
        client = _build_client()
        _clients[key] = client
    return client


async def aclose_all() -> None:
    """关闭并清空所有共享客户端（应用 shutdown / 测试清理用）。"""
    clients = list(_clients.values())
    _clients.clear()
    for client in clients:
        if not client.is_closed:
            await client.aclose()
