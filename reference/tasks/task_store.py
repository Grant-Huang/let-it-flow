"""Persistent storage for background literature tasks (file + Turso)."""
from __future__ import annotations

import json
import os
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from filelock import FileLock

from app.core.config import DATA_DIR

TaskStatus = Literal["pending", "running", "completed", "failed", "cancelled"]

TERMINAL_STATUSES: frozenset[TaskStatus] = frozenset(
    {"completed", "failed", "cancelled"},
)

ACTIVE_STATUSES: frozenset[TaskStatus] = frozenset({"pending", "running"})


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _iso_to_epoch(value: str | None) -> float | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def current_worker_id() -> str:
    return f"{os.getpid()}-{uuid.uuid4().hex[:8]}"


@dataclass
class TaskRecord:
    id: str
    session_id: str
    message: str
    fetch_urls: list[str]
    status: TaskStatus = "pending"
    progress: int = 0
    stage: str = "starting"
    error: str | None = None
    cancel_requested: bool = False
    worker_id: str | None = None
    started_at: float = 0.0
    finished_at: float | None = None
    event_count: int = 0
    updated_at: float = 0.0

    def to_status_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.id,
            "session_id": self.session_id,
            "status": self.status,
            "progress": self.progress,
            "stage": self.stage,
            "error": self.error,
            "event_count": self.event_count,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
        }

    def to_active_dict(self) -> dict[str, Any]:
        row = self.to_status_dict()
        row.pop("error", None)
        return row


class TaskStore(ABC):
    @abstractmethod
    def create_task(
        self,
        *,
        session_id: str,
        message: str,
        fetch_urls: list[str] | None = None,
        task_id: str | None = None,
    ) -> TaskRecord:
        raise NotImplementedError

    @abstractmethod
    def get_task(self, task_id: str) -> TaskRecord | None:
        raise NotImplementedError

    @abstractmethod
    def list_active_tasks(self) -> list[TaskRecord]:
        raise NotImplementedError

    @abstractmethod
    def try_claim(self, task_id: str, worker_id: str) -> bool:
        raise NotImplementedError

    @abstractmethod
    def request_cancel(self, task_id: str) -> TaskRecord | None:
        raise NotImplementedError

    @abstractmethod
    def is_cancel_requested(self, task_id: str) -> bool:
        raise NotImplementedError

    @abstractmethod
    def update_task(
        self,
        task_id: str,
        *,
        status: TaskStatus | None = None,
        progress: int | None = None,
        stage: str | None = None,
        error: str | None = None,
        finished_at: float | None = None,
        clear_error: bool = False,
    ) -> TaskRecord | None:
        raise NotImplementedError

    @abstractmethod
    def append_event(self, task_id: str, event_line: str) -> int:
        raise NotImplementedError

    def append_events_batch(self, task_id: str, event_lines: list[str]) -> int:
        """单次落库多条事件。默认实现为顺序回退。

        子类应覆盖以将 N 次锁/写/meta 操作合并为 1 次，显著降低磁盘 I/O。
        """
        last = 0
        for line in event_lines:
            last = self.append_event(task_id, line)
        return last

    @abstractmethod
    def list_events(self, task_id: str, since: int = 0) -> list[str]:
        raise NotImplementedError

    @abstractmethod
    def requeue_stale_running(self, updated_before_epoch: float) -> list[str]:
        """Reset stale running tasks to pending; returns requeued task ids."""
        raise NotImplementedError


