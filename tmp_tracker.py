"""Client for the /tmp watcher (tmp_watch.py).

The watcher is a separate process because fanotify needs CAP_SYS_ADMIN, which the
envoy server does not have. It tracks which files in /tmp were created by which
session, and answers two questions envoy cares about:

    files <sid>    which /tmp paths did this session create?
    delete <sid>   remove them (used at session teardown)

Everything here is best-effort. If the watcher is not running, envoy behaves
exactly as it did before: sessions still work, they just leave their /tmp files
behind. Failures are reported once, not per session, so a missing watcher cannot
flood the log.
"""

from __future__ import annotations

import json
import os
import socket
import sys
import threading

DEFAULT_SOCKET = "/run/envoy-tmpwatch/sock"
SOCKET_PATH = os.environ.get("ENVOY_TMPWATCH_SOCK", DEFAULT_SOCKET)
TIMEOUT_SECONDS = float(os.environ.get("ENVOY_TMPWATCH_TIMEOUT", "10"))
# Set ENVOY_TMPWATCH=0 to disable teardown deletion entirely.
ENABLED = os.environ.get("ENVOY_TMPWATCH", "1").strip().lower() not in ("0", "false", "no", "off")


class TmpTracker:
    """Thread-safe client for the watcher's newline-delimited UNIX socket."""

    def __init__(self, path: str = SOCKET_PATH, enabled: bool = ENABLED,
                 timeout: float = TIMEOUT_SECONDS):
        self.path = path
        self.enabled = enabled
        self.timeout = timeout
        self._lock = threading.Lock()
        self._warned = False

    def _call(self, request: str) -> object | None:
        """Send one request and parse its JSON reply. Never raises.

        Returns None when the watcher is unreachable or answers something
        unintelligible; callers treat that as "no information"."""
        if not self.enabled:
            return None
        with self._lock:
            try:
                sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                try:
                    sock.settimeout(self.timeout)
                    sock.connect(self.path)
                    sock.sendall(request.encode() + b"\n")
                    buf = b""
                    while b"\n" not in buf:
                        chunk = sock.recv(65536)
                        if not chunk:
                            break
                        buf += chunk
                finally:
                    sock.close()
            except OSError as exc:
                self._warn_once(f"unavailable at {self.path}: {exc}")
                return None
            except Exception as exc:  # defensive: never let tracking break a session
                self._warn_once(f"failed: {exc}")
                return None
            if not buf.strip():
                return None
            try:
                return json.loads(buf.split(b"\n", 1)[0].decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                self._warn_once("sent a malformed reply")
                return None

    def _warn_once(self, message: str) -> None:
        if not self._warned:
            self._warned = True
            print(f"envoy: tmp watcher {message}", file=sys.stderr)

    def available(self) -> bool:
        return isinstance(self._call("stats"), dict)

    def files(self, sid: str) -> list[str]:
        """The /tmp paths this session created, as far as the watcher saw them."""
        result = self._call(f"files {sid}")
        return [str(p) for p in result] if isinstance(result, list) else []

    def delete_session(self, sid: str) -> dict[str, list]:
        """Delete the session's /tmp files. Directories it created are removed
        once empty; anything it did not create is left alone."""
        result = self._call(f"delete {sid}")
        if not isinstance(result, dict):
            return {"removed": [], "failed": []}
        return {"removed": list(result.get("removed") or []),
                "failed": list(result.get("failed") or [])}

    def sweep(self) -> dict[str, object]:
        """Delete files belonging to sessions that no longer exist."""
        result = self._call("sweep")
        return result if isinstance(result, dict) else {}
