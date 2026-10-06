"""Runtime core for the envoy server."""

from __future__ import annotations

import base64
import collections
import copy
import hashlib
import json
import mimetypes
import socket
import fcntl
import os
import pty
import re
import signal
import secrets
import shlex
import shutil
import struct
import subprocess
import sys
import termios
import threading
import time
from collections.abc import Callable
from pathlib import Path

import pyte

# Push callbacks are notified about one client. `payload` is None for a plain
# wakeup (the stream pulls its own delivery) and carries an explicit frame for
# notices that do not come from the client's output buffer, such as eviction
# and session shutdown.
PushCallback = Callable[[str, dict[str, object] | None], None]

from cgroup_manager import SystemdScopeManager, sid_from_unit
from tmp_tracker import TmpTracker
from envoy_registry import (
    Registry,
    acquire_web_lock,
    connect as registry_connect,
    remove_socket_dir,
    socket_dir as registry_socket_dir,
    socket_paths as registry_socket_paths,
)
from env_config import get_env_settings, save_env_settings
from speech import synthesize_speech
from terminal_session import SessionTerminal
from agent import AgentMaxTurnsError
from voice_chat import CancelledError, process_text_message, process_voice_message, transcribe_audio


APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
APP_TEMPLATE = STATIC_DIR / "app.html"
HOME_DIR = os.path.expanduser("~")

def _web_head_extra(static: str) -> str:
    return (
        '<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">\n'
        '<meta name="color-scheme" content="dark">\n'
        '<meta name="mobile-web-app-capable" content="yes">\n'
        '<meta name="apple-mobile-web-app-capable" content="yes">\n'
        '<meta name="apple-mobile-web-app-status-bar-style" content="black">\n'
        '<meta name="apple-mobile-web-app-title" content="envoy">\n'
        f'<link rel="icon" href="{static}icon.svg" type="image/svg+xml">\n'
        f'<link rel="icon" href="{static}icon-192.png" type="image/png" sizes="192x192">\n'
        f'<link rel="apple-touch-icon" href="{static}icon-192.png">\n'
        f'<link rel="manifest" href="{static}manifest.json">'
    )


def render_html(web_prefix: str = "") -> str:
    template = APP_TEMPLATE.read_text()
    static = f"{web_prefix}/static/"
    head_extra = _web_head_extra(static)
    body_extra = (
        "<script>\n"
        "if ('serviceWorker' in navigator && window.isSecureContext) {\n"
        f"  navigator.serviceWorker.register('{static}sw.js', {{ scope: '{web_prefix}/' }});\n"
        "}\n"
        "</script>"
    )
    return (template
            .replace("{{STATIC}}", static)
            .replace("{{WEB_HEAD_EXTRA}}", head_extra)
            .replace("{{WEB_BODY_EXTRA}}", body_extra))

UPLOAD_DIR = os.path.join(APP_DIR, ".envoy_uploads")
ALIASES_FILE = os.path.join(APP_DIR, "aliases.conf")
SCROLLBACK_BUFFER_SIZE = 100_000
MAX_CLIENT_OUTPUT_BUFFER = 4 * 1024 * 1024
# Clients that have not attached a push callback yet (still replaying the
# snapshot) get a much larger allowance so slow mobile reconnects are not
# evicted while nobody is draining their buffer.
PRE_ATTACH_CLIENT_OUTPUT_BUFFER = 100 * 1024 * 1024
TERMINAL_SETTLE_SECONDS = 0.75
TERMINAL_POLL_SECONDS = 0.1
DEFAULT_WAIT_FOR_SETTLE = TERMINAL_SETTLE_SECONDS
AGENT_DUPLICATE_REQUEST_WINDOW_SECONDS = 15.0
LIVE_PYTE_HISTORY_LINES = 1000
ARCHIVE_HISTORY_LINES = 10_000
ARCHIVE_PYTE_HISTORY_LINES = 1000

# Worker -> web output framing.
#
# Every chunk of PTY output the worker sends is prefixed by the absolute offset
# of its first byte in the session's output stream. A web process that reconnects
# repaints from a snapshot captured at some offset T, and every live byte below T
# is exactly a byte that repaint already contains. Carrying the offset is what
# lets a client drop those instead of rendering them twice, so a reconnect is
# exactly-once for the bytes the repaint covers rather than at-least-once.
OUTPUT_FRAME_HEADER = struct.Struct("!QI")


def encode_output_frame(offset: int, data: bytes) -> bytes:
    return OUTPUT_FRAME_HEADER.pack(offset, len(data)) + data



def _login_env() -> dict[str, str]:
    """Build a minimal seed environment like sshd does.

    The login shell will source /etc/profile and ~/.bash_profile to
    build up the full environment from scratch, so we only need to
    provide the essentials here.
    """
    import pwd
    pw = pwd.getpwuid(os.getuid())
    return {
        "HOME": pw.pw_dir,
        "USER": pw.pw_name,
        "LOGNAME": pw.pw_name,
        "SHELL": pw.pw_shell,
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "LANG": os.environ.get("LANG", "en_US.UTF-8"),
    }


def _login_shell() -> str:
    """Return the user's login shell from the passwd database."""
    import pwd
    return pwd.getpwuid(os.getuid()).pw_shell or "/bin/sh"


def sanitize_filename(name: str) -> str:
    name = os.path.basename(name).lstrip(".")
    return name or "upload"


_TEXT_MIME_PREFIXES = ("text/", "application/json", "application/javascript",
                       "application/xml", "application/x-yaml", "application/toml",
                       "application/x-sh", "application/x-python",
                       "application/sql", "application/csv")


def _is_previewable(mime: str) -> bool:
    return mime.startswith("image/") or any(mime.startswith(p) for p in _TEXT_MIME_PREFIXES)


def load_aliases() -> dict[str, str]:
    aliases: dict[str, str] = {}
    if not os.path.isfile(ALIASES_FILE):
        return aliases
    with open(ALIASES_FILE, encoding="utf-8") as handle:
        for raw_line in handle:
            line = raw_line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            path, cmd = line.split("=", 1)
            path = path.strip()
            cmd = cmd.strip()
            if not path.startswith("/"):
                path = "/" + path
            aliases[path] = cmd
    return aliases


def resolve_cli(url_path: str) -> tuple[list[str], str, bool]:
    """Resolve a URL path to (command, working dir, is_login_shell)."""
    path = "/" + url_path.strip("/")

    aliases = load_aliases()
    if path in aliases:
        parts = shlex.split(aliases[path])
        parts[0] = os.path.expanduser(parts[0])
        cmd_path = os.path.realpath(parts[0])
        if not os.path.isfile(cmd_path):
            raise ValueError(f"Alias target not found: {parts[0]}")
        parts[0] = cmd_path
        return parts, os.path.dirname(cmd_path), False

    rel = url_path.strip("/")
    if not rel:
        return [_login_shell()], HOME_DIR, True

    script = os.path.realpath(os.path.join(HOME_DIR, rel))
    if not script.startswith(HOME_DIR + "/"):
        raise ValueError(f"Path escapes home directory: {url_path}")
    if not os.path.isfile(script):
        raise ValueError(f"Not found: {script}")
    return [script], os.path.dirname(script), False


def build_title(path: str) -> str:
    clean = "/" + path.strip("/")
    if clean == "/":
        return socket.gethostname()
    return clean.lstrip("/")


# How many already-committed SSE payloads are retained per client so a
# reconnecting stream can replay anything the previous stream wrote but the
# browser never applied.  A small ring is enough: it only has to survive the
# window in which a write was accepted locally and the connection died.
DELIVERY_REPLAY_MESSAGES = 4
# Cap on the encoded replay ring so a burst of large outputs cannot pin memory.
DELIVERY_REPLAY_BYTES = 4 * 1024 * 1024


class ClientState:
    __slots__ = ("client_id", "role", "output", "events", "promoted", "joined",
                 "pending_resize", "delivering", "seq", "replay", "replay_bytes",
                 "cursor", "applied", "awaiting_snapshot", "exited")

    def __init__(self, client_id: str, role: str):
        self.client_id = client_id
        self.role = role  # "lead" or "follow"
        self.output: bytearray = bytearray()
        self.events: list[dict[str, str]] = []
        self.promoted = False
        self.joined = time.monotonic()
        self.pending_resize: tuple[int, int] | None = None
        # Absolute stream offset where buffered output ends (None until the
        # first byte is buffered), and the offset a snapshot repaint has already
        # delivered. Together they make live output and the repaint meet without
        # a gap and without a duplicate.
        self.cursor: int | None = None
        self.applied: int | None = None
        # A client added just before a snapshot is not allowed to deliver
        # anything yet: until the repaint watermark is known, any byte handed to
        # it might be a byte the repaint also contains.
        self.awaiting_snapshot = False
        self.exited = False
        # Delivery transaction: while a snapshot is in flight, output and
        # events stay in this buffer until the socket write succeeds.
        self.delivering = False
        # Monotonic SSE event id.  Committed events are retained in `replay`
        # so a reconnecting stream can resend the last one or two payloads.
        self.seq = 0
        self.replay: collections.deque[tuple[int, str]] = collections.deque()
        self.replay_bytes = 0

    def take_delivery_payload_locked(self) -> dict[str, object] | None:
        """Snapshot pending output WITHOUT clearing it.

        Returns None when a delivery is already in flight so concurrent
        deliveries cannot interleave snapshots.
        """
        if self.delivering or self.awaiting_snapshot:
            return None
        if not (self.output or self.events or self.promoted or self.pending_resize or self.exited):
            return None
        self.delivering = True
        payload: dict[str, object] = {
            "output": bytes(self.output),
            "events": copy.deepcopy(self.events),
            "promoted": self.promoted,
            "resize": self.pending_resize,
            "exited": self.exited,
        }
        return payload

    def commit_delivery_locked(self, payload: dict[str, object]) -> None:
        """Remove exactly the snapshotted state after a successful write."""
        output = payload["output"]
        assert isinstance(output, bytes)
        del self.output[:len(output)]
        events = payload["events"]
        assert isinstance(events, list)
        del self.events[:len(events)]
        if payload["promoted"]:
            self.promoted = False
        if payload["exited"]:
            self.exited = False
        resize = payload["resize"]
        if resize is not None and self.pending_resize == resize:
            self.pending_resize = None
        self.delivering = False

    def cancel_delivery_locked(self) -> None:
        """Abandon an in-flight delivery; every byte stays buffered."""
        self.delivering = False

    def apply_output_locked(self, data: bytes, offset: int | None) -> None:
        """Append live output, skipping whatever this client already has.

        `offset` is the absolute stream position of ``data[0]`` for worker
        sessions. For the in-process session the stream position is not tracked
        and every byte is appended as before, so those clients behave exactly as
        they used to.
        """
        if not data:
            return
        if offset is None:
            self.output.extend(data)
            return
        floor = self.applied
        if floor is not None and offset < floor:
            skip = floor - offset
            if skip >= len(data):
                return
            data = data[skip:]
            offset = floor
        if self.cursor is None:
            self.cursor = offset
        elif offset < self.cursor:
            # Bytes this client already buffered (or already dropped as covered
            # by its repaint); keep only what reaches past them.
            skip = self.cursor - offset
            if skip >= len(data):
                return
            data = data[skip:]
            offset = self.cursor
        elif offset > self.cursor:
            # A hole cannot happen on an ordered socket, but if the stream ever
            # skipped bytes the buffered tail would be stale: drop it and let the
            # next reconnect repaint instead of delivering output out of order.
            self.output.clear()
            self.cursor = offset
        self.output.extend(data)
        self.cursor += len(data)

    def apply_snapshot_locked(self, offset: int) -> None:
        """Drop buffered output that a snapshot repaint has already delivered."""
        self.applied = offset
        self.awaiting_snapshot = False
        if self.cursor is None:
            return
        base = self.cursor - len(self.output)
        if base >= offset:
            return
        drop = min(offset - base, len(self.output))
        del self.output[:drop]
        if not self.output:
            # Nothing buffered: the next byte this client sees is the first one
            # the repaint did not cover.
            self.cursor = offset


