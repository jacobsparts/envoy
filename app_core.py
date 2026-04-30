"""Shared runtime core for desktop and envoy server modes."""

from __future__ import annotations

import base64
import collections
import copy
import mimetypes
import socket
import fcntl
import os
import pty
import re
import resource
import secrets
import shlex
import struct
import subprocess
import termios
import threading
import time
from collections.abc import Callable
from pathlib import Path

import pyte

from env_config import get_env_settings, save_env_settings
from speech import synthesize_speech
from terminal_session import SessionTerminal
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


def render_html(mode: str, web_prefix: str = "") -> str:
    template = APP_TEMPLATE.read_text()
    if mode == "web":
        static = f"{web_prefix}/static/"
        head_extra = _web_head_extra(static)
        body_extra = (
            "<script>\n"
            "if ('serviceWorker' in navigator && window.isSecureContext) {\n"
            f"  navigator.serviceWorker.register('{static}sw.js', {{ scope: '{web_prefix}/' }});\n"
            "}\n"
            "</script>"
        )
    elif mode == "desktop":
        static = ""
        head_extra = ""
        body_extra = ""
    else:
        raise ValueError(f"unknown render mode: {mode!r}")
    return (template
            .replace("{{STATIC}}", static)
            .replace("{{WEB_HEAD_EXTRA}}", head_extra)
            .replace("{{WEB_BODY_EXTRA}}", body_extra))

UPLOAD_DIR = os.path.join(APP_DIR, ".envoy_uploads")
ALIASES_FILE = os.path.join(APP_DIR, "aliases.conf")
SCROLLBACK_BUFFER_SIZE = 100_000
SESSION_TIMEOUT = 60 * 60 * 24
TERMINAL_SETTLE_SECONDS = 0.75
TERMINAL_POLL_SECONDS = 0.1


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


# Env vars a desktop-launched shell expects to inherit so GUI apps,
# dbus, keyrings, and agents work. The user's rc files still run on
# top, so anything here is just a default.
_DESKTOP_PASSTHROUGH_VARS = (
    "DISPLAY",
    "XAUTHORITY",
    "WAYLAND_DISPLAY",
    "DBUS_SESSION_BUS_ADDRESS",
    "XDG_RUNTIME_DIR",
    "XDG_SESSION_TYPE",
    "XDG_SESSION_ID",
    "XDG_SESSION_DESKTOP",
    "XDG_CURRENT_DESKTOP",
    "XDG_DATA_DIRS",
    "XDG_CONFIG_DIRS",
    "DESKTOP_SESSION",
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
)


def desktop_inherited_env() -> dict[str, str]:
    return {k: os.environ[k] for k in _DESKTOP_PASSTHROUGH_VARS if k in os.environ}


def _login_shell() -> str:
    """Return the user's login shell from the passwd database."""
    import pwd
    return pwd.getpwuid(os.getuid()).pw_shell or "/bin/sh"


def sanitize_filename(name: str) -> str:
    name = os.path.basename(name).lstrip(".")
    return name or "upload"


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


class ClientState:
    __slots__ = ("client_id", "role", "output", "events", "promoted", "joined", "pending_resize")

    def __init__(self, client_id: str, role: str):
        self.client_id = client_id
        self.role = role  # "lead" or "follow"
        self.output: bytearray = bytearray()
        self.events: list[dict[str, str]] = []
        self.promoted = False
        self.joined = time.monotonic()
        self.pending_resize: tuple[int, int] | None = None