class FileTaskStore(TaskStore):
    def __init__(self, root: Path | None = None) -> None:
        self.root = (root or DATA_DIR / "tasks").resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def _meta_path(self, task_id: str) -> Path:
        return self.root / task_id / "meta.json"

    def _events_path(self, task_id: str) -> Path:
        return self.root / task_id / "events.jsonl"

    def _lock_path(self, task_id: str) -> Path:
        return self.root / task_id / "meta.lock"

    def _read_meta_unlocked(self, task_id: str) -> dict[str, Any] | None:
        path = self._meta_path(task_id)
        if not path.is_file():
            return None
        with open(path, encoding="utf-8") as f:
            return json.load(f)

    def _write_meta_unlocked(self, task_id: str, meta: dict[str, Any]) -> None:
        path = self._meta_path(task_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)

    def _meta_to_record(self, meta: dict[str, Any]) -> TaskRecord:
        return TaskRecord(
            id=str(meta["id"]),
            session_id=str(meta["session_id"]),
            message=str(meta["message"]),
            fetch_urls=list(meta.get("fetch_urls") or []),
            status=meta.get("status", "pending"),
            progress=int(meta.get("progress") or 0),
            stage=str(meta.get("stage") or "starting"),
            error=meta.get("error"),
            cancel_requested=bool(meta.get("cancel_requested")),
            worker_id=meta.get("worker_id"),
            started_at=float(meta.get("started_at") or 0.0),
            finished_at=meta.get("finished_at"),
            event_count=int(meta.get("event_count") or 0),
            updated_at=_iso_to_epoch(meta.get("updated_at"))
            or float(meta.get("started_at") or 0.0),
        )

    def create_task(
        self,
        *,
        session_id: str,
        message: str,
        fetch_urls: list[str] | None = None,
        task_id: str | None = None,
    ) -> TaskRecord:
        tid = task_id or uuid.uuid4().hex
        now = datetime.now(timezone.utc).timestamp()
        meta = {
            "id": tid,
            "session_id": session_id,
            "message": message,
            "fetch_urls": list(fetch_urls or []),
            "status": "pending",
            "progress": 0,
            "stage": "starting",
            "error": None,
            "cancel_requested": False,
            "worker_id": None,
            "started_at": now,
            "finished_at": None,
            "event_count": 0,
            "updated_at": _utc_now(),
        }
        self._meta_path(tid).parent.mkdir(parents=True, exist_ok=True)
        self._events_path(tid).touch(exist_ok=True)
        with FileLock(str(self._lock_path(tid))):
            self._write_meta_unlocked(tid, meta)
        return self._meta_to_record(meta)

    def get_task(self, task_id: str) -> TaskRecord | None:
        with FileLock(str(self._lock_path(task_id))):
            meta = self._read_meta_unlocked(task_id)
        if not meta:
            return None
        return self._meta_to_record(meta)

    def list_active_tasks(self) -> list[TaskRecord]:
        rows: list[TaskRecord] = []
        if not self.root.is_dir():
            return rows
        for child in self.root.iterdir():
            if not child.is_dir():
                continue
            task = self.get_task(child.name)
            if task and task.status in ACTIVE_STATUSES:
                rows.append(task)
        rows.sort(key=lambda t: t.started_at, reverse=True)
        return rows

    def try_claim(self, task_id: str, worker_id: str) -> bool:
        with FileLock(str(self._lock_path(task_id))):
            meta = self._read_meta_unlocked(task_id)
            if not meta or meta.get("status") != "pending":
                return False
            meta["status"] = "running"
            meta["worker_id"] = worker_id
            meta["updated_at"] = _utc_now()
            self._write_meta_unlocked(task_id, meta)
            return True

    def request_cancel(self, task_id: str) -> TaskRecord | None:
        with FileLock(str(self._lock_path(task_id))):
            meta = self._read_meta_unlocked(task_id)
            if not meta:
                return None
            meta["cancel_requested"] = True
            meta["updated_at"] = _utc_now()
            if meta.get("status") in ACTIVE_STATUSES and meta.get("status") == "pending":
                meta["status"] = "cancelled"
                meta["finished_at"] = datetime.now(timezone.utc).timestamp()
            self._write_meta_unlocked(task_id, meta)
            return self._meta_to_record(meta)

    def is_cancel_requested(self, task_id: str) -> bool:
        with FileLock(str(self._lock_path(task_id))):
            meta = self._read_meta_unlocked(task_id)
        return bool(meta and meta.get("cancel_requested"))

    def update_task(
        self,
        task_id: str,
        *,
        status: TaskStatus | None = None,
        progress: int | None = None,
        stage: str | None = None,
        error: str | None = None,
        finished_at: float | None = None,
        clear_error: bool = False,
    ) -> TaskRecord | None:
        with FileLock(str(self._lock_path(task_id))):
            meta = self._read_meta_unlocked(task_id)
            if not meta:
                return None
            if status is not None:
                meta["status"] = status
            if progress is not None:
                meta["progress"] = progress
            if stage is not None:
                meta["stage"] = stage
            if clear_error:
                meta["error"] = None
            elif error is not None:
                meta["error"] = error
            if finished_at is not None:
                meta["finished_at"] = finished_at
            meta["updated_at"] = _utc_now()
            self._write_meta_unlocked(task_id, meta)
            return self._meta_to_record(meta)

    def append_event(self, task_id: str, event_line: str) -> int:
        return self.append_events_batch(task_id, [event_line])

    def append_events_batch(self, task_id: str, event_lines: list[str]) -> int:
        if not event_lines:
            return 0
        events_path = self._events_path(task_id)
        events_path.parent.mkdir(parents=True, exist_ok=True)
        with FileLock(str(self._lock_path(task_id))):
            with open(events_path, "a", encoding="utf-8") as f:
                for line in event_lines:
                    f.write(line if line.endswith("\n") else f"{line}\n")
            meta = self._read_meta_unlocked(task_id)
            if not meta:
                return 0
            meta["event_count"] = int(meta.get("event_count") or 0) + len(event_lines)
            meta["updated_at"] = _utc_now()
            self._write_meta_unlocked(task_id, meta)
            return int(meta["event_count"])

    def list_events(self, task_id: str, since: int = 0) -> list[str]:
        """按「事件序号」返回 ``seq >= since`` 的事件（空行不计数）。

        每事件占两物理行（``data: …\n\n``）；遍历全文件，按非空行计数事件索引，
        避免空行参与序号导致重复返回。采用简单顺序读而非 seek，因为 Python
        text-mode ``tell()`` 返回不透明值、二次 seek 不可靠。
        """
        path = self._events_path(task_id)
        if not path.is_file():
            return []

        event_idx = 0
        out: list[str] = []
        with open(path, encoding="utf-8") as f:
            for raw in f:
                line = raw.rstrip("\n")
                if not line:
                    continue
                if event_idx >= since:
                    out.append(line if line.endswith("\n\n") else f"{line}\n\n")
                event_idx += 1
        return out

    def requeue_stale_running(self, updated_before_epoch: float) -> list[str]:
        requeued: list[str] = []
        if not self.root.is_dir():
            return requeued
        for child in self.root.iterdir():
            if not child.is_dir():
                continue
            task_id = child.name
            with FileLock(str(self._lock_path(task_id))):
                meta = self._read_meta_unlocked(task_id)
                if not meta or meta.get("status") != "running":
                    continue
                if meta.get("cancel_requested"):
                    continue
                ts = _iso_to_epoch(meta.get("updated_at"))
                if ts is None or ts >= updated_before_epoch:
                    continue
                meta["status"] = "pending"
                meta["worker_id"] = None
                meta["updated_at"] = _utc_now()
                self._write_meta_unlocked(task_id, meta)
                requeued.append(task_id)
        return requeued