class FlatteningHistoryScreen(pyte.HistoryScreen):
    def __init__(self, columns: int, lines: int, history: int,
                 on_evict: Callable[[object, int], None],
                 on_clear: Callable[[], None]):
        self._on_evict = on_evict
        self._on_clear = on_clear
        self._redraw_pending_home = False
        self._redraw_active = False
        self._redraw_added = 0
        self._redraw_evicted: collections.deque[object] = collections.deque()
        super().__init__(columns, lines, history=history)

    def _commit_redraw_history(self) -> None:
        while self._redraw_evicted:
            self._on_evict(self._redraw_evicted.popleft(), self.columns)
        self._redraw_active = False
        self._redraw_added = 0

    def discard_pending_redraw_history(self) -> None:
        for _ in range(min(self._redraw_added, len(self.history.top))):
            self.history.top.pop()
        while self._redraw_evicted:
            self.history.top.appendleft(self._redraw_evicted.pop())
        self._redraw_active = False
        self._redraw_added = 0

    def committed_history(self) -> list[object]:
        retained = list(self.history.top)
        if self._redraw_added:
            retained = retained[:-min(self._redraw_added, len(retained))]
        return [*self._redraw_evicted, *retained]

    def erase_in_display(self, how: int = 0, *args: object, **kwargs: object) -> None:
        if how in (2, 3):
            self.discard_pending_redraw_history()
            self._redraw_pending_home = True
        else:
            self._redraw_pending_home = False
            self._commit_redraw_history()
        super().erase_in_display(how, *args, **kwargs)

    def cursor_position(self, line: int | None = None, column: int | None = None) -> None:
        if self._redraw_pending_home and (line in (None, 0, 1)) and (column in (None, 0, 1)):
            self._redraw_pending_home = False
            self._redraw_active = True
            self._redraw_added = 0
            self._redraw_evicted.clear()
        elif self._redraw_pending_home:
            self._redraw_pending_home = False
            self._commit_redraw_history()
        super().cursor_position(line, column)

    def resize(self, lines: int | None = None, columns: int | None = None) -> None:
        self.discard_pending_redraw_history()
        self._redraw_pending_home = False
        super().resize(lines, columns)

    def index(self) -> None:
        bottom = self.margins.bottom if self.margins else self.lines - 1
        if self.cursor.y != bottom:
            super().index()
            return
        if self._redraw_active and self._redraw_added >= max(self.lines * 2, 1):
            self._commit_redraw_history()
        if self._redraw_active:
            if self.history.top.maxlen and len(self.history.top) == self.history.top.maxlen:
                self._redraw_evicted.append(self.history.top.popleft())
            self.history.top.append(self.buffer[self.margins.top if self.margins else 0])
            self._redraw_added += 1
            pyte.Screen.index(self)
            return
        if self.history.top.maxlen and len(self.history.top) == self.history.top.maxlen:
            self._on_evict(self.history.top[0], self.columns)
        super().index()

    def _reset_history(self) -> None:
        self._redraw_pending_home = False
        self._redraw_active = False
        self._redraw_added = 0
        self._redraw_evicted.clear()
        super()._reset_history()
        self._on_clear()