class Session:
    def __init__(self, sid: str, path: str, cmd: list[str], cwd: str, *,
                 login: bool = False, extra_env: dict[str, str] | None = None):
        self.sid = sid
        self.path = path
        self.cmd = list(cmd)
        self.cwd = cwd
        self.title = ""
        self.master, slave = pty.openpty()
        self._prompt_sentinel = f"__ENVOY_PROMPT_{secrets.token_hex(6)}__"
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
        _SESSION_MEM_LIMIT = 4 * 1024 * 1024 * 1024  # 4 GB
        def _limit_mem():
            resource.setrlimit(resource.RLIMIT_RSS, (_SESSION_MEM_LIMIT, _SESSION_MEM_LIMIT))
        self.proc = subprocess.Popen(cmd, **popen_kwargs, preexec_fn=_limit_mem)
        os.close(slave)
        self.scrollback = collections.deque()
        self.scrollback_bytes = 0
        self._archive_pyte_screen = pyte.HistoryScreen(80, 24, history=200000)
        self._archive_pyte_stream = pyte.Stream(self._archive_pyte_screen)
        self._last_archive_cut = {"kind": "init", "bytes": 0}
        self._archive_total_bytes = 0
        self.session_files: list[str] = []
        self.resolved_files: dict[str, dict[str, object]] = {}
        self.alive = True
        self.exit_message = b""
        self.exit_code: int | None = None
        # pyte virtual terminal for agent context
        self._pyte_screen = pyte.HistoryScreen(80, 24, history=50000)
        self._pyte_stream = pyte.Stream(self._pyte_screen)
        self._pyte_known_lines: list[str] = []
        self.voice_cancel: threading.Event | None = None
        self.clients: dict[str, ClientState] = {}
        self._push_callbacks: dict[str, Callable[[dict[str, object]], None]] = {}
        self.last_seen: float = time.monotonic()
        self._last_output_at: float = self.last_seen
        self._last_input_at: float = self.last_seen
        self._lock = threading.Lock()
        self._pending_ready = threading.Condition(self._lock)
        self._timeout: threading.Timer | None = None
        self._reader = threading.Thread(target=self._read_loop, daemon=True, name=f"pty-{sid}")
        self._reader.start()

    def _drain_client_locked(self, client_id: str) -> dict[str, object] | None:
        cs = self.clients.get(client_id)
        if not cs:
            return None
        output = bytes(cs.output)
        cs.output.clear()
        events = copy.deepcopy(cs.events)
        cs.events.clear()
        promoted = cs.promoted
        cs.promoted = False
        resize = cs.pending_resize
        cs.pending_resize = None
        payload: dict[str, object] = {
            "output": output,
            "events": events,
            "promoted": promoted,
            "alive": self.alive,
            "exit_code": self.exit_code,
        }
        if resize:
            payload["resize"] = {"cols": resize[0], "rows": resize[1]}
        return payload

    def _collect_push_payloads_locked(self) -> list[tuple[Callable[[dict[str, object]], None], dict[str, object]]]:
        deliveries: list[tuple[Callable[[dict[str, object]], None], dict[str, object]]] = []
        for client_id, callback in list(self._push_callbacks.items()):
            payload = self._drain_client_locked(client_id)
            if payload is None:
                deliveries.append((callback, {"output": b"", "events": [], "evicted": True, "alive": False, "exit_code": -1}))
                continue
            deliveries.append((callback, payload))
        return deliveries

    def _dispatch_push_payloads(self, deliveries: list[tuple[Callable[[dict[str, object]], None], dict[str, object]]]) -> None:
        stale_clients: list[str] = []
        for callback, payload in deliveries:
            try:
                callback(payload)
            except Exception:
                stale_clients.extend([
                    client_id for client_id, cb in self._push_callbacks.items()
                    if cb is callback
                ])
        if stale_clients:
            with self._lock:
                for client_id in stale_clients:
                    self._push_callbacks.pop(client_id, None)

    def register_push(self, client_id: str, callback: Callable[[dict[str, object]], None]) -> dict[str, object] | None:
        with self._lock:
            if client_id not in self.clients:
                return {"output": b"", "events": [], "evicted": True, "alive": False, "exit_code": -1}
            self._push_callbacks[client_id] = callback
            payload = self._drain_client_locked(client_id)
        return payload

    def unregister_push(self, client_id: str, callback: Callable[[dict[str, object]], None] | None = None) -> None:
        with self._lock:
            if callback is not None and self._push_callbacks.get(client_id) is not callback:
                return
            self._push_callbacks.pop(client_id, None)

    def _append_output(self, data: bytes) -> None:
        self._last_output_at = time.monotonic()
        self.scrollback.append(data)
        self.scrollback_bytes += len(data)
        self._trim_scrollback_locked()
        for cs in self.clients.values():
            cs.output.extend(data)
        try:
            self._pyte_stream.feed(data.decode("utf-8", errors="replace"))
        except Exception:
            pass

    def _feed_archive(self, data: bytes, cut_kind: str = "unknown") -> None:
        if not data:
            return
        self._archive_total_bytes += len(data)
        self._last_archive_cut = {"kind": cut_kind, "bytes": len(data)}
        try:
            self._archive_pyte_stream.feed(data.decode("utf-8", errors="replace"))
        except Exception:
            pass

    def _ansi_safe_cut(self, data: bytes, overflow: int) -> tuple[int, str]:
        if not data:
            return 0, "empty"
        target = min(len(data), overflow + 8192)
        preferred = (
            (b"\n", "newline"),
            (b"\r", "carriage_return"),
        )
        for needle, kind in preferred:
            idx = data.rfind(needle, 0, target)
            if idx != -1:
                cut = idx + 1
                if self._is_escape_boundary_safe(data, cut):
                    return cut, kind
        hard = overflow
        while hard < len(data) and (data[hard] & 0b1100_0000) == 0b1000_0000:
            hard += 1
        if hard > len(data):
            hard = len(data)
        while hard > overflow and not self._is_escape_boundary_safe(data, hard):
            hard -= 1
        if hard > 0:
            return hard, "hard_safe"
        return min(len(data), overflow), "hard"

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
                self._feed_archive(removed, "chunk")
                continue
            cut, cut_kind = self._ansi_safe_cut(removed, overflow)
            archived = removed[:cut]
            kept = removed[cut:]
            self.scrollback_bytes -= len(archived)
            self._feed_archive(archived, cut_kind)
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
                    self._append_output(data)
                    self._pending_ready.notify_all()
                    deliveries = self._collect_push_payloads_locked()
                self._dispatch_push_payloads(deliveries)
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
                self._append_output(self.exit_message)
                self._pending_ready.notify_all()
                deliveries = self._collect_push_payloads_locked()
            self._dispatch_push_payloads(deliveries)
            self.cancel_timeout()
            try:
                os.close(self.master)
            except OSError:
                pass

    def get_scrollback(self) -> bytes:
        with self._lock:
            return b"".join(self.scrollback)

    def _render_pyte_screen(self, screen: pyte.HistoryScreen) -> list[str]:
        lines = []
        for hist_line in screen.history.top:
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

    def get_archived_text(self) -> str:
        with self._lock:
            return "\n".join(self._render_pyte_screen(self._archive_pyte_screen))

    def get_reconnect_debug(self) -> dict[str, object]:
        with self._lock:
            archive_lines = self._render_pyte_screen(self._archive_pyte_screen)
            return {
                "archive_lines": len(archive_lines),
                "archive_bytes": self._archive_total_bytes,
                "recent_bytes": self.scrollback_bytes,
                "recent_chunks": len(self.scrollback),
                "last_archive_cut": dict(self._last_archive_cut),
                "live_lines": len(self._render_pyte_screen(self._pyte_screen)),
                "cols": self._pyte_screen.columns,
                "rows": self._pyte_screen.lines,
            }

    def get_terminal_lines(self) -> list[str]:
        """Return rendered lines from pyte: history + current screen."""
        with self._lock:
            return self._render_pyte_screen(self._pyte_screen)

    def reset_context_lookback(self, rows: int) -> None:
        """Reset the context watermark to include the last *rows* lines."""
        lines = self.get_terminal_lines()
        start = max(0, len(lines) - rows)
        self._pyte_known_lines = lines[:start]

    def push_agent_event(self, kind: str, text: str) -> None:
        deliveries = []
        with self._lock:
            for cs in self.clients.values():
                cs.events.append({"kind": kind, "text": text})
            self._pending_ready.notify_all()
            deliveries = self._collect_push_payloads_locked()
        self._dispatch_push_payloads(deliveries)

    def add_client(self, client_id: str, role: str) -> ClientState:
        """Add a client under the lock. Caller must hold self._lock."""
        cs = ClientState(client_id, role)
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
            self._dispatch_push_payloads(deliveries)
        return promoted_client_id

    def get_lead_client(self) -> ClientState | None:
        """Return the lead client, if any. Caller must hold self._lock or accept races."""
        for cs in self.clients.values():
            if cs.role == "lead":
                return cs
        return None

    def wait_for_client(self, client_id: str, timeout: float) -> tuple[bytes, list[dict[str, str]], bool, tuple[int, int] | None]:
        """Block until this client has output, events, promotion, resize, or timeout.
        Returns (output_bytes, agent_events, promoted, pending_resize)."""
        deadline = time.monotonic() + max(timeout, 0.0)
        with self._lock:
            cs = self.clients.get(client_id)
            if not cs:
                return b"", [], False, None
            while self.alive and not cs.output and not cs.events and not cs.promoted and not cs.pending_resize:
                if client_id not in self.clients:
                    return b"", [], False, None
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._pending_ready.wait(remaining)
            cs = self.clients.get(client_id)
            if not cs:
                return b"", [], False, None
            payload = self._drain_client_locked(client_id)
            if not payload:
                return b"", [], False, None
            resize = payload.get("resize")
            resize_tuple = None if not resize else (int(resize["cols"]), int(resize["rows"]))
            return payload["output"], payload["events"], bool(payload["promoted"]), resize_tuple

    def write(self, data: bytes) -> None:
        if self.alive:
            with self._lock:
                self._last_input_at = time.monotonic()
            os.write(self.master, data)

    def _screen_excerpt_locked(self, lines: list[str], max_lines: int = 20) -> str:
        excerpt = lines[-max_lines:]
        return "\n".join(excerpt)

    def _detect_prompt_locked(self, lines: list[str]) -> tuple[bool, str, str]:
        for line in reversed(lines[-3:]):
            if self._prompt_sentinel in line:
                return True, "high", "shell"
        last_nonempty = next((line for line in reversed(lines) if line.strip()), "")
        if not last_nonempty:
            return False, "low", "unknown"
        if re.match(r"^(>>>|\.\.\.|In \[\d+\]:) ?$", last_nonempty):
            return True, "high", "python_repl"
        if re.match(r"^\((Pdb|gdb)\) ?$", last_nonempty):
            return True, "high", "debugger"
        if re.match(r"^.{0,200}[#$%>] ?$", last_nonempty):
            return True, "medium", "shell_like"
        if re.match(r"^\(.+\) .{0,200}[#$] ?$", last_nonempty):
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

    def _wait_for_state(self, *, seconds: float = 0.0, wait_for_settle: bool = False,
                        expect_prompt: bool = False, timeout: float = 30.0) -> tuple[dict[str, object], bool, int]:
        start = time.monotonic()
        minimum_deadline = start + max(0.0, seconds)
        deadline = start + max(0.0, timeout)
        with self._lock:
            while True:
                now = time.monotonic()
                state = self._terminal_state_locked()
                minimum_elapsed = now >= minimum_deadline
                if minimum_elapsed:
                    if expect_prompt and state["prompt_visible"]:
                        return state, False, int((now - start) * 1000)
                    if wait_for_settle and state["settled"] and (not expect_prompt or state["prompt_visible"]):
                        return state, False, int((now - start) * 1000)
                    if not expect_prompt and not wait_for_settle:
                        return state, False, int((now - start) * 1000)
                if now >= deadline:
                    return state, True, int((now - start) * 1000)
                next_wake = min(deadline, now + TERMINAL_POLL_SECONDS)
                if not minimum_elapsed:
                    next_wake = min(next_wake, minimum_deadline)
                self._pending_ready.wait(max(0.0, next_wake - now))

    def execute_terminal_action(self, action: dict[str, object]) -> dict[str, object]:
        action_type = str(action.get("type") or "").strip()
        wait_for_settle = bool(action.get("wait_for_settle", False))
        expect_prompt = bool(action.get("expect_prompt", False))
        timeout = float(action.get("timeout", 30) or 30)

        if not action_type:
            return {"ok": False, "error": "invalid_action", "message": "Missing action type", "state": self.get_terminal_state()}
        if not self.alive and action_type != "wait":
            return {"type": f"{action_type}_result", "ok": False, "error": "session_not_alive", "state": self.get_terminal_state()}

        initial_state = self.get_terminal_state()
        if action_type == "command":
            command = str(action.get("command") or "")
            if not command:
                return {"type": "command_result", "ok": False, "error": "invalid_command", "state": initial_state}
            if (
                initial_state["busy"]
                or not initial_state["prompt_visible"]
                or initial_state["input_mode"] != "shell"
            ):
                return {
                    "type": "command_result",
                    "ok": False,
                    "error": "not_input_safe",
                    "message": "Terminal is not in a confirmed shell prompt state",
                    "state": initial_state,
                }
            self.write((command + "\n").encode("utf-8"))
            state, timed_out, duration_ms = self._wait_for_state(
                wait_for_settle=wait_for_settle,
                expect_prompt=expect_prompt,
                timeout=timeout,
            )
            return {
                "type": "command_result",
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

        if action_type == "keypress":
            keys = action.get("keys")
            if not isinstance(keys, list) or not keys:
                return {"type": "keypress_result", "ok": False, "error": "invalid_keys", "state": initial_state}
            key_map = {
                "ENTER": b"\r",
                "TAB": b"\t",
                "ESC": b"\x1b",
                "CTRL-C": b"\x03",
                "CTRL-D": b"\x04",
                "ARROW_UP": b"\x1b[A",
                "ARROW_DOWN": b"\x1b[B",
                "ARROW_RIGHT": b"\x1b[C",
                "ARROW_LEFT": b"\x1b[D",
            }
            payload = bytearray()
            for key in keys:
                token = str(key)
                payload.extend(key_map.get(token, token.encode("utf-8")))
            self.write(bytes(payload))
            state, timed_out, duration_ms = self._wait_for_state(
                wait_for_settle=wait_for_settle,
                expect_prompt=expect_prompt,
                timeout=timeout,
            )
            return {
                "type": "keypress_result",
                "ok": not timed_out,
                "timed_out": timed_out,
                "prompt_seen": bool(state["prompt_visible"]),
                "settled": bool(state["settled"]),
                "duration_ms": duration_ms,
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
        if self.alive:
            winsize = struct.pack("HHHH", rows, cols, 0, 0)
            fcntl.ioctl(self.master, termios.TIOCSWINSZ, winsize)
        with self._lock:
            self._pyte_screen.resize(rows, cols)
            self._archive_pyte_screen.resize(rows, cols)

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

    def _file_info(self, raw: str, path: str) -> dict[str, object]:
        mime = mimetypes.guess_type(path)[0] or "application/octet-stream"
        info = {
            "raw": raw,
            "path": path,
            "name": os.path.basename(path),
            "mime": mime,
            "size": os.path.getsize(path),
            "is_image": mime.startswith("image/"),
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

    def start_timeout(self) -> None:
        self.cancel_timeout()
        timer = threading.Timer(SESSION_TIMEOUT, self._timeout_expired)
        timer.daemon = True
        self._timeout = timer
        timer.start()

    def cancel_timeout(self) -> None:
        timer = self._timeout
        if timer:
            timer.cancel()
            self._timeout = None

    def _timeout_expired(self) -> None:
        self._timeout = None
        if self.alive:
            self.proc.terminate()

    def cleanup(self) -> None:
        self.cancel_timeout()
        cancel = self.voice_cancel
        if cancel:
            cancel.set()
        with self._lock:
            self._push_callbacks.clear()
        if self.alive:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        for path in self.session_files:
            try:
                os.remove(path)
            except OSError:
                pass


CLIENT_STALE_SECONDS = 30


class EnvoyService:
    def __init__(self, extra_env: dict[str, str] | None = None):
        self._sessions: dict[str, Session] = {}
        self._extra_env = dict(extra_env) if extra_env else None
        self._lock = threading.Lock()
        self._reaper = threading.Thread(target=self._reap_loop, daemon=True, name="session-reaper")
        self._reaper.start()

    def _reap_loop(self) -> None:
        while True:
            time.sleep(CLIENT_STALE_SECONDS)
            now = time.monotonic()
            with self._lock:
                sessions = list(self._sessions.values())
            for s in sessions:
                if s.alive and not s.clients and s._timeout is None and now - s.last_seen >= CLIENT_STALE_SECONDS:
                    s.start_timeout()

    def _encode(self, payload: bytes) -> str:
        return base64.b64encode(payload).decode("ascii")

    def _decode(self, payload: str) -> bytes:
        return base64.b64decode(payload.encode("ascii"))

    def _new_session_id(self) -> str:
        return secrets.token_hex(4)

    def _get_session(self, session_id: str) -> Session:
        with self._lock:
            session = self._sessions.get(session_id)
        if not session:
            raise ValueError("No active session")
        return session

    def _new_session(self, path: str) -> Session:
        cmd, cwd, login = resolve_cli(path)
        session = Session(self._new_session_id(), path, cmd, cwd, login=login, extra_env=self._extra_env)
        with self._lock:
            while session.sid in self._sessions:
                session.sid = self._new_session_id()
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
            session.cancel_timeout()
            client_id = secrets.token_hex(8)
            with session._lock:
                if mode == "takeover":
                    session._push_callbacks.clear()
                    session.clients.clear()
                    session.add_client(client_id, "lead")
                elif mode == "lead":
                    # Demote existing lead to follow
                    for cs in session.clients.values():
                        if cs.role == "lead":
                            cs.role = "follow"
                    session.add_client(client_id, "lead")
                elif mode == "follow":
                    session.add_client(client_id, "follow")
                else:
                    session._push_callbacks.clear()
                    session.clients.clear()
                    session.add_client(client_id, "lead")
                session._pending_ready.notify_all()
            role = session.clients[client_id].role
            resp = {
                "sid": session.sid,
                "client_id": client_id,
                "role": role,
                "cols": session._pyte_screen.columns,
                "rows": session._pyte_screen.lines,
                "title": build_title(session.path),
                "archive_text": session.get_archived_text(),
                "reconnect_debug": session.get_reconnect_debug(),
                "output": self._encode(session.get_scrollback()),
                "alive": session.alive,
                "exit_code": session.exit_code,
            }
            if session.title:
                resp["custom_title"] = session.title
            return resp

        session = self._new_session(path)
        client_id = secrets.token_hex(8)
        with session._lock:
            session.add_client(client_id, "lead")
        resp = {
            "sid": session.sid,
            "client_id": client_id,
            "role": "lead",
            "title": build_title(session.path),
            "archive_text": session.get_archived_text(),
            "reconnect_debug": session.get_reconnect_debug(),
            "output": self._encode(session.get_scrollback()),
            "alive": session.alive,
            "exit_code": session.exit_code,
        }
        if session.title:
            resp["custom_title"] = session.title
        return resp

    def read(self, session_id: str, client_id: str = "", wait_timeout: float = 0.0) -> dict[str, object]:
        with self._lock:
            session = self._sessions.get(session_id)
        if not session:
            return {"output": "", "alive": False, "exit_code": -1}
        if client_id and client_id not in session.clients:
            return {"output": "", "alive": False, "evicted": True, "exit_code": -1}
        if session.alive:
            session.cancel_timeout()
        session.last_seen = time.monotonic()
        if client_id and wait_timeout > 0:
            output, events, promoted, resize = session.wait_for_client(client_id, wait_timeout)
        elif client_id:
            with session._lock:
                payload = session._drain_client_locked(client_id)
                if not payload:
                    return {"output": "", "alive": False, "evicted": True, "exit_code": -1}
                output = payload["output"]
                events = payload["events"]
                promoted = payload["promoted"]
                resize = payload.get("resize")
        else:
            output = b""
            events = []
            promoted = False
            resize = None
        if client_id and client_id not in session.clients:
            return {"output": "", "alive": False, "evicted": True, "exit_code": -1}
        result = {
            "output": self._encode(output),
            "events": events,
            "promoted": promoted,
            "alive": session.alive,
            "exit_code": session.exit_code,
        }
        if resize:
            result["resize"] = resize
        return result

    def write(self, session_id: str, data_b64: str) -> dict[str, bool]:
        session = self._get_session(session_id)
        session.write(self._decode(data_b64))
        return {"ok": True}

    def resize(self, session_id: str, cols: int, rows: int,
               client_id: str = "") -> dict[str, bool]:
        session = self._get_session(session_id)
        if client_id:
            with session._lock:
                cs = session.clients.get(client_id)
                if cs and cs.role != "lead":
                    return {"ok": False}
        session.resize(cols, rows)
        with session._lock:
            for cs in session.clients.values():
                if cs.role == "follow":
                    cs.pending_resize = (cols, rows)
            session._pending_ready.notify_all()
            deliveries = session._collect_push_payloads_locked()
        session._dispatch_push_payloads(deliveries)
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
        raw = path
        info = session.resolved_files.get(raw)
        if not info or info.get("path") != path:
            if os.path.isfile(path):
                info = session._file_info(raw, os.path.realpath(path))
            else:
                resolved = session.resolve_file(path)
                if not resolved:
                    raise ValueError("File not found")
                info = resolved
        with open(str(info["path"]), "rb") as handle:
            return info, handle.read()

    def send_text_message(self, session_id: str, text: str,
                          agent_settings: dict | None = None) -> dict[str, object]:
        session = self._get_session(session_id)
        if not session.alive:
            raise ValueError("No active session")
        cancel = threading.Event()
        session.voice_cancel = cancel
        try:
            iface = SessionTerminal(session)
            reply = process_text_message(text, iface, cancel,
                                         agent_settings=agent_settings or {})
            speech = "\n".join(iface.messages) or reply
            if speech:
                session.push_agent_event("status", "Generating audio...")
            if speech and not iface.messages:
                session.push_agent_event("message", speech)
            return {
                "response": reply,
                "speech": speech,
                "commands": iface.commands,
                "audio": synthesize_speech(speech) if speech else None,
            }
        except CancelledError:
            return {"response": "", "speech": "", "commands": []}
        finally:
            session.voice_cancel = None

    def send_voice_message(self, session_id: str, audio_b64: str, mime_type: str,
                           agent_settings: dict | None = None) -> dict[str, object]:
        session = self._get_session(session_id)
        if not session.alive:
            raise ValueError("No active session")
        cancel = threading.Event()
        session.voice_cancel = cancel
        try:
            iface = SessionTerminal(session)
            reply = process_voice_message(self._decode(audio_b64), mime_type, iface, cancel,
                                          agent_settings=agent_settings or {})
            speech = "\n".join(iface.messages) or reply
            if speech:
                session.push_agent_event("status", "Generating audio...")
            if speech and not iface.messages:
                session.push_agent_event("message", speech)
            return {
                "response": reply,
                "speech": speech,
                "commands": iface.commands,
                "audio": synthesize_speech(speech) if speech else None,
            }
        except CancelledError:
            return {"response": "", "speech": "", "commands": []}
        finally:
            session.voice_cancel = None

    def transcribe_audio(self, audio_b64: str, mime_type: str) -> dict[str, str]:
        return {"text": transcribe_audio(self._decode(audio_b64), mime_type)}

    def cancel_agent(self, session_id: str) -> dict[str, bool]:
        session = self._get_session(session_id)
        cancel = session.voice_cancel
        if cancel:
            cancel.set()
        return {"ok": True}

    def list_sessions(self) -> list[dict[str, object]]:
        with self._lock:
            sessions = list(self._sessions.values())
        result = []
        for s in sessions:
            if not s.alive:
                continue
            result.append({
                "sid": s.sid,
                "title": s.title,
                "path": s.path,
                "cmd": s.cmd,
                "cwd": s.cwd,
                "attached": s._timeout is None,
                "clients": len(s.clients),
            })
        return result

    def rename_session(self, session_id: str, title: str) -> dict[str, object]:
        with self._lock:
            session = self._sessions.get(session_id)
        if session:
            session.title = title
        return {"ok": True}

    def close_session(self, session_id: str) -> dict[str, bool]:
        with self._lock:
            session = self._sessions.pop(session_id, None)
        if session:
            session.cleanup()
        return {"ok": True}

    def mark_detached(self, session_id: str, client_id: str = "") -> None:
        session = self._get_session(session_id)
        if client_id:
            session.remove_client(client_id)
        if session.alive and not session.clients:
            session.start_timeout()

    def shutdown(self) -> None:
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            session.cleanup()
