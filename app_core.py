"""Shared runtime core for desktop and envoy server modes."""

from __future__ import annotations

import base64
import collections
import copy
import socket
import fcntl
import os
import pty
import secrets
import shlex
import struct
import subprocess
import termios
import threading
import time
from pathlib import Path

import pyte

from env_config import get_env_settings, save_env_settings
from speech import synthesize_speech
from terminal_session import SessionTerminal
from voice_chat import CancelledError, process_text_message, process_voice_message, transcribe_audio


APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
DESKTOP_HTML = STATIC_DIR / "desktop.html"
WEB_HTML = STATIC_DIR / "index.html"
HOME_DIR = os.path.expanduser("~")
UPLOAD_DIR = os.path.join(APP_DIR, ".envoy_uploads")
ALIASES_FILE = os.path.join(APP_DIR, "aliases.conf")
SCROLLBACK_BUFFER_SIZE = 100_000
SESSION_TIMEOUT = 60 * 60 * 24


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


def resolve_cli(url_path: str) -> tuple[list[str], str]:
    path = "/" + url_path.strip("/")

    aliases = load_aliases()
    if path in aliases:
        parts = shlex.split(aliases[path])
        parts[0] = os.path.expanduser(parts[0])
        cmd_path = os.path.realpath(parts[0])
        if not os.path.isfile(cmd_path):
            raise ValueError(f"Alias target not found: {parts[0]}")
        parts[0] = cmd_path
        return parts, os.path.dirname(cmd_path)

    rel = url_path.strip("/")
    if not rel:
        return ["/bin/bash"], HOME_DIR

    script = os.path.realpath(os.path.join(HOME_DIR, rel))
    if not script.startswith(HOME_DIR + "/"):
        raise ValueError(f"Path escapes home directory: {url_path}")
    if not os.path.isfile(script):
        raise ValueError(f"Not found: {script}")
    return [script], os.path.dirname(script)


def build_title(path: str) -> str:
    clean = "/" + path.strip("/")
    if clean == "/":
        return socket.gethostname()
    return clean.lstrip("/")


class ClientState:
    __slots__ = ("client_id", "role", "output", "events", "promoted", "joined")

    def __init__(self, client_id: str, role: str):
        self.client_id = client_id
        self.role = role  # "lead" or "follow"
        self.output: bytearray = bytearray()
        self.events: list[dict[str, str]] = []
        self.promoted = False
        self.joined = time.monotonic()