class Session:
    def __init__(self, sid: str, path: str, cmd: list[str], cwd: str, *,
                 login: bool = False, extra_env: dict[str, str] | None = None,
                 prompt_sentinel: str = "",
                 output_callback: Callable[[bytes, int], None] | None = None):
        self.sid = sid
        self.path = path
        self.cmd = list(cmd)
        self.cwd = cwd
        self.title = ""
        self.master, slave = pty.openpty()
        self._prompt_sentinel = prompt_sentinel or f"__ENVOY_PROMPT_{secrets.token_hex(6)}__"
        env = {
            **(extra_env or {}),
            **_login_env(),
            "TERM": "xterm-256color",
            "UPLOAD_DIR": UPLOAD_DIR,
            "ENVOY_PROMPT_SENTINEL": self._prompt_sentinel,
            "PS1": f"{self._prompt_sentinel} ",
        }
        popen_kwargs: dict = dict(
            stdin=slave,
            stdout=slave,
            stderr=slave,
            cwd=cwd,
            start_new_session=True,
            env=env,
        )
        if login:
            # Convention: argv[0] prefixed with '-' tells the shell
            # it is a login shell (same as sshd / getty / login(1)).
            shell_name = os.path.basename(cmd[0])
            popen_kwargs["executable"] = cmd[0]
            cmd = [f"-{shell_name}"] + cmd[1:]
        self.proc = subprocess.Popen(cmd, **popen_kwargs)
        os.close(slave)
        self.scrollback = collections.deque()
        self.scrollback_bytes = 0
        self._output_total_bytes = 0
        self._archive_resize_events: collections.deque[tuple[int, int, int]] = collections.deque()
        self._archive_lines: collections.deque[str] = collections.deque(
            maxlen=ARCHIVE_HISTORY_LINES - ARCHIVE_PYTE_HISTORY_LINES
        )
        self._archive_pyte_screen = FlatteningHistoryScreen(
            80,
            24,
            history=ARCHIVE_PYTE_HISTORY_LINES,
            on_evict=self._flatten_archive_line,
            on_clear=self._archive_lines.clear,
        )
        self._archive_pyte_stream = pyte.Stream(self._archive_pyte_screen)
        self._archive_total_bytes = 0
        self.session_files: list[str] = []
        self.resolved_files: dict[str, dict[str, object]] = {}
        self.alive = True
        self.exit_message = b""
        self.exit_code: int | None = None
        # pyte virtual terminal for agent context
        self._pyte_screen = pyte.HistoryScreen(80, 24, history=LIVE_PYTE_HISTORY_LINES)
        self._pyte_stream = pyte.Stream(self._pyte_screen)
        self._pyte_known_lines: list[str] = []
        self.voice_cancel: threading.Event | None = None
        self.agent_lock = threading.Lock()
        self.clients: dict[str, ClientState] = {}
        self._push_callbacks: dict[str, PushCallback] = {}
        self.last_seen: float = time.monotonic()
        self._last_output_at: float = self.last_seen
        self._last_input_at: float = self.last_seen
        self._last_agent_request: tuple[str, float] | None = None
        self._lock = threading.Lock()
        self._pending_ready = threading.Condition(self._lock)
        self._output_callback = output_callback
        self._reader = threading.Thread(target=self._read_loop, daemon=True, name=f"pty-{sid}")
        self._reader.start()

    def _collect_push_payloads_locked(self) -> list[tuple[str, PushCallback]]:
        """Return (client_id, callback) pairs that need to be woken.

        The callback carries no payload and removes nothing from the client
        buffer. The stream handler pulls the pending output itself and only
        commits it once the SSE write succeeds, so bytes can never be dropped
        into a dead handler queue.

        A client added moments before its snapshot is skipped: its repaint
        watermark is not known yet, so waking its stream could hand the browser
        bytes the repaint also contains.
        """
        return [
            (client_id, callback)
            for client_id, callback in self._push_callbacks.items()
            if not (cs := self.clients.get(client_id)) or not cs.awaiting_snapshot
        ]

    def _dispatch_push_notifications(self, deliveries: list[tuple[str, PushCallback]]) -> None:
        """Wake push callbacks for clients that have pending data.

        Notification only: nothing is removed from the buffer. The stream
        handler pulls the payload under a delivery transaction and commits it
        only after the SSE write succeeds.
        """
        for client_id, callback in deliveries:
            try:
                callback(client_id, None)
            except Exception:
                pass

    def _dispatch_push_payloads(self, deliveries: list[tuple[str, PushCallback, dict[str, object]]]) -> None:
        """Hand an explicit payload to each callback.

        Used for eviction and shutdown notices, whose frame is not derived from
        the client's own output buffer. Both kinds of notice share one callback
        signature, so a stream never has to guess which one it is receiving.
        """
        for client_id, callback, payload in deliveries:
            try:
                callback(client_id, payload)
            except Exception:
                pass

    def take_delivery(self, client_id: str) -> dict[str, object] | None:
        """Snapshot this client's pending state for a stream write.

        The state is NOT removed: commit_delivery() drops exactly the
        snapshotted prefix once the SSE write has succeeded, and
        cancel_delivery() simply abandons the transaction, leaving every byte
        buffered for the next stream. Returns None when the client is gone or
        a delivery is already in flight.
        """
        with self._lock:
            cs = self.clients.get(client_id)
            if cs is None:
                return None
            payload = cs.take_delivery_payload_locked()
            if payload is None:
                return None
            payload["alive"] = self.alive
            payload["exit_code"] = self.exit_code
            return payload

    def commit_delivery(self, client_id: str, payload: dict[str, object], seq: int, line: str) -> None:
        """Commit a delivered payload and retain it for reconnect replay.

        `seq` is the SSE event id written to the wire and `line` is the exact
        encoded SSE frame, so a reconnecting stream can resend it verbatim if
        the browser never applied it.
        """
        with self._lock:
            cs = self.clients.get(client_id)
            if cs is None:
                return
            cs.commit_delivery_locked(payload)
            cs.seq = seq
            cs.replay.append((seq, line))
            cs.replay_bytes += len(line)
            while (
                len(cs.replay) > DELIVERY_REPLAY_MESSAGES
                or cs.replay_bytes > DELIVERY_REPLAY_BYTES
            ) and len(cs.replay) > 1:
                _, dropped = cs.replay.popleft()
                cs.replay_bytes -= len(dropped)

    def replay_after(self, client_id: str, last_seen_id: int) -> list[tuple[int, str]]:
        """Return retained frames with an id greater than `last_seen_id`."""
        with self._lock:
            cs = self.clients.get(client_id)
            if cs is None:
                return []
            return [(seq, line) for seq, line in cs.replay if seq > last_seen_id]

    def next_delivery_seq(self, client_id: str) -> int:
        with self._lock:
            cs = self.clients.get(client_id)
            return cs.seq + 1 if cs is not None else 0

    def cancel_delivery(self, client_id: str) -> None:
        with self._lock:
            cs = self.clients.get(client_id)
            if cs is not None:
                cs.cancel_delivery_locked()

    def register_push(self, client_id: str, callback: PushCallback) -> dict[str, object] | None:
        """Attach a push notification callback for a client.

        Nothing is drained here: the stream handler pulls the buffered output
        itself under a delivery transaction so a failed write cannot lose it.
        Returns an eviction marker when the client is already gone.
        """
        with self._lock:
            if client_id not in self.clients:
                return {"output": b"", "events": [], "evicted": True, "alive": False, "exit_code": -1}
            self._push_callbacks[client_id] = callback
        try:
            callback(client_id, None)
        except Exception:
            pass
        return None

    def unregister_push(self, client_id: str, callback: PushCallback | None = None) -> None:
        # Compare with ==, not `is`: bound methods are recreated on every
        # attribute access, so identity comparison would rarely match and a
        # stale stream could unregister its successor's callback.
        with self._lock:
            if callback is not None and self._push_callbacks.get(client_id) != callback:
                return
            self._push_callbacks.pop(client_id, None)

    def _append_output(self, data: bytes) -> None:
        self._last_output_at = time.monotonic()
        self.scrollback.append(data)
        self.scrollback_bytes += len(data)
        self._output_total_bytes += len(data)
        self._trim_scrollback_locked()
        evicted_clients = []
        for client_id, cs in list(self.clients.items()):
            cs.output.extend(data)
            limit = PRE_ATTACH_CLIENT_OUTPUT_BUFFER if client_id not in self._push_callbacks else MAX_CLIENT_OUTPUT_BUFFER
            if len(cs.output) > limit:
                evicted_clients.append(client_id)
        for client_id in evicted_clients:
            self.clients.pop(client_id, None)
            self._push_callbacks.pop(client_id, None)
        try:
            self._pyte_stream.feed(data.decode("utf-8", errors="replace"))
        except Exception:
            pass

    def _flatten_archive_line(self, line: object, columns: int) -> None:
        rendered = "".join(
            line[i].data if i in line else " "
            for i in range(columns)
        )
        self._archive_lines.append(rendered.rstrip())

    def _apply_archive_resizes_locked(self) -> None:
        while (
            self._archive_resize_events
            and self._archive_resize_events[0][0] <= self._archive_total_bytes
        ):
            _, cols, rows = self._archive_resize_events.popleft()
            self._archive_pyte_screen.resize(rows, cols)

    def _feed_archive(self, data: bytes) -> None:
        if not data:
            self._apply_archive_resizes_locked()
            return
        offset = 0
        while offset < len(data):
            self._apply_archive_resizes_locked()
            end = len(data)
            if self._archive_resize_events:
                resize_at = self._archive_resize_events[0][0]
                end = min(end, offset + max(0, resize_at - self._archive_total_bytes))
            if end == offset:
                self._apply_archive_resizes_locked()
                continue
            chunk = data[offset:end]
            try:
                self._archive_pyte_stream.feed(chunk.decode("utf-8", errors="replace"))
            except Exception:
                pass
            self._archive_total_bytes += len(chunk)
            offset = end
        self._apply_archive_resizes_locked()

    def _ansi_safe_cut(self, data: bytes, overflow: int) -> int:
        if not data:
            return 0
        target = min(len(data), overflow + 8192)
        for needle in (b"\n", b"\r"):
            idx = data.rfind(needle, 0, target)
            if idx != -1:
                cut = idx + 1
                if self._is_escape_boundary_safe(data, cut):
                    return cut
        hard = overflow
        while hard < len(data) and (data[hard] & 0b1100_0000) == 0b1000_0000:
            hard += 1
        if hard > len(data):
            hard = len(data)
        while hard > overflow and not self._is_escape_boundary_safe(data, hard):
            hard -= 1
        if hard > 0:
            return hard
        return min(len(data), overflow)

    def _is_escape_boundary_safe(self, data: bytes, cut: int) -> bool:
        state = "ground"
        i = 0
        end = min(max(cut, 0), len(data))
        while i < end:
            ch = data[i]
            if state == "ground":
                if ch == 0x1B:
                    state = "esc"
                elif ch == 0x9B:
                    state = "csi"
                elif ch == 0x9D:
                    state = "osc"
                elif ch == 0x90:
                    state = "dcs"
                elif ch == 0x98:
                    state = "sos"
                elif ch == 0x9E:
                    state = "pm"
                elif ch == 0x9F:
                    state = "apc"
            elif state == "esc":
                if ch == ord('['):
                    state = "csi"
                elif ch == ord(']'):
                    state = "osc"
                elif ch == ord('P'):
                    state = "dcs"
                elif ch == ord('X'):
                    state = "sos"
                elif ch == ord('^'):
                    state = "pm"
                elif ch == ord('_'):
                    state = "apc"
                else:
                    state = "ground"
            elif state == "csi":
                if 0x40 <= ch <= 0x7E:
                    state = "ground"
            elif state in {"osc", "dcs", "sos", "pm", "apc"}:
                if ch == 0x07:
                    state = "ground"
                elif ch == 0x1B and i + 1 < end and data[i + 1] == ord("\\"):
                    state = "ground"
                    i += 1
            i += 1
        return state == "ground"

    def _trim_scrollback_locked(self) -> None:
        while self.scrollback_bytes > SCROLLBACK_BUFFER_SIZE and self.scrollback:
            removed = self.scrollback.popleft()
            overflow = self.scrollback_bytes - SCROLLBACK_BUFFER_SIZE
            if overflow <= 0:
                self.scrollback.appendleft(removed)
                return
            if overflow >= len(removed):
                self.scrollback_bytes -= len(removed)
                self._feed_archive(removed)
                continue
            cut = self._ansi_safe_cut(removed, overflow)
            archived = removed[:cut]
            kept = removed[cut:]
            self.scrollback_bytes -= len(archived)
            self._feed_archive(archived)
            if kept:
                self.scrollback.appendleft(kept)
            if cut == 0:
                break

    def _read_loop(self) -> None:
        try:
            while True:
                try:
                    data = os.read(self.master, 4096)
                except OSError:
                    break
                if not data:
                    break
                deliveries = []
                with self._lock:
                    offset = self._output_total_bytes
                    self._append_output(data)
                    self._pending_ready.notify_all()
                    deliveries = self._collect_push_payloads_locked()
                self._dispatch_push_notifications(deliveries)
                if self._output_callback is not None:
                    try:
                        self._output_callback(data, offset)
                    except Exception:
                        pass
        finally:
            rc = self.proc.wait()
            self.exit_code = rc
            hide_cursor = "\x1b[?25l"
            if rc in (0, 130):
                message = f"{hide_cursor}\r\n\x1b[90m[process exited]\x1b[0m\r\n"
            elif rc > 0:
                message = f"{hide_cursor}\r\n\x1b[31m[process exited with code {rc}]\x1b[0m\r\n"
            else:
                message = f"{hide_cursor}\r\n\x1b[31m[process killed by signal {-rc}]\x1b[0m\r\n"
            deliveries = []
            with self._lock:
                self.alive = False
                self.exit_message = message.encode("utf-8")
                offset = self._output_total_bytes
                self._append_output(self.exit_message)
                self._pending_ready.notify_all()
                deliveries = self._collect_push_payloads_locked()
            self._dispatch_push_notifications(deliveries)
            if self._output_callback is not None:
                try:
                    self._output_callback(self.exit_message, offset)
                except Exception:
                    pass
            try:
                os.close(self.master)
            except OSError:
                pass

    def get_scrollback(self) -> bytes:
        with self._lock:
            return b"".join(self.scrollback)

    def _render_pyte_screen(self, screen: pyte.HistoryScreen) -> list[str]:
        lines = []
        history = (
            screen.committed_history()
            if isinstance(screen, FlatteningHistoryScreen)
            else screen.history.top
        )
        for hist_line in history:
            cols = screen.columns
            rendered = "".join(
                hist_line[i].data if i in hist_line else " "
                for i in range(cols)
            )
            lines.append(rendered.rstrip())
        for row in screen.display:
            lines.append(row.rstrip())
        while lines and not lines[-1]:
            lines.pop()
        return lines

    def _archived_lines_locked(self) -> list[str]:
        lines = [*self._archive_lines, *self._render_pyte_screen(self._archive_pyte_screen)]
        while lines and not lines[-1]:
            lines.pop()
        return lines

    def get_archived_text(self) -> str:
        with self._lock:
            return "\n".join(self._archived_lines_locked())

    def get_terminal_lines(self) -> list[str]:
        """Return rendered lines from pyte: history + current screen."""
        with self._lock:
            return self._render_pyte_screen(self._pyte_screen)

    def push_agent_event(self, kind: str, text: str) -> None:
        deliveries = []
        with self._lock:
            for cs in self.clients.values():
                cs.events.append({"kind": kind, "text": text})
            self._pending_ready.notify_all()
            deliveries = self._collect_push_payloads_locked()
        self._dispatch_push_notifications(deliveries)

    def add_client(self, client_id: str, role: str,
                   awaiting_snapshot: bool = False) -> ClientState:
        """Add a client under the lock. Caller must hold self._lock.

        `awaiting_snapshot` holds the client's stream back until its snapshot
        watermark is applied: until then it is not known whether the repaint
        already contains a given byte, so nothing may be delivered.
        """
        cs = ClientState(client_id, role)
        cs.awaiting_snapshot = bool(awaiting_snapshot)
        self.clients[client_id] = cs
        self._pending_ready.notify_all()
        return cs

    def remove_client(self, client_id: str) -> str | None:
        """Remove a client. Returns promoted client_id if a follow was promoted, else None."""
        deliveries = []
        with self._lock:
            self._push_callbacks.pop(client_id, None)
            cs = self.clients.pop(client_id, None)
            if not cs:
                return None
            if cs.role == "lead":
                # Promote oldest follow to lead
                oldest: ClientState | None = None
                for c in self.clients.values():
                    if c.role == "follow":
                        if oldest is None or c.joined < oldest.joined:
                            oldest = c
                if oldest:
                    oldest.role = "lead"
                    oldest.promoted = True
                    self._pending_ready.notify_all()
                    deliveries = self._collect_push_payloads_locked()
                    promoted_client_id = oldest.client_id
                else:
                    promoted_client_id = None
            else:
                promoted_client_id = None
        if deliveries:
            self._dispatch_push_notifications(deliveries)
        return promoted_client_id

    def get_lead_client(self) -> ClientState | None:
        """Return the lead client, if any. Caller must hold self._lock or accept races."""
        for cs in self.clients.values():
            if cs.role == "lead":
                return cs
        return None

    def write(self, data: bytes) -> None:
        if self.alive and not getattr(self, "closing", False):
            with self._lock:
                self._last_input_at = time.monotonic()
            os.write(self.master, data)

    def _screen_excerpt_locked(self, lines: list[str], max_lines: int = 20) -> str:
        excerpt = lines[-max_lines:]
        return "\n".join(excerpt)

    def _cursor_line_locked(self, lines: list[str]) -> str:
        row = len(self._pyte_screen.history.top) + self._pyte_screen.cursor.y
        if 0 <= row < len(lines):
            return lines[row]
        return ""

    def _cursor_at_line_end_locked(self, line: str) -> bool:
        col = self._pyte_screen.cursor.x
        return not line[col:].strip()

    def _detect_prompt_locked(self, lines: list[str]) -> tuple[bool, str, str]:
        cursor_line = self._cursor_line_locked(lines)
        if not self._cursor_at_line_end_locked(cursor_line):
            return False, "low", "unknown"
        if self._prompt_sentinel in cursor_line:
            return True, "high", "shell"
        stripped = cursor_line.strip()
        if not stripped:
            return False, "low", "unknown"
        if re.match(r"^(>>>|\.\.\.|In \[\d+\]:) ?$", stripped):
            return True, "high", "python_repl"
        if re.match(r"^\((Pdb|gdb)\) ?$", stripped):
            return True, "high", "debugger"
        if re.match(r"^.{0,200}[#$%>] ?$", stripped):
            return True, "medium", "shell_like"
        if re.match(r"^\(.+\) .{0,200}[#$] ?$", stripped):
            return True, "medium", "shell_like"
        return False, "low", "unknown"

    def _terminal_state_locked(self) -> dict[str, object]:
        now = time.monotonic()
        lines = self._render_pyte_screen(self._pyte_screen)
        prompt_visible, prompt_confidence, prompt_kind = self._detect_prompt_locked(lines)
        last_output_ms_ago = int(max(0.0, now - self._last_output_at) * 1000)
        last_input_ms_ago = int(max(0.0, now - self._last_input_at) * 1000)
        settled = last_output_ms_ago >= int(TERMINAL_SETTLE_SECONDS * 1000)
        input_mode = "unknown"
        if prompt_kind == "shell":
            input_mode = "shell"
        elif prompt_kind in {"python_repl", "debugger"}:
            input_mode = prompt_kind
        elif settled and prompt_visible:
            input_mode = "shell_like"
        elif self.alive and settled:
            input_mode = "interactive"
        interactive_mode = bool(self.alive and input_mode != "shell")
        busy = bool(self.alive and not settled)
        return {
            "busy": busy,
            "prompt_visible": prompt_visible,
            "prompt_confidence": prompt_confidence,
            "prompt_kind": prompt_kind,
            "settled": settled,
            "interactive_mode": interactive_mode,
            "input_mode": input_mode,
            "last_output_ms_ago": last_output_ms_ago,
            "last_input_ms_ago": last_input_ms_ago,
            "screen_excerpt": self._screen_excerpt_locked(lines),
            "cursor_row": self._pyte_screen.cursor.y + 1,
            "cursor_col": self._pyte_screen.cursor.x + 1,
            "alive": self.alive,
            "exit_code": self.exit_code,
        }

    def get_terminal_state(self) -> dict[str, object]:
        with self._lock:
            return self._terminal_state_locked()

    def _prompt_matches_locked(self, expected_prompt: object, state: dict[str, object]) -> bool:
        if expected_prompt is None or expected_prompt is False or expected_prompt == "":
            return True
        if expected_prompt is True:
            return bool(state["prompt_visible"])
        expected = str(expected_prompt)
        lines = self._render_pyte_screen(self._pyte_screen)
        last_nonempty = next((line for line in reversed(lines) if line.strip()), "")
        if expected in last_nonempty:
            return True
        if expected in {"$", "#", "$ or #", "# or $"}:
            return bool(state["prompt_visible"]) and state["prompt_kind"] in {"shell", "shell_like"}
        return False

    def _decode_terminal_input(self, value: str) -> bytes:
        data = bytearray()
        i = 0
        named = {
            "n": b"\n",
            "r": b"\r",
            "t": b"\t",
            "b": b"\b",
            "f": b"\f",
            "v": b"\v",
            "a": b"\a",
            "\\": b"\\",
            '"': b'"',
            "'": b"'",
        }
        while i < len(value):
            ch = value[i]
            if ch != "\\":
                data.extend(ch.encode("utf-8"))
                i += 1
                continue
            if i + 1 >= len(value):
                raise ValueError("Trailing backslash in input")
            esc = value[i + 1]
            if esc in named:
                data.extend(named[esc])
                i += 2
            elif esc == "x":
                hex_digits = value[i + 2:i + 4]
                if len(hex_digits) != 2 or not re.fullmatch(r"[0-9a-fA-F]{2}", hex_digits):
                    raise ValueError("Invalid \\xHH escape in input")
                data.append(int(hex_digits, 16))
                i += 4
            elif esc == "u":
                hex_digits = value[i + 2:i + 6]
                if len(hex_digits) != 4 or not re.fullmatch(r"[0-9a-fA-F]{4}", hex_digits):
                    raise ValueError("Invalid \\uHHHH escape in input")
                data.extend(chr(int(hex_digits, 16)).encode("utf-8"))
                i += 6
            elif esc == "U":
                hex_digits = value[i + 2:i + 10]
                if len(hex_digits) != 8 or not re.fullmatch(r"[0-9a-fA-F]{8}", hex_digits):
                    raise ValueError("Invalid \\UHHHHHHHH escape in input")
                data.extend(chr(int(hex_digits, 16)).encode("utf-8"))
                i += 10
            else:
                raise ValueError(f"Unsupported escape: \\{esc}")
        return bytes(data)

    def _wait_for_state(self, *, seconds: float = 0.0, wait_for_settle: object = DEFAULT_WAIT_FOR_SETTLE,
                        expect_prompt: object = None, timeout: float = 30.0, after_output_at: float | None = None) -> tuple[dict[str, object], bool, int]:

        start = time.monotonic()
        minimum_deadline = start + max(0.0, seconds)
        deadline = start + max(0.0, timeout)
        if wait_for_settle is False or wait_for_settle is None:
            settle_seconds = None
        elif wait_for_settle is True:
            settle_seconds = DEFAULT_WAIT_FOR_SETTLE
        else:
            settle_seconds = max(0.0, float(wait_for_settle))
        with self._lock:
            while True:
                now = time.monotonic()
                state = self._terminal_state_locked()
                minimum_elapsed = now >= minimum_deadline
                saw_post_input_output = after_output_at is None or self._last_output_at >= after_output_at
                output_quiet = (
                    settle_seconds is None
                    or float(state["last_output_ms_ago"]) >= settle_seconds * 1000
                )
                prompt_matched = self._prompt_matches_locked(expect_prompt, state)
                # For terminal input without Enter (typing into an editor, REPL line, or
                # partially composing a shell command), no new prompt is expected.  Waiting
                # for a confirmed prompt here makes the voice/text agent report that it can
                # see the terminal but cannot input.
                prompt_required = not (expect_prompt is None or expect_prompt is False or expect_prompt == "")
                output_observed_or_not_required = saw_post_input_output or not prompt_required
                if minimum_elapsed and output_observed_or_not_required and output_quiet and prompt_matched:
                    return state, False, int((now - start) * 1000)

                if now >= deadline:
                    return state, True, int((now - start) * 1000)
                next_wake = min(deadline, now + TERMINAL_POLL_SECONDS)
                if not minimum_elapsed:
                    next_wake = min(next_wake, minimum_deadline)
                self._pending_ready.wait(max(0.0, next_wake - now))

    def execute_terminal_action(self, action: dict[str, object]) -> dict[str, object]:
        action_type = str(action.get("type") or "").strip()
        wait_for_settle = action.get("wait_for_settle", DEFAULT_WAIT_FOR_SETTLE)
        expect_prompt = action.get("expect_prompt")
        timeout = float(action.get("timeout", 30) or 30)

        if not action_type:
            return {"ok": False, "error": "invalid_action", "message": "Missing action type", "state": self.get_terminal_state()}
        if not self.alive and action_type != "wait":
            return {"type": f"{action_type}_result", "ok": False, "error": "session_not_alive", "state": self.get_terminal_state()}

        initial_state = self.get_terminal_state()
        if action_type == "input":
            if "input" not in action or not isinstance(action.get("input"), str):
                return {"type": "input_result", "ok": False, "error": "invalid_input", "message": "Input action requires an input string", "state": initial_state}
            try:
                data = self._decode_terminal_input(str(action["input"]))
            except ValueError as exc:
                return {"type": "input_result", "ok": False, "error": "invalid_escape", "message": str(exc), "state": initial_state}
            if len(data) > 65536:
                return {"type": "input_result", "ok": False, "error": "input_too_large", "message": "Input exceeds 65536 bytes", "state": initial_state}
            now = time.monotonic()
            input_started_at = now
            effective_expect_prompt = expect_prompt
            if (
                effective_expect_prompt in (None, False, "")
                and data.rstrip().endswith((b"\r", b"\n"))
                and initial_state.get("prompt_visible")
                and initial_state.get("prompt_kind") in {"shell", "shell_like"}
            ):
                effective_expect_prompt = True
            self.write(data)
            state, timed_out, duration_ms = self._wait_for_state(
                wait_for_settle=wait_for_settle,
                expect_prompt=effective_expect_prompt,
                timeout=timeout,
                after_output_at=input_started_at,
            )
            return {
                "type": "input_result",
                "ok": not timed_out,
                "timed_out": timed_out,
                "prompt_seen": bool(state["prompt_visible"]),
                "settled": bool(state["settled"]),
                "duration_ms": duration_ms,
                "output_excerpt": state["screen_excerpt"],
                "state": state,
            }

        if action_type == "wait":
            seconds = float(action.get("seconds", 0) or 0)
            state, timed_out, duration_ms = self._wait_for_state(
                seconds=seconds,
                wait_for_settle=wait_for_settle,
                expect_prompt=expect_prompt,
                timeout=timeout,
            )
            return {
                "type": "wait_result",
                "ok": not timed_out,
                "timed_out": timed_out,
                "duration_ms": duration_ms,
                "prompt_seen": bool(state["prompt_visible"]),
                "settled": bool(state["settled"]),
                "output_excerpt": state["screen_excerpt"],
                "state": state,
            }

        return {
            "ok": False,
            "error": "unsupported_action",
            "message": f"Unsupported action type: {action_type}",
            "state": initial_state,
        }

    def resize(self, cols: int, rows: int) -> None:
        with self._lock:
            if self.alive:
                winsize = struct.pack("HHHH", rows, cols, 0, 0)
                fcntl.ioctl(self.master, termios.TIOCSWINSZ, winsize)
            self._pyte_screen.resize(rows, cols)
            event = (self._output_total_bytes, cols, rows)
            if (
                self._archive_resize_events
                and self._archive_resize_events[-1][0] == self._output_total_bytes
            ):
                self._archive_resize_events[-1] = event
            else:
                self._archive_resize_events.append(event)
            self._apply_archive_resizes_locked()

    def save_upload(self, name: str, content: bytes) -> str:
        os.makedirs(UPLOAD_DIR, exist_ok=True)
        safe_name = sanitize_filename(name)
        path = Path(UPLOAD_DIR) / safe_name
        if path.exists():
            stem = path.stem
            suffix = path.suffix
            counter = 1
            while path.exists():
                path = Path(UPLOAD_DIR) / f"{stem}_{counter}{suffix}"
                counter += 1
        path.write_bytes(content)
        self.session_files.append(str(path))
        self.write(("'" + str(path).replace("'", "'\\''") + "' ").encode("utf-8"))
        return str(path)

    def _proc_cwd(self, pid: int) -> str | None:
        try:
            return os.readlink(f"/proc/{pid}/cwd")
        except OSError:
            return None

    def _foreground_cwds(self) -> list[str]:
        try:
            pgid = os.tcgetpgrp(self.master)
        except OSError:
            return []
        result = []
        proc = Path("/proc")
        if not proc.is_dir():
            return result
        for entry in proc.iterdir():
            if not entry.name.isdigit():
                continue
            try:
                stat = (entry / "stat").read_text()
                fields = stat.rsplit(")", 1)[1].split()
                if len(fields) > 2 and int(fields[2]) == pgid:
                    cwd = self._proc_cwd(int(entry.name))
                    if cwd and cwd not in result:
                        result.append(cwd)
            except (OSError, ValueError):
                continue
        return result

    def _cwd_candidates(self) -> list[str]:
        result = []
        for cwd in [*self._foreground_cwds(), self._proc_cwd(self.proc.pid), self.cwd]:
            if cwd and cwd not in result:
                result.append(cwd)
        return result

    def _relative_file_path(self, path: str) -> str:
        path = os.path.realpath(path)
        candidates = []
        for cwd in self._cwd_candidates():
            try:
                rel = os.path.relpath(path, cwd)
            except ValueError:
                continue
            if rel == ".":
                continue
            candidates.append(rel)
        if not candidates:
            return os.path.basename(path)
        return min(candidates, key=lambda rel: (rel.startswith(".."), len(rel), rel))

    def _file_info(self, raw: str, path: str) -> dict[str, object]:
        mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
        is_image = mime.startswith("image/")
        info = {
            "raw": raw,
            "path": path,
            "relative_path": self._relative_file_path(path),
            "name": os.path.basename(path),
            "mime": mime,
            "size": os.path.getsize(path),
            "is_image": is_image,
            "is_previewable": _is_previewable(mime),
        }
        self.resolved_files[raw] = info
        return info

    def resolve_file(self, raw_path: str) -> dict[str, object] | None:
        raw = raw_path.strip()
        if not raw:
            return None
        if (raw[0:1] == raw[-1:] and raw[0:1] in {"'", '"'}):
            raw = raw[1:-1]
        raw = raw.rstrip(".,;:")
        original = raw
        candidates = []
        if raw.startswith("file://"):
            raw = raw[7:]
        if os.path.isabs(raw):
            candidates.append(raw)
        elif raw.startswith("~/"):
            candidates.append(os.path.expanduser(raw))
        else:
            for cwd in self._cwd_candidates():
                candidates.append(os.path.join(cwd, raw))
        for candidate in candidates:
            path = os.path.realpath(os.path.expanduser(candidate))
            if os.path.isfile(path):
                return self._file_info(original, path)
        return None

    def resolve_files(self, raw_paths: list[str]) -> list[dict[str, object]]:
        results = []
        seen = set()
        for raw in raw_paths:
            if raw in seen:
                continue
            seen.add(raw)
            info = self.resolve_file(raw)
            if info:
                results.append(info)
        return results

    def _terminate_process_tree(self, timeout: float = 2.0) -> None:
        try:
            pgid = os.getpgid(self.proc.pid)
        except OSError:
            pgid = None
        if pgid is not None:
            try:
                os.killpg(pgid, signal.SIGTERM)
            except ProcessLookupError:
                return
            except OSError:
                self.proc.terminate()
        else:
            self.proc.terminate()
        try:
            self.proc.wait(timeout=timeout)
            return
        except subprocess.TimeoutExpired:
            pass
        if pgid is not None:
            try:
                os.killpg(pgid, signal.SIGKILL)
            except ProcessLookupError:
                return
            except OSError:
                self.proc.kill()
        else:
            self.proc.kill()

    def _notify_push_callbacks_closed(self) -> None:
        with self._lock:
            callbacks = list(self._push_callbacks.items())
            self._push_callbacks.clear()
            self.alive = False
            self._pending_ready.notify_all()
            payload = {"output": b"", "events": [], "alive": False, "exit_code": self.exit_code}
            deliveries = [(client_id, callback, payload) for client_id, callback in callbacks]
        self._dispatch_push_payloads(deliveries)

    def cleanup(self) -> None:
        cancel = self.voice_cancel
        if cancel:
            cancel.set()
        self._notify_push_callbacks_closed()
        if self.proc.poll() is None:
            self._terminate_process_tree()
        for path in self.session_files:
            try:
                os.remove(path)
            except OSError:
                pass