class TursoTaskStore(TaskStore):
    def __init__(self) -> None:
        from app.storage.turso_db import apply_migrations
        from app.storage.turso_http import get_connection

        apply_migrations()
        self._conn = get_connection()
        self._own_conn = True

    def close(self) -> None:
        if self._own_conn:
            self._conn.close()

    def _row_to_record(self, row: tuple[Any, ...]) -> TaskRecord:
        (
            tid,
            session_id,
            message,
            fetch_urls_json,
            _literature_source_mode,
            status,
            progress,
            stage,
            error,
            cancel_requested,
            worker_id,
            started_at,
            finished_at,
            _updated_at,
        ) = row
        try:
            fetch_urls = json.loads(fetch_urls_json or "[]")
        except json.JSONDecodeError:
            fetch_urls = []
        return TaskRecord(
            id=str(tid),
            session_id=str(session_id),
            message=str(message),
            fetch_urls=[str(u) for u in fetch_urls] if isinstance(fetch_urls, list) else [],
            status=status,
            progress=int(progress or 0),
            stage=str(stage or "starting"),
            error=str(error) if error else None,
            cancel_requested=bool(cancel_requested),
            worker_id=str(worker_id) if worker_id else None,
            started_at=_iso_to_epoch(str(started_at)) or 0.0,
            finished_at=_iso_to_epoch(str(finished_at)) if finished_at else None,
            event_count=0,
            updated_at=_iso_to_epoch(str(_updated_at)) or 0.0,
        )

    def _load_record(self, task_id: str) -> TaskRecord | None:
        row = self._conn.execute(
            """
            SELECT id, session_id, message, fetch_urls_json, literature_source_mode,
                   status, progress, stage, error, cancel_requested, worker_id,
                   started_at, finished_at, updated_at
            FROM literature_tasks
            WHERE id = ?
            """,
            (task_id,),
        ).fetchone()
        if not row:
            return None
        record = self._row_to_record(row)
        count_row = self._conn.execute(
            "SELECT COUNT(*) FROM literature_task_events WHERE task_id = ?",
            (task_id,),
        ).fetchone()
        record.event_count = int(count_row[0] if count_row else 0)
        return record

    def create_task(
        self,
        *,
        session_id: str,
        message: str,
        fetch_urls: list[str] | None = None,
        task_id: str | None = None,
    ) -> TaskRecord:
        tid = task_id or uuid.uuid4().hex
        now = _utc_now()
        self._conn.execute(
            """
            INSERT INTO literature_tasks (
                id, session_id, message, fetch_urls_json,
                status, progress, stage, error, cancel_requested, worker_id,
                started_at, finished_at, updated_at
            ) VALUES (?, ?, ?, ?, 'pending', 0, 'starting', NULL, 0, NULL, ?, NULL, ?)
            """,
            (
                tid,
                session_id,
                message,
                json.dumps(list(fetch_urls or []), ensure_ascii=False),
                now,
                now,
            ),
        )
        record = self._load_record(tid)
        assert record is not None
        return record

    def get_task(self, task_id: str) -> TaskRecord | None:
        return self._load_record(task_id)

    def list_active_tasks(self) -> list[TaskRecord]:
        rows = self._conn.execute(
            """
            SELECT id, session_id, message, fetch_urls_json, literature_source_mode,
                   status, progress, stage, error, cancel_requested, worker_id,
                   started_at, finished_at, updated_at
            FROM literature_tasks
            WHERE status IN ('pending', 'running')
            ORDER BY updated_at DESC
            """
        ).fetchall()
        out: list[TaskRecord] = []
        for row in rows:
            record = self._row_to_record(row)
            count_row = self._conn.execute(
                "SELECT COUNT(*) FROM literature_task_events WHERE task_id = ?",
                (record.id,),
            ).fetchone()
            record.event_count = int(count_row[0] if count_row else 0)
            out.append(record)
        return out

    def try_claim(self, task_id: str, worker_id: str) -> bool:
        now = _utc_now()
        self._conn.execute(
            """
            UPDATE literature_tasks
            SET status = 'running', worker_id = ?, updated_at = ?
            WHERE id = ? AND status = 'pending'
            """,
            (worker_id, now, task_id),
        )
        row = self._conn.execute(
            "SELECT status, worker_id FROM literature_tasks WHERE id = ?",
            (task_id,),
        ).fetchone()
        return bool(row and row[0] == "running" and row[1] == worker_id)

    def request_cancel(self, task_id: str) -> TaskRecord | None:
        now = _utc_now()
        self._conn.execute(
            """
            UPDATE literature_tasks
            SET cancel_requested = 1,
                status = CASE WHEN status = 'pending' THEN 'cancelled' ELSE status END,
                finished_at = CASE WHEN status = 'pending' THEN ? ELSE finished_at END,
                updated_at = ?
            WHERE id = ?
            """,
            (now, now, task_id),
        )
        return self.get_task(task_id)

    def is_cancel_requested(self, task_id: str) -> bool:
        row = self._conn.execute(
            "SELECT cancel_requested FROM literature_tasks WHERE id = ?",
            (task_id,),
        ).fetchone()
        return bool(row and row[0])

    def update_task(
        self,
        task_id: str,
        *,
        status: TaskStatus | None = None,
        progress: int | None = None,
        stage: str | None = None,
        error: str | None = None,
        finished_at: float | None = None,
        clear_error: bool = False,
    ) -> TaskRecord | None:
        fields: list[str] = ["updated_at = ?"]
        params: list[Any] = [_utc_now()]
        if status is not None:
            fields.append("status = ?")
            params.append(status)
        if progress is not None:
            fields.append("progress = ?")
            params.append(progress)
        if stage is not None:
            fields.append("stage = ?")
            params.append(stage)
        if clear_error:
            fields.append("error = NULL")
        elif error is not None:
            fields.append("error = ?")
            params.append(error)
        if finished_at is not None:
            fields.append("finished_at = ?")
            params.append(
                datetime.fromtimestamp(finished_at, tz=timezone.utc).isoformat()
            )
        params.append(task_id)
        self._conn.execute(
            f"UPDATE literature_tasks SET {', '.join(fields)} WHERE id = ?",
            tuple(params),
        )
        return self.get_task(task_id)

    def append_event(self, task_id: str, event_line: str) -> int:
        return self.append_events_batch(task_id, [event_line])

    def append_events_batch(self, task_id: str, event_lines: list[str]) -> int:
        if not event_lines:
            return 0
        now = _utc_now()
        row = self._conn.execute(
            "SELECT COALESCE(MAX(seq), 0) FROM literature_task_events WHERE task_id = ?",
            (task_id,),
        ).fetchone()
        base = int(row[0] if row else 0)
        rows = [
            (task_id, base + i + 1, line.rstrip("\n"), now)
            for i, line in enumerate(event_lines)
        ]
        self._conn.executemany(
            """
            INSERT INTO literature_task_events (task_id, seq, event_line, created_at)
            VALUES (?, ?, ?, ?)
            """,
            rows,
        )
        self._conn.execute(
            "UPDATE literature_tasks SET updated_at = ? WHERE id = ?",
            (now, task_id),
        )
        return base + len(event_lines)

    def list_events(self, task_id: str, since: int = 0) -> list[str]:
        rows = self._conn.execute(
            """
            SELECT event_line FROM literature_task_events
            WHERE task_id = ? AND seq > ?
            ORDER BY seq ASC
            """,
            (task_id, since),
        ).fetchall()
        out: list[str] = []
        for (line,) in rows:
            text = str(line or "")
            out.append(text if text.endswith("\n\n") else f"{text}\n\n")
        return out

    def requeue_stale_running(self, updated_before_epoch: float) -> list[str]:
        cutoff = datetime.fromtimestamp(updated_before_epoch, tz=timezone.utc).isoformat()
        rows = self._conn.execute(
            """
            SELECT id FROM literature_tasks
            WHERE status = 'running'
              AND cancel_requested = 0
              AND updated_at < ?
            """,
            (cutoff,),
        ).fetchall()
        requeued: list[str] = []
        now = _utc_now()
        for (task_id,) in rows:
            self._conn.execute(
                """
                UPDATE literature_tasks
                SET status = 'pending', worker_id = NULL, updated_at = ?
                WHERE id = ? AND status = 'running' AND cancel_requested = 0
                """,
                (now, str(task_id)),
            )
            row = self._conn.execute(
                "SELECT status FROM literature_tasks WHERE id = ?",
                (str(task_id),),
            ).fetchone()
            if row and row[0] == "pending":
                requeued.append(str(task_id))
        return requeued


_task_store: TaskStore | None = None
_worker_id: str | None = None


def get_worker_id() -> str:
    global _worker_id
    if _worker_id is None:
        _worker_id = current_worker_id()
    return _worker_id


def get_task_store() -> TaskStore:
    global _task_store
    if _task_store is not None:
        return _task_store

    from app.storage.backend import storage_backend_name
    from app.storage.turso_db import turso_configured

    backend = storage_backend_name()
    if backend in ("turso", "hybrid") and turso_configured():
        _task_store = TursoTaskStore()
    else:
        _task_store = FileTaskStore()
    return _task_store


def reset_task_store_for_tests(store: TaskStore | None = None) -> None:
    global _task_store, _worker_id
    _task_store = store
    _worker_id = None
