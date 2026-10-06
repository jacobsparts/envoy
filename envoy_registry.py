"""SQLite discovery registry for envoy per-session workers.

The web process is not the owner of a terminal session: the worker process is.
This module is the only shared state between the two, so it is deliberately
small and dumb: it records where a live worker's sockets are and enough
metadata to rebuild the web-side session object after a restart.

Runtime files live under a private per-user directory (0700) so only the
service user can connect to the worker sockets.
"""

from __future__ import annotations

import fcntl
import json
import os
import re
import shutil
import socket
import sqlite3
import stat
import threading
import time
from pathlib import Path

_SAFE_SID = re.compile(r"^[0-9a-f]{8}$")
SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
    sid             TEXT PRIMARY KEY,
    path            TEXT NOT NULL,
    cmd             TEXT NOT NULL,
    cwd             TEXT NOT NULL,
    login           INTEGER NOT NULL DEFAULT 0,
    extra_env       TEXT NOT NULL DEFAULT '{}',
    prompt_sentinel TEXT NOT NULL DEFAULT '',
    socket_dir      TEXT NOT NULL,
    worker_pid      INTEGER NOT NULL,
    scope           TEXT NOT NULL,
    title           TEXT NOT NULL DEFAULT '',
    cols            INTEGER NOT NULL DEFAULT 80,
    rows            INTEGER NOT NULL DEFAULT 24,
    created_at      REAL NOT NULL
);
"""


def runtime_dir() -> Path:
    """Private directory holding the registry database and worker sockets."""
    configured = os.environ.get("ENVOY_RUNTIME_DIR", "").strip()
    if configured:
        return Path(configured)
    xdg = os.environ.get("XDG_RUNTIME_DIR", "").strip()
    if xdg:
        return Path(xdg) / "envoy"
    return Path(f"/tmp/envoy-{os.getuid()}")


def ensure_private_dir(path: Path) -> Path:
    """Create `path` (and parents) with 0700 permissions and verify ownership."""
    path.mkdir(parents=True, exist_ok=True)
    info = path.stat()
    if info.st_uid != os.getuid():
        raise RuntimeError(f"{path} is not owned by uid {os.getuid()}")
    if stat.S_IMODE(info.st_mode) & 0o077:
        os.chmod(path, 0o700)
    return path


def sockets_root() -> Path:
    return ensure_private_dir(runtime_dir() / "sockets")


def socket_dir(sid: str) -> Path:
    if not _SAFE_SID.fullmatch(sid):
        raise ValueError("Invalid session ID")
    return sockets_root() / sid


def socket_paths(sid: str) -> dict[str, str]:
    directory = socket_dir(sid)
    return {name: str(directory / f"{name}.sock") for name in ("control", "input", "output")}


def remove_socket_dir(sid: str) -> None:
    shutil.rmtree(socket_dir(sid), ignore_errors=True)


def connect(path: str, timeout: float) -> socket.socket:
    """Connect to a worker socket, failing clearly if the worker is gone."""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.settimeout(timeout)
    try:
        sock.connect(path)
    except OSError:
        sock.close()
        raise
    sock.settimeout(None)
    return sock


def web_lock_path() -> Path:
    return ensure_private_dir(runtime_dir()) / "web.lock"


def acquire_web_lock(timeout: float = 15.0, poll: float = 0.2):
    """Take the single-web-process lock for this runtime directory.

    Session workers are adopted by exactly one web process, and startup also
    sweeps scopes that no registry row claims. If two web processes did that at
    the same time, each could stop scopes the other had just launched, so the
    lock makes "one web process per runtime directory" an explicit invariant
    instead of an assumption.

    The wait covers a restart: the outgoing process keeps the lock until it
    exits. The returned handle must stay referenced for the process lifetime;
    the kernel releases the lock if the process dies.
    """
    handle = open(web_lock_path(), "a+")
    deadline = time.monotonic() + max(0.0, timeout)
    while True:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return handle
        except OSError:
            if time.monotonic() >= deadline:
                handle.close()
                raise RuntimeError(
                    f"another envoy web process already owns {web_lock_path()}"
                )
            time.sleep(poll)


class Registry:
    """Thread-safe SQLite view of live worker sessions."""

    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path else ensure_private_dir(runtime_dir()) / "registry.db"
        self._lock = threading.Lock()
        self._conn = sqlite3.connect(str(self.path), check_same_thread=False, timeout=10)
        self._conn.row_factory = sqlite3.Row
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.execute("PRAGMA busy_timeout=10000")
        with self._conn:
            self._conn.executescript(SCHEMA)
            row = self._conn.execute("SELECT value FROM meta WHERE key='schema'").fetchone()
            if row is None:
                self._conn.execute(
                    "INSERT INTO meta (key, value) VALUES ('schema', ?)", (str(SCHEMA_VERSION),)
                )
            elif int(row["value"]) != SCHEMA_VERSION:
                raise RuntimeError(
                    f"envoy registry schema {row['value']} != expected {SCHEMA_VERSION}; "
                    f"remove {self.path} and stop any live sessions"
                )
            self._conn.execute(
                "INSERT INTO meta (key, value) VALUES ('web_pid', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(os.getpid()),),
            )
        os.chmod(self.path, 0o600)

    def register(self, row: dict[str, object]) -> None:
        values = {
            "sid": str(row["sid"]),
            "path": str(row["path"]),
            "cmd": json.dumps(list(row["cmd"]), separators=(",", ":")),
            "cwd": str(row["cwd"]),
            "login": 1 if row.get("login") else 0,
            "extra_env": json.dumps(dict(row.get("extra_env") or {}), separators=(",", ":")),
            "prompt_sentinel": str(row.get("prompt_sentinel") or ""),
            "socket_dir": str(row["socket_dir"]),
            "worker_pid": int(row["worker_pid"]),
            "scope": str(row["scope"]),
            "title": str(row.get("title") or ""),
            "cols": int(row.get("cols") or 80),
            "rows": int(row.get("rows") or 24),
            "created_at": float(row.get("created_at") or time.time()),
        }
        with self._lock, self._conn:
            self._conn.execute(
                """
                INSERT INTO sessions (sid, path, cmd, cwd, login, extra_env, prompt_sentinel,
                                      socket_dir, worker_pid, scope, title, cols, rows, created_at)
                VALUES (:sid, :path, :cmd, :cwd, :login, :extra_env, :prompt_sentinel,
                        :socket_dir, :worker_pid, :scope, :title, :cols, :rows, :created_at)
                ON CONFLICT(sid) DO UPDATE SET
                    path=excluded.path, cmd=excluded.cmd, cwd=excluded.cwd, login=excluded.login,
                    extra_env=excluded.extra_env, prompt_sentinel=excluded.prompt_sentinel,
                    socket_dir=excluded.socket_dir, worker_pid=excluded.worker_pid,
                    scope=excluded.scope, cols=excluded.cols, rows=excluded.rows
                """,
                values,
            )

    def update(self, sid: str, **fields: object) -> None:
        allowed = {"title", "cols", "rows", "worker_pid"}
        changes = {key: value for key, value in fields.items() if key in allowed}
        if not changes:
            return
        assignments = ", ".join(f"{key}=?" for key in changes)
        with self._lock, self._conn:
            self._conn.execute(
                f"UPDATE sessions SET {assignments} WHERE sid=?",
                (*changes.values(), sid),
            )

    def remove(self, sid: str) -> None:
        with self._lock, self._conn:
            self._conn.execute("DELETE FROM sessions WHERE sid=?", (sid,))

    def rows(self) -> list[dict[str, object]]:
        with self._lock:
            records = self._conn.execute("SELECT * FROM sessions ORDER BY created_at").fetchall()
        return [{
            "sid": record["sid"],
            "path": record["path"],
            "cmd": json.loads(record["cmd"]),
            "cwd": record["cwd"],
            "login": bool(record["login"]),
            "extra_env": json.loads(record["extra_env"]),
            "prompt_sentinel": record["prompt_sentinel"],
            "socket_dir": record["socket_dir"],
            "worker_pid": record["worker_pid"],
            "scope": record["scope"],
            "title": record["title"],
            "cols": record["cols"],
            "rows": record["rows"],
            "created_at": record["created_at"],
        } for record in records]

    def web_pid(self) -> int | None:
        """PID of the web process that last opened this registry."""
        with self._lock:
            record = self._conn.execute("SELECT value FROM meta WHERE key='web_pid'").fetchone()
        try:
            return int(record["value"]) if record is not None else None
        except (TypeError, ValueError):
            return None

    def get(self, sid: str) -> dict[str, object] | None:
        with self._lock:
            record = self._conn.execute("SELECT * FROM sessions WHERE sid=?", (sid,)).fetchone()
        if record is None:
            return None
        return {
            "sid": record["sid"],
            "path": record["path"],
            "cmd": json.loads(record["cmd"]),
            "cwd": record["cwd"],
            "login": bool(record["login"]),
            "extra_env": json.loads(record["extra_env"]),
            "prompt_sentinel": record["prompt_sentinel"],
            "socket_dir": record["socket_dir"],
            "worker_pid": record["worker_pid"],
            "scope": record["scope"],
            "title": record["title"],
            "cols": record["cols"],
            "rows": record["rows"],
            "created_at": record["created_at"],
        }

    def close(self) -> None:
        with self._lock:
            self._conn.close()