REAPER_INTERVAL_SECONDS = 30
class WorkerSession:
    """Web-side handle for one detached PTY worker.

    Two ways in: ``owned`` (this process launched the worker) and ``adopted``
    (the worker was already running and was discovered through the registry,
    typically after a web process restart). Both are identical afterwards:
    the web process is a client of the worker's sockets and holds no PTY.
    """

    def __init__(self, sid: str, path: str, cmd: list[str], cwd: str, *,
                 scope_manager: SystemdScopeManager,
                 tmp_tracker: TmpTracker | None = None,
                 registry: Registry | None = None,
                 login: bool = False, extra_env: dict[str, str] | None = None,
                 prompt_sentinel: str = "",
                 adopted_row: dict[str, object] | None = None,
                 cols: int = 80, rows: int = 24):
        self.sid = sid
        self.path = path
        self.cmd = list(cmd)
        self.cwd = cwd
        self.title = ""
        self.scope_manager = scope_manager
        self.tmp_tracker = tmp_tracker if tmp_tracker is not None else TmpTracker()
        self.registry = registry
        self.scope_name = scope_manager.unit_name(sid)
        self.adopted = adopted_row is not None
        self.closing = False
        self.detached = False
        self.output_disconnected = False
        self.cols, self.rows = cols, rows
        self.cgroup_path = ""
        self.prompt_sentinel = prompt_sentinel or f"__ENVOY_PROMPT_{secrets.token_hex(6)}__"
        self.clients: dict[str, ClientState] = {}
        self._push_callbacks: dict[str, PushCallback] = {}
        self.last_seen: float = time.monotonic()
        self._last_output_at: float = self.last_seen
        self._last_input_at: float = self.last_seen
        self._last_agent_request: tuple[str, float] | None = None
        self._pyte_known_lines: list[str] = []
        self._lock = threading.Lock()
        self._pending_ready = threading.Condition(self._lock)
        self.voice_cancel: threading.Event | None = None
        self.agent_lock = threading.Lock()
        self.alive = True
        self.exit_code: int | None = None
        self._input_write_lock = threading.Lock()
        self._control_lock = threading.Lock()
        self._control_ready = threading.Condition()
        self._exit_status_ready = threading.Event()
        self._pending_control: dict[int, dict[str, object] | None] = {}
        self._next_control_id = 1
        self._cleanup_lock = threading.Lock()
        self._cleanup_state_lock = threading.Lock()
        self._cleanup_force = threading.Event()
        self._cleanup_started = False
        self._cleaned = False

        self._socket_paths = registry_socket_paths(sid)
        if adopted_row is not None:
            self.proc = None
            self.worker_pid = int(adopted_row.get("worker_pid") or 0)
            self.title = str(adopted_row.get("title") or "")
            cols = int(adopted_row.get("cols") or cols)
            rows = int(adopted_row.get("rows") or rows)
            self.cols, self.rows = cols, rows
            self.cgroup_path = scope_manager.verify_scope(sid)
            connections = self._connect_sockets(timeout=5.0)
        else:
            connections = self._spawn_worker(scope_manager, login, extra_env, cols, rows)

        self._control_sock = connections["control"]
        self._input_sock = connections["input"]
        self._output_sock = connections["output"]
        self._control_reader = threading.Thread(target=self._control_loop, daemon=True, name=f"worker-control-{sid}")
        self._output_reader = threading.Thread(target=self._output_loop, daemon=True, name=f"worker-output-{sid}")
        self._control_reader.start()
        self._output_reader.start()
        if adopted_row is not None:
            try:
                self._verify_adopted_worker()
            except Exception:
                self._close_sockets()
                raise

    def _verify_adopted_worker(self) -> None:
        """Confirm the worker we attached to is the one the registry describes.

        Adoption trusts three separate things: the registry row's worker PID, the
        socket directory, and the scope. If they disagree - a recycled PID, a
        stale row, sockets left behind by a session that already exited - adopting
        anyway would attach a client to a terminal that is not the recorded one.
        So ask the worker who it is, and treat any disagreement as "do not adopt".
        """
        resp = self._call_control({"type": "status"}, timeout=10)
        if resp.get("sid") != self.sid:
            raise RuntimeError(
                f"worker at {self._socket_paths['control']} reports session "
                f"{resp.get('sid')!r}, expected {self.sid!r}"
            )
        try:
            live_pid = int(resp.get("pid") or 0)
        except (TypeError, ValueError):
            live_pid = 0
        if live_pid <= 0:
            raise RuntimeError("worker did not report its pid")
        if int(self.worker_pid or 0) != live_pid:
            raise RuntimeError(
                f"registry recorded worker pid {self.worker_pid}, worker reports {live_pid}"
            )
        scope_pid = self.scope_manager.unit_main_pid(self.sid, timeout=5.0)
        if scope_pid is not None and int(scope_pid) != live_pid:
            raise RuntimeError(
                f"scope {self.scope_name} runs pid {scope_pid}, worker reports {live_pid}"
            )
        self.worker_pid = live_pid

    def _connect_sockets(self, timeout: float) -> dict[str, socket.socket]:
        """Connect to the worker's three sockets, retrying until `timeout`.

        A freshly launched scope needs a moment before the worker has bound its
        sockets, so a failed connect is retried rather than treated as fatal.
        """
        deadline = time.monotonic() + timeout
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            try:
                return {name: registry_connect(path, timeout=10.0)
                        for name, path in self._socket_paths.items()}
            except OSError as exc:
                last_error = exc
                time.sleep(0.1)
        raise RuntimeError(f"worker for session {self.sid} did not accept connections: {last_error}")

    def _spawn_worker(self, scope_manager: SystemdScopeManager, login: bool,
                      extra_env: dict[str, str] | None,
                      cols: int, rows: int) -> dict[str, socket.socket]:
        config = {
            "sid": self.sid,
            "path": self.path,
            "cmd": self.cmd,
            "cwd": self.cwd,
            "login": login,
            "extra_env": extra_env or {},
            "prompt_sentinel": self.prompt_sentinel,
        }
        config_b64 = base64.b64encode(json.dumps(config).encode("utf-8")).decode("ascii")
        worker = str(APP_DIR / "pty_worker.py")
        worker_python = str(APP_DIR / ".venv" / "bin" / "python")
        if not os.path.exists(worker_python):
            worker_python = sys.executable
        command = [worker_python, worker, "--socket-dir", str(registry_socket_dir(self.sid)),
                   config_b64]
        # sudo resets the environment, so the variables the worker needs to
        # find its runtime directory are passed explicitly through `env`.
        launch_env = {}
        for name in ("XDG_RUNTIME_DIR", "ENVOY_RUNTIME_DIR"):
            value = os.environ.get(name)
            if value:
                launch_env[name] = value
        if launch_env:
            command = ["env", *[f"{key}={value}" for key, value in launch_env.items()], *command]
        self.proc = subprocess.Popen(
            scope_manager.launch_command(self.sid, command),
            cwd=str(APP_DIR),
            env={**os.environ, "ENVOY_PROMPT_SENTINEL": self.prompt_sentinel},
        )
        try:
            self.cgroup_path = scope_manager.verify_scope(self.sid)
            connections = self._connect_sockets(timeout=20.0)
            # Read the PID only after the worker has accepted a connection: the
            # transient scope reports MainPID=0 until the process registers.
            self.worker_pid = scope_manager.unit_main_pid(self.sid, timeout=5.0) or 0
        except Exception:
            try:
                scope_manager.stop_scope(self.sid)
            except Exception:
                pass
            if self.proc.poll() is None:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait()
            remove_socket_dir(self.sid)
            raise
        self.cols, self.rows = cols, rows
        if self.registry is not None:
            self.registry.register({
                "sid": self.sid,
                "path": self.path,
                "cmd": self.cmd,
                "cwd": self.cwd,
                "login": login,
                "extra_env": extra_env or {},
                "prompt_sentinel": self.prompt_sentinel,
                "socket_dir": str(registry_socket_dir(self.sid)),
                "worker_pid": self.worker_pid,
                "scope": self.scope_name,
                "title": self.title,
                "cols": cols,
                "rows": rows,
            })
        return connections

    def _collect_push_payloads_locked(self) -> list[tuple[str, PushCallback]]:
        return Session._collect_push_payloads_locked(self)

    def _dispatch_push_payloads(self, deliveries: list[tuple[str, PushCallback, dict[str, object]]]) -> None:
        return Session._dispatch_push_payloads(self, deliveries)

    def _dispatch_push_notifications(self, deliveries: list[tuple[str, PushCallback]]) -> None:
        return Session._dispatch_push_notifications(self, deliveries)

    def register_push(self, client_id: str, callback: PushCallback) -> dict[str, object] | None:
        return Session.register_push(self, client_id, callback)

    def take_delivery(self, client_id: str) -> dict[str, object] | None:
        return Session.take_delivery(self, client_id)

    def commit_delivery(self, client_id: str, payload: dict[str, object], seq: int, line: str) -> None:
        return Session.commit_delivery(self, client_id, payload, seq, line)

    def replay_after(self, client_id: str, last_seen_id: int) -> list[tuple[int, str]]:
        return Session.replay_after(self, client_id, last_seen_id)

    def next_delivery_seq(self, client_id: str) -> int:
        return Session.next_delivery_seq(self, client_id)

    def cancel_delivery(self, client_id: str) -> None:
        return Session.cancel_delivery(self, client_id)

    def unregister_push(self, client_id: str, callback: PushCallback | None = None) -> None:
        return Session.unregister_push(self, client_id, callback)

    def add_client(self, client_id: str, role: str,
                   awaiting_snapshot: bool = False) -> ClientState:
        return Session.add_client(self, client_id, role, awaiting_snapshot)

    def remove_client(self, client_id: str) -> str | None:
        return Session.remove_client(self, client_id)

    def get_lead_client(self) -> ClientState | None:
        return Session.get_lead_client(self)

    def push_agent_event(self, kind: str, text: str) -> None:
        return Session.push_agent_event(self, kind, text)

    def _notify_push_callbacks_closed(self) -> None:
        return Session._notify_push_callbacks_closed(self)


    def _append_output(self, data: bytes, offset: int | None = None) -> None:
        self._last_output_at = time.monotonic()
        evicted_clients = []
        for client_id, cs in list(self.clients.items()):
            cs.apply_output_locked(data, offset)
            limit = PRE_ATTACH_CLIENT_OUTPUT_BUFFER if client_id not in self._push_callbacks else MAX_CLIENT_OUTPUT_BUFFER
            if len(cs.output) > limit:
                evicted_clients.append(client_id)
        for client_id in evicted_clients:
            self.clients.pop(client_id, None)
            self._push_callbacks.pop(client_id, None)

    @staticmethod
    def _split_output_frames(buf: bytes) -> tuple[list[tuple[int, bytes]], bytes]:
        """Split worker output into (absolute offset, bytes) frames.

        Returns the complete frames and whatever tail is still incomplete. The
        stream is a byte stream, so a frame can arrive in pieces; the leftover is
        kept for the next read rather than parsed.
        """
        frames: list[tuple[int, bytes]] = []
        view = memoryview(buf)
        pos = 0
        total = len(buf)
        header = OUTPUT_FRAME_HEADER.size
        while total - pos >= header:
            offset, length = OUTPUT_FRAME_HEADER.unpack_from(view, pos)
            end = pos + header + length
            if end > total:
                break
            frames.append((offset, bytes(view[pos + header:end])))
            pos = end
        return frames, bytes(view[pos:])

    def _output_loop(self) -> None:
        """Stream PTY output from the worker.

        Losing this socket does NOT mean the session is over: the worker may
        have dropped a reader that fell too far behind, and the control socket
        is the authoritative liveness channel. Only the control loop (or the
        exit event) marks the session dead.
        """
        pending = b""
        try:
            while True:
                try:
                    data = self._output_sock.recv(65536)
                except OSError:
                    break
                if not data:
                    break
                frames, pending = self._split_output_frames(pending + data)
                if not frames:
                    continue
                with self._lock:
                    for offset, payload in frames:
                        self._append_output(payload, offset)
                    self._pending_ready.notify_all()
                    deliveries = self._collect_push_payloads_locked()
                self._dispatch_push_notifications(deliveries)
        finally:
            if not self.closing and not self.detached:
                print(f"envoy: session {self.sid} output stream disconnected", file=sys.stderr)
            with self._lock:
                self.output_disconnected = True
                self._pending_ready.notify_all()

    def _control_loop(self) -> None:
        try:
            reader = self._control_sock.makefile("rb", buffering=0)
            try:
                for raw in reader:
                    try:
                        msg = json.loads(raw.decode("utf-8"))
                    except Exception:
                        continue
                    req_id = msg.get("id")
                    if req_id is not None:
                        with self._control_ready:
                            self._pending_control[int(req_id)] = msg
                            self._control_ready.notify_all()
                    if msg.get("type") == "exit":
                        with self._lock:
                            self.alive = False
                            self.exit_code = msg.get("exit_code")
                            for cs in self.clients.values():
                                cs.exited = True
                            self._pending_ready.notify_all()
                            deliveries = self._collect_push_payloads_locked()
                        self._dispatch_push_notifications(deliveries)
                        self._exit_status_ready.set()
            except (ConnectionError, OSError):
                pass
        finally:
            self._exit_status_ready.set()
            with self._control_ready:
                for req_id in list(self._pending_control):
                    if self._pending_control[req_id] is None:
                        self._pending_control[req_id] = {"ok": False, "error": "worker disconnected"}
                self._control_ready.notify_all()

    def _call_control(self, msg: dict[str, object], timeout: float = 30.0) -> dict[str, object]:
        with self._control_lock:
            with self._control_ready:
                req_id = self._next_control_id
                self._next_control_id += 1
                self._pending_control[req_id] = None
            msg = dict(msg)
            msg["id"] = req_id
            data = json.dumps(msg, separators=(",", ":")).encode("utf-8") + b"\n"
            self._control_sock.sendall(data)
        deadline = time.monotonic() + timeout
        with self._control_ready:
            while self._pending_control.get(req_id) is None:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    self._pending_control.pop(req_id, None)
                    raise TimeoutError("worker control request timed out")
                self._control_ready.wait(remaining)
            resp = self._pending_control.pop(req_id)
        assert resp is not None
        if not resp.get("ok", False):
            raise ValueError(str(resp.get("error") or "worker control request failed"))
        return resp

    def write(self, data: bytes) -> None:
        if self.alive and not getattr(self, "closing", False) and not self.detached:
            with self._lock:
                self._last_input_at = time.monotonic()
            with self._input_write_lock:
                self._input_sock.sendall(data)

    def resize(self, cols: int, rows: int) -> None:
        self._call_control({"type": "resize", "cols": cols, "rows": rows}, timeout=5)

    def snapshot_response(self, role: str) -> dict[str, object]:
        resp = self._call_control({"type": "snapshot", "role": role, "title": build_title(self.path)}, timeout=30)
        if self.title:
            resp["custom_title"] = self.title
        return {k: v for k, v in resp.items() if k not in {"ok", "type", "id"}}

    def get_scrollback(self) -> bytes:
        resp = self.snapshot_response("lead")
        return base64.b64decode(str(resp.get("output") or "").encode("ascii"))

    def get_archived_text(self) -> str:
        return str(self.snapshot_response("lead").get("archive_text") or "")

    def get_terminal_state(self) -> dict[str, object]:
        resp = self._call_control({"type": "terminal_state"}, timeout=30)
        state = resp.get("state") or {}
        return state if isinstance(state, dict) else {}

    def get_terminal_lines(self) -> list[str]:
        resp = self._call_control({"type": "terminal_lines"}, timeout=30)
        lines = resp.get("lines") or []
        return [str(line) for line in lines] if isinstance(lines, list) else []

    def execute_terminal_action(self, action: dict[str, object]) -> dict[str, object]:
        resp = self._call_control({"type": "execute_action", "action": action}, timeout=float(action.get("timeout", 30) or 30) + 5)
        result = resp.get("result") or {}
        return result if isinstance(result, dict) else {}

    def save_upload(self, name: str, content: bytes) -> str:
        resp = self._call_control({
            "type": "save_upload",
            "name": name,
            "data": base64.b64encode(content).decode("ascii"),
        }, timeout=30)
        return str(resp.get("path") or "")

    def resolve_files(self, paths: list[str]) -> list[dict[str, object]]:
        resp = self._call_control({"type": "resolve_files", "paths": paths}, timeout=30)
        files = resp.get("files") or []
        return files if isinstance(files, list) else []

    def resolve_file(self, path: str) -> dict[str, object] | None:
        resp = self._call_control({"type": "resolve_file", "path": path}, timeout=30)
        info = resp.get("info")
        return info if isinstance(info, dict) else None

    def cleanup(self, force: bool = False) -> None:
        if force:
            self._cleanup_force.set()
        with self._cleanup_lock:
            if self._cleaned:
                return
            self.closing = True
            cancel = self.voice_cancel
            if cancel:
                cancel.set()
            self._notify_push_callbacks_closed()
            if not self._cleanup_force.is_set():
                try:
                    self._call_control({"type": "close"}, timeout=1)
                except Exception:
                    pass
                deadline = time.monotonic() + 5
                while (
                    not self._cleanup_force.is_set()
                    and self.scope_manager.scope_active(self.sid)
                    and time.monotonic() < deadline
                ):
                    time.sleep(0.1)
            if self.scope_manager.scope_active(self.sid):
                self.scope_manager.signal_scope(self.sid, signal.SIGTERM)
                deadline = time.monotonic() + 5
                while (
                    not self._cleanup_force.is_set()
                    and self.scope_manager.scope_active(self.sid)
                    and time.monotonic() < deadline
                ):
                    time.sleep(0.1)
            if self.scope_manager.scope_active(self.sid):
                self.scope_manager.stop_scope(self.sid)
            if self.proc is not None and self.proc.poll() is None:
                try:
                    self.proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
                    self.proc.wait()
            self.scope_manager.unregister(self.sid)
            # The scope is gone, so nothing in this session can still be writing.
            # Delete the files it created in /tmp; the watcher only removes paths it
            # saw this session create, and only rmdirs directories it emptied.
            result = self.tmp_tracker.delete_session(self.sid)
            failed = result.get("failed") or []
            if failed:
                print(f"envoy: could not delete {len(failed)} /tmp file(s) for session "
                      f"{self.sid}: {failed[:3]}", file=sys.stderr)
            if self.registry is not None:
                self.registry.remove(self.sid)
            self._close_sockets()
            remove_socket_dir(self.sid)
            self._cleaned = True

    def _close_sockets(self) -> None:
        for sock in (self._control_sock, self._input_sock, self._output_sock):
            try:
                sock.close()
            except OSError:
                pass

    def detach(self) -> None:
        """Let go of a live worker without stopping it.

        This is what a routine web restart does: the worker keeps running, and
        the next web process finds it through the registry.
        """
        with self._cleanup_lock:
            if self._cleaned:
                return
            self.detached = True
            self.closing = True
            cancel = self.voice_cancel
            if cancel:
                cancel.set()
            self._notify_push_callbacks_closed()
            self._close_sockets()
            self._cleaned = True