class Session:
    def __init__(self, sid: str, path: str, cmd: list[str], cwd: str):
        self.sid = sid
        self.path = path
        self.cmd = list(cmd)
        self.cwd = cwd
        self.title = ""
        self.master, slave = pty.openpty()
        self.proc = subprocess.Popen(
            cmd,
            stdin=slave,
            stdout=slave,
            stderr=slave,
            cwd=cwd,
            start_new_session=True,
            env={**os.environ, "TERM": "xterm-256color", "UPLOAD_DIR": UPLOAD_DIR},
        )
        os.close(slave)
        self.scrollback = collections.deque()
        self.scrollback_bytes = 0
        self.session_files: list[str] = []
        self.alive = True
        self.exit_message = b""
        self.exit_code: int | None = None
        # pyte virtual terminal for agent context
        self._pyte_screen = pyte.HistoryScreen(80, 24, history=50000)
        self._pyte_stream = pyte.Stream(self._pyte_screen)
        self._pyte_known_lines: list[str] = []
        self.voice_cancel: threading.Event | None = None
        self.clients: dict[str, ClientState] = {}
        self.last_seen: float = time.monotonic()
        self._lock = threading.Lock()
        self._pending_ready = threading.Condition(self._lock)
        self._timeout: threading.Timer | None = None
        self._reader = threading.Thread(target=self._read_loop, daemon=True, name=f"pty-{sid}")
        self._reader.start()

    def _append_output(self, data: bytes) -> None:
        self.scrollback.append(data)
        self.scrollback_bytes += len(data)
        while self.scrollback_bytes > SCROLLBACK_BUFFER_SIZE and self.scrollback:
            removed = self.scrollback.popleft()
            self.scrollback_bytes -= len(removed)
        for cs in self.clients.values():
            cs.output.extend(data)
        try:
            self._pyte_stream.feed(data.decode("utf-8", errors="replace"))
        except Exception:
            pass

    def _read_loop(self) -> None:
        try:
            while True:
                try:
                    data = os.read(self.master, 4096)
                except OSError:
                    break
                if not data:
                    break
                with self._lock:
                    self._append_output(data)
                    self._pending_ready.notify_all()
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
            with self._lock:
                self.alive = False
                self.exit_message = message.encode("utf-8")
                self._append_output(self.exit_message)
                self._pending_ready.notify_all()
            self.cancel_timeout()
            try:
                os.close(self.master)
            except OSError:
                pass

    def get_scrollback(self) -> bytes:
        with self._lock:
            return b"".join(self.scrollback)

    def get_terminal_lines(self) -> list[str]:
        """Return rendered lines from pyte: history + current screen."""
        with self._lock:
            screen = self._pyte_screen
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
            return lines

    def reset_context_lookback(self, rows: int) -> None:
        """Reset the context watermark to include the last *rows* lines."""
        lines = self.get_terminal_lines()
        start = max(0, len(lines) - rows)
        self._pyte_known_lines = lines[:start]

    def push_agent_event(self, kind: str, text: str) -> None:
        with self._lock:
            for cs in self.clients.values():
                cs.events.append({"kind": kind, "text": text})
            self._pending_ready.notify_all()

    def add_client(self, client_id: str, role: str) -> ClientState:
        """Add a client under the lock. Caller must hold self._lock."""
        cs = ClientState(client_id, role)
        self.clients[client_id] = cs
        self._pending_ready.notify_all()
        return cs

    def remove_client(self, client_id: str) -> str | None:
        """Remove a client. Returns promoted client_id if a follow was promoted, else None."""
        with self._lock:
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
                    return oldest.client_id
            return None

    def get_lead_client(self) -> ClientState | None:
        """Return the lead client, if any. Caller must hold self._lock or accept races."""
        for cs in self.clients.values():
            if cs.role == "lead":
                return cs
        return None

    def wait_for_client(self, client_id: str, timeout: float) -> tuple[bytes, list[dict[str, str]], bool]:
        """Block until this client has output, events, promotion, or timeout.
        Returns (output_bytes, agent_events, promoted)."""
        deadline = time.monotonic() + max(timeout, 0.0)
        with self._lock:
            cs = self.clients.get(client_id)
            if not cs:
                return b"", [], False
            while self.alive and not cs.output and not cs.events and not cs.promoted:
                if client_id not in self.clients:
                    return b"", [], False
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self._pending_ready.wait(remaining)
            cs = self.clients.get(client_id)
            if not cs:
                return b"", [], False
            data = bytes(cs.output)
            cs.output.clear()
            events = copy.deepcopy(cs.events)
            cs.events.clear()
            promoted = cs.promoted
            cs.promoted = False
            return data, events, promoted

    def write(self, data: bytes) -> None:
        if self.alive:
            os.write(self.master, data)

    def resize(self, cols: int, rows: int) -> None:
        if self.alive:
            winsize = struct.pack("HHHH", rows, cols, 0, 0)
            fcntl.ioctl(self.master, termios.TIOCSWINSZ, winsize)
        with self._lock:
            self._pyte_screen.resize(rows, cols)

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
    def __init__(self):
        self._sessions: dict[str, Session] = {}
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
        cmd, cwd = resolve_cli(path)
        session = Session(self._new_session_id(), path, cmd, cwd)
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
            if session and session.alive:
                session.cancel_timeout()
                client_id = secrets.token_hex(8)
                with session._lock:
                    if mode == "takeover":
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
                        session.clients.clear()
                        session.add_client(client_id, "lead")
                    session._pending_ready.notify_all()
                role = session.clients[client_id].role
                resp = {
                    "sid": session.sid,
                    "client_id": client_id,
                    "role": role,
                    "title": build_title(session.path),
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
            output, events, _ = session.wait_for_client(client_id, wait_timeout)
        elif client_id:
            with session._lock:
                cs = session.clients.get(client_id)
                if not cs:
                    return {"output": "", "alive": False, "evicted": True, "exit_code": -1}
                output = bytes(cs.output)
                cs.output.clear()
                events = copy.deepcopy(cs.events)
                cs.events.clear()
        else:
            output = b""
            events = []
        if client_id and client_id not in session.clients:
            return {"output": "", "alive": False, "evicted": True, "exit_code": -1}
        return {
            "output": self._encode(output),
            "events": events,
            "alive": session.alive,
            "exit_code": session.exit_code,
        }

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
        return {"ok": True}

    def upload_file(self, session_id: str, name: str, data_b64: str) -> dict[str, str]:
        session = self._get_session(session_id)
        path = session.save_upload(name, self._decode(data_b64))
        return {"path": path}

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