class EnvoyService:
    def __init__(self, extra_env: dict[str, str] | None = None):
        self._sessions: dict[str, WorkerSession] = {}
        self._extra_env = dict(extra_env) if extra_env else None
        self._lock = threading.Lock()
        # One web process per runtime directory: adoption of live workers and
        # the startup sweep of unregistered scopes are only safe if no second
        # process is doing the same thing at the same time.
        self._web_lock = acquire_web_lock()
        self._scope_manager = SystemdScopeManager()
        self._tmp_tracker = TmpTracker()
        self._registry = Registry()
        self._reaper = threading.Thread(target=self._reap_loop, daemon=True, name="session-reaper")
        self._reaper.start()
        self._sweep_thread = threading.Thread(target=self._sweep_tmp_leftovers, daemon=True,
                                              name="tmp-sweep")
        self._sweep_thread.start()
        self._resume_registered_sessions()

    def _resume_registered_sessions(self) -> None:
        """Re-attach to sessions whose workers outlived a previous web process.

        Every registry row is either resumed or dropped. A row whose worker is
        gone (or whose scope is inactive) is cleaned up here, because nothing
        else will ever look at it again.
        """
        resumed = 0
        rows = {str(row["sid"]): row for row in self._registry.rows()}
        for sid, row in rows.items():
            try:
                if not self._scope_manager.scope_active(sid):
                    raise RuntimeError("session unit is not active")
                # Reserve the ID so the cgroup reconciliation thread cannot
                # mistake this live scope for an orphan.
                self._scope_manager.register(sid)
                session = WorkerSession(
                    sid,
                    str(row["path"]),
                    list(row["cmd"]),
                    str(row["cwd"]),
                    scope_manager=self._scope_manager,
                    tmp_tracker=self._tmp_tracker,
                    registry=self._registry,
                    login=bool(row["login"]),
                    extra_env=dict(row["extra_env"]),
                    prompt_sentinel=str(row["prompt_sentinel"]),
                    adopted_row=row,
                )
            except Exception as exc:
                print(f"envoy: dropping session {sid} from the registry: {exc}", file=sys.stderr)
                self._discard_registered_session(sid)
                continue
            with self._lock:
                self._sessions[sid] = session
            resumed += 1
        if resumed:
            print(f"envoy: resumed {resumed} session(s) from a previous run")
        self._reap_orphan_scopes(set(rows))

    def _reap_orphan_scopes(self, registered: set[str]) -> None:
        """Stop session units that no registry row accounts for.

        A web process that dies between launching a worker and recording it
        leaves a live scope with a live child that nothing will ever look at
        again: no registry row means no adoption, and the cgroup reconciliation
        thread only considers scopes this process registered. Startup is the one
        moment where such debris can be told apart from a live session, and the
        startup lock guarantees no other web process is mid-launch.
        """
        known = registered | set(self._sessions)
        orphans = []
        for unit in self._scope_manager.active_units():
            sid = sid_from_unit(unit)
            if sid is None or sid in known:
                continue
            orphans.append((sid, unit))
        for sid, unit in orphans:
            try:
                self._scope_manager.stop_unit(unit)
            except Exception as exc:
                print(f"envoy: could not stop orphaned session unit {unit}: {exc}", file=sys.stderr)
                continue
            remove_socket_dir(sid)
            try:
                self._tmp_tracker.delete_session(sid)
            except Exception:
                pass
            print(f"envoy: stopped orphaned session unit {unit}")

    def _discard_registered_session(self, sid: str) -> None:
        try:
            self._scope_manager.stop_session(sid)
        except Exception:
            pass
        self._scope_manager.unregister(sid)
        remove_socket_dir(sid)
        self._registry.remove(sid)
        try:
            self._tmp_tracker.delete_session(sid)
        except Exception:
            pass

    def _sweep_tmp_leftovers(self) -> None:
        """Ask the /tmp watcher to delete files left behind by sessions that are gone.

        The watcher decides which sessions still exist by reading the cgroup tree,
        not by asking envoy, so this is safe at startup even if sessions are live."""
        try:
            result = self._tmp_tracker.sweep()
        except Exception as exc:
            print(f"envoy: tmp sweep failed: {exc}", file=sys.stderr)
            return
        removed = result.get("removed") or 0
        sessions = result.get("sessions") or []
        if removed:
            print(f"envoy: deleted {removed} leftover /tmp file(s) from "
                  f"{len(sessions)} finished session(s)")

    def _reap_loop(self) -> None:
        while True:
            time.sleep(REAPER_INTERVAL_SECONDS)
            self._reap_sessions()

    def _reap_sessions(self) -> None:
        dead = []
        with self._lock:
            for sid, session in list(self._sessions.items()):
                if not session.alive:
                    self._sessions.pop(sid, None)
                    dead.append(session)
        for session in dead:
            try:
                session.cleanup()
            except Exception as exc:
                print(f"envoy: failed to reap session {session.sid}: {exc}", file=sys.stderr)

    def _encode(self, payload: bytes) -> str:
        return base64.b64encode(payload).decode("ascii")

    def _decode(self, payload: str) -> bytes:
        return base64.b64decode(payload.encode("ascii"))

    def _agent_request_key(self, kind: str, payload: bytes, agent_settings: dict | None) -> str:
        settings = json.dumps(agent_settings or {}, sort_keys=True, separators=(",", ":"))
        digest = hashlib.sha256(payload).hexdigest()
        return f"{kind}:{digest}:{settings}"

    def _new_session_id(self) -> str:
        return secrets.token_hex(4)

    def _get_session(self, session_id: str) -> WorkerSession:
        with self._lock:
            session = self._sessions.get(session_id)
        if not session:
            raise ValueError("No active session")
        return session

    def _new_session(self, path: str) -> WorkerSession:
        cmd, cwd, login = resolve_cli(path)
        with self._lock:
            sid = self._new_session_id()
            while sid in self._sessions:
                sid = self._new_session_id()
        # Reserve the session ID before launching its scope. Otherwise the
        # cgroup reconciliation thread can mistake the new scope for an orphan
        # and stop it before WorkerSession finishes connecting to its sockets.
        self._scope_manager.register(sid)
        try:
            session = WorkerSession(
                sid,
                path,
                cmd,
                cwd,
                scope_manager=self._scope_manager,
                tmp_tracker=self._tmp_tracker,
                registry=self._registry,
                login=login,
                extra_env=self._extra_env,
            )
        except Exception:
            self._scope_manager.unregister(sid)
            raise
        with self._lock:
            self._sessions[session.sid] = session
        return session

    def get_config(self, path: str) -> dict[str, str]:
        return {"title": build_title(path), "path": path}

    def get_settings(self) -> dict[str, dict[str, object]]:
        return get_env_settings()

    def save_settings(self, values: dict[str, str]) -> dict[str, object]:
        save_env_settings(values)
        return {"ok": True, "settings": get_env_settings()}

    def connect(self, path: str, session_id: str = "",
                mode: str = "takeover") -> dict[str, object]:
        if session_id:
            with self._lock:
                session = self._sessions.get(session_id)
            if not session or not session.alive:
                raise ValueError("No active session")
            client_id = secrets.token_hex(8)
            eviction_deliveries = []
            with session._lock:
                if mode == "takeover" or mode not in {"lead", "follow"}:
                    # Revoke the old clients immediately, but retain their callback
                    # references long enough to deliver one final eviction payload.
                    # Removing them from both maps first prevents any terminal output
                    # produced after the takeover from being streamed to them.
                    old_callbacks = list(session._push_callbacks.items())
                    session._push_callbacks.clear()
                    session.clients.clear()
                    session.add_client(client_id, "lead", awaiting_snapshot=True)
                    eviction_payload = {
                        "output": b"",
                        "events": [],
                        "evicted": True,
                        "alive": False,
                        "exit_code": -1,
                    }
                    eviction_deliveries = [
                        (client_id, callback, eviction_payload)
                        for client_id, callback in old_callbacks
                    ]
                elif mode == "lead":
                    # Demote existing lead to follow
                    for cs in session.clients.values():
                        if cs.role == "lead":
                            cs.role = "follow"
                    session.add_client(client_id, "lead", awaiting_snapshot=True)
                else:
                    session.add_client(client_id, "follow", awaiting_snapshot=True)
                session._pending_ready.notify_all()
                role = session.clients[client_id].role
            session._dispatch_push_payloads(eviction_deliveries)
            resp = self._snapshot_for_client(session, client_id, role)
            resp["client_id"] = client_id
            return resp

        session = self._new_session(path)
        client_id = secrets.token_hex(8)
        with session._lock:
            session.add_client(client_id, "lead", awaiting_snapshot=True)
        resp = self._snapshot_for_client(session, client_id, "lead")
        resp["client_id"] = client_id
        return resp

    def _snapshot_for_client(self, session: WorkerSession, client_id: str,
                             role: str) -> dict[str, object]:
        """Take a client's snapshot and open its live stream.

        Both halves matter together: the repaint carries everything up to the
        snapshot offset, and the client's buffered live bytes below that offset
        are dropped. Only once the watermark is applied may the client's stream
        deliver anything, which is what the gate set by add_client holds back.
        """
        try:
            resp = session.snapshot_response(role)
            self._apply_snapshot_watermark(session, client_id, resp)
        except Exception:
            # Never leave a gated client behind: it would hold its stream open
            # and deliver nothing for the life of the tab.
            session.remove_client(client_id)
            raise
        return resp

    @staticmethod
    def _apply_snapshot_watermark(session: WorkerSession, client_id: str,
                                  resp: dict[str, object]) -> None:
        """Drop live output this client's repaint already contains.

        The snapshot is captured after the client was added, so output produced
        in between is buffered *and* present in the repaint. The snapshot reports
        the stream position it reaches; everything below it is dropped from the
        client's buffer, which makes the handover between repaint and live stream
        exact: no gap and no duplicate.
        """
        offset = resp.pop("output_offset", None)
        with session._lock:
            cs = session.clients.get(client_id)
            if cs is None:
                return
            if isinstance(offset, int):
                cs.apply_snapshot_locked(offset)
            else:
                # A session that does not track stream offsets (the in-process
                # fallback) has nothing to reconcile, so the client may start
                # receiving immediately.
                cs.awaiting_snapshot = False
            session._pending_ready.notify_all()
            deliveries = session._collect_push_payloads_locked()
        session._dispatch_push_notifications(deliveries)

    def write(self, session_id: str, data_b64: str,
              client_id: str = "") -> dict[str, bool]:
        session = self._get_session(session_id)
        if client_id:
            with session._lock:
                if client_id not in session.clients:
                    raise ValueError("Client was evicted")
        session.write(self._decode(data_b64))
        return {"ok": True}

    def resize(self, session_id: str, cols: int, rows: int,
               client_id: str = "") -> dict[str, bool]:
        session = self._get_session(session_id)
        if client_id:
            with session._lock:
                cs = session.clients.get(client_id)
                if cs is None:
                    raise ValueError("Client was evicted")
                if cs.role != "lead":
                    return {"ok": False}
        session.resize(cols, rows)
        session.cols, session.rows = cols, rows
        self._registry.update(session_id, cols=cols, rows=rows)
        with session._lock:
            for cs in session.clients.values():
                if cs.role == "follow":
                    cs.pending_resize = (cols, rows)
            session._pending_ready.notify_all()
            deliveries = session._collect_push_payloads_locked()
        session._dispatch_push_notifications(deliveries)
        return {"ok": True}

    def upload_file(self, session_id: str, name: str, data_b64: str) -> dict[str, str]:
        session = self._get_session(session_id)
        path = session.save_upload(name, self._decode(data_b64))
        return {"path": path}

    def resolve_files(self, session_id: str, paths: list[str]) -> dict[str, object]:
        session = self._get_session(session_id)
        return {"files": session.resolve_files(paths)}

    def read_file(self, session_id: str, path: str) -> tuple[dict[str, object], bytes]:
        session = self._get_session(session_id)
        resolved = session.resolve_file(path)
        if not resolved:
            raise ValueError("File not found")
        info_path = str(resolved["path"])
        try:
            with open(info_path, "rb") as handle:
                return resolved, handle.read()
        except OSError as exc:
            raise ValueError("File not found") from exc

    def synthesize_text(self, text: str) -> dict[str, str | None]:
        return {"audio": synthesize_speech(text[:12000])}

    def send_text_message(self, session_id: str, text: str,
                          agent_settings: dict | None = None) -> dict[str, object]:
        session = self._get_session(session_id)
        if not session.alive:
            raise ValueError("No active session")
        settings = agent_settings or {}
        request_key = self._agent_request_key("text", text.encode("utf-8"), settings)
        now = time.monotonic()
        with session._lock:
            if (
                session._last_agent_request
                and session._last_agent_request[0] == request_key
                and now - session._last_agent_request[1] <= AGENT_DUPLICATE_REQUEST_WINDOW_SECONDS
            ):
                return {"error": "Duplicate agent request ignored.", "response": "", "speech": "", "commands": []}
        if not session.agent_lock.acquire(blocking=False):
            return {"error": "Agent is already running for this session.", "response": "", "speech": "", "commands": []}
        cancel = threading.Event()
        session.voice_cancel = cancel
        try:
            iface = SessionTerminal(session)
            reply = process_text_message(text, iface, cancel,
                                         agent_settings=settings)
            speech = "\n".join(iface.messages) or reply
            if speech:
                session.push_agent_event("status", "Generating audio...")
            if speech and not iface.messages:
                session.push_agent_event("message", speech)
            result = {
                "response": reply,
                "speech": speech,
                "commands": iface.commands,
                "audio": synthesize_speech(speech) if speech else None,
            }
            with session._lock:
                session._last_agent_request = (request_key, time.monotonic())
            return result
        except AgentMaxTurnsError as exc:
            message = f"Agent stopped after reaching the turn limit ({exc.max_turns}). Send another message to continue."
            session.push_agent_event("status", message)
            return {"error": message, "turn_limit_reached": True, "response": "", "speech": "", "commands": []}
        except CancelledError:
            return {"response": "", "speech": "", "commands": []}
        finally:
            session.voice_cancel = None
            session.agent_lock.release()

    def send_voice_message(self, session_id: str, audio_b64: str, mime_type: str,
                           agent_settings: dict | None = None) -> dict[str, object]:
        session = self._get_session(session_id)
        if not session.alive:
            raise ValueError("No active session")
        settings = agent_settings or {}
        audio = self._decode(audio_b64)
        request_key = self._agent_request_key("voice", mime_type.encode("utf-8") + b"\0" + audio, settings)
        now = time.monotonic()
        with session._lock:
            if (
                session._last_agent_request
                and session._last_agent_request[0] == request_key
                and now - session._last_agent_request[1] <= AGENT_DUPLICATE_REQUEST_WINDOW_SECONDS
            ):
                return {"error": "Duplicate agent request ignored.", "response": "", "speech": "", "commands": []}
        if not session.agent_lock.acquire(blocking=False):
            return {"error": "Agent is already running for this session.", "response": "", "speech": "", "commands": []}
        cancel = threading.Event()
        session.voice_cancel = cancel
        try:
            iface = SessionTerminal(session)
            reply = process_voice_message(audio, mime_type, iface, cancel,
                                          agent_settings=settings)
            speech = "\n".join(iface.messages) or reply
            if speech:
                session.push_agent_event("status", "Generating audio...")
            if speech and not iface.messages:
                session.push_agent_event("message", speech)
            result = {
                "response": reply,
                "speech": speech,
                "commands": iface.commands,
                "audio": synthesize_speech(speech) if speech else None,
            }
            with session._lock:
                session._last_agent_request = (request_key, time.monotonic())
            return result
        except AgentMaxTurnsError as exc:
            message = f"Agent stopped after reaching the turn limit ({exc.max_turns}). Send another message to continue."
            session.push_agent_event("status", message)
            return {"error": message, "turn_limit_reached": True, "response": "", "speech": "", "commands": []}
        except CancelledError:
            return {"response": "", "speech": "", "commands": []}
        finally:
            session.voice_cancel = None
            session.agent_lock.release()

    def transcribe_audio(self, audio_b64: str, mime_type: str) -> dict[str, str]:
        return {"text": transcribe_audio(self._decode(audio_b64), mime_type)}

    def cancel_agent(self, session_id: str) -> dict[str, bool]:
        session = self._get_session(session_id)
        cancel = session.voice_cancel
        if cancel:
            cancel.set()
        return {"ok": True}

    def list_sessions(self, path: str | None = None) -> dict[str, object]:
        with self._lock:
            sessions = list(self._sessions.values())
        result = []
        for s in sessions:
            if not s.alive:
                continue
            if path is not None and path not in ("all", "*", "") and s.path != path:
                continue
            result.append({
                "sid": s.sid,
                "title": s.title,
                "path": s.path,
                "cmd": s.cmd,
                "cwd": s.cwd,
                "pid": s.worker_pid,
                "scope": s.scope_name,
                "attached": bool(s.clients),
                "clients": len(s.clients),
                "closing": s.closing,
                "resources": {"memory": self._scope_manager.session_stats(s.sid)},
            })
        return {
            "sessions": result,
            "resources": {"memory": self._scope_manager.aggregate_stats()},
        }

    def update_resource_limits(self, target: str, session_id: str = "",
                               memory_high: object = None, memory_max: object = None,
                               memory_swap_max: object = None) -> dict[str, object]:
        if target == "session":
            self._get_session(session_id)
        return self._scope_manager.update_limits(
            target, session_id, memory_high, memory_max, memory_swap_max
        )

    def _start_session_cleanup(self, session_id: str, session: WorkerSession, force: bool) -> None:
        if force:
            session._cleanup_force.set()
        with session._cleanup_state_lock:
            if session._cleanup_started:
                return
            session._cleanup_started = True
            session.closing = True

        def close() -> None:
            try:
                session.cleanup(force=force)
            except Exception as exc:
                print(f"envoy: failed to clean up session {session_id}: {exc}", file=sys.stderr)
            finally:
                with self._lock:
                    if self._sessions.get(session_id) is session:
                        self._sessions.pop(session_id, None)

        threading.Thread(target=close, daemon=True, name=f"close-{session_id}").start()

    def force_stop_session(self, session_id: str) -> dict[str, bool]:
        with self._lock:
            session = self._sessions.get(session_id)
        if session:
            self._start_session_cleanup(session_id, session, force=True)
        return {"ok": True}

    def rename_session(self, session_id: str, title: str) -> dict[str, object]:
        with self._lock:
            session = self._sessions.get(session_id)
        if session:
            session.title = title
            try:
                session._call_control({"type": "rename", "title": title}, timeout=5)
            except Exception:
                pass
            self._registry.update(session_id, title=title)
        return {"ok": True}

    def close_session(self, session_id: str) -> dict[str, bool]:
        with self._lock:
            session = self._sessions.get(session_id)
        if session:
            self._start_session_cleanup(session_id, session, force=False)
        return {"ok": True, "closing": bool(session)}

    def mark_detached(self, session_id: str, client_id: str = "") -> None:
        session = self._get_session(session_id)
        if client_id:
            session.remove_client(client_id)

    def shutdown(self, stop_sessions: bool = False) -> None:
        """Stop the web process.

        By default sessions are *detached*, not stopped: their workers keep
        running and the next web process resumes them from the registry. Pass
        ``stop_sessions=True`` (used by tests and by an explicit full stop) to
        tear the sessions down instead.
        """
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            try:
                if stop_sessions:
                    session.cleanup()
                else:
                    session.detach()
            except Exception as exc:
                print(f"envoy: failed to release session {session.sid}: {exc}", file=sys.stderr)
        self._scope_manager.close(stop_scopes=stop_sessions)
        self._registry.close()
        if self._web_lock is not None:
            try:
                self._web_lock.close()
            except OSError:
                pass
            self._web_lock = None
