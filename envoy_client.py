"""General-purpose Python client for terminal sessions hosted by Envoy."""

from __future__ import annotations

import abc
import asyncio
import base64
import codecs
import json
import logging
import re
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass
from typing import Any, Callable, Optional
from urllib.parse import quote

import requests


logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class EnvoyConfig:
    base_url: str
    path: str = "/"
    token: str = ""
    title: str = ""
    resume_existing: bool = True
    bracketed_paste: bool = True
    prompt_pattern: str = r"(?:^|\n)[^\n]*[#$%>]\s*$"


@dataclass(frozen=True)
class TerminalSnapshot:
    session_id: str
    output: str
    settled: bool = True
    timed_out: bool = False


@dataclass(frozen=True)
class PromptMetadata:
    kind: str
    text: str


OutputListener = Optional[Callable[[str], None]]


class EnvoyTransport(abc.ABC):
    @abc.abstractmethod
    def has_session(self) -> bool:
        raise NotImplementedError

    @abc.abstractmethod
    def set_output_listener(self, listener: OutputListener) -> None:
        raise NotImplementedError

    @abc.abstractmethod
    async def start(self, force_new: bool) -> TerminalSnapshot:
        raise NotImplementedError

    @abc.abstractmethod
    async def send(self, input: str) -> TerminalSnapshot:
        raise NotImplementedError

    @abc.abstractmethod
    async def poll(self) -> TerminalSnapshot:
        raise NotImplementedError

    @abc.abstractmethod
    async def control(self, name: str) -> TerminalSnapshot:
        raise NotImplementedError

    @abc.abstractmethod
    async def close(self) -> TerminalSnapshot:
        raise NotImplementedError

    @abc.abstractmethod
    def has_pending_output(self) -> bool:
        raise NotImplementedError

    @abc.abstractmethod
    def current_prompt_metadata(self, settled: bool) -> PromptMetadata:
        raise NotImplementedError




class EnvoyClient(EnvoyTransport):
    def __init__(
        self,
        config: EnvoyConfig,
        *,
        http_session: Optional[requests.Session] = None,
    ) -> None:
        self.config = config
        self._client = http_session or requests.Session()
        self._lock = threading.RLock()
        self._output = ""
        self._pending_output = ""
        self._stream_generation = 0
        self._session_id = ""
        self._client_id = str(uuid.uuid4())
        self._stream_thread: Optional[threading.Thread] = None
        self._stream_response: Optional[requests.Response] = None
        self._stream_failure: Optional[BaseException] = None
        self._stream_closed = False
        self._last_stream_connected_at = 0
        self._last_stream_event_at = 0
        self._last_output_at = 0
        self._awaiting_prompt = False
        self._output_listener: OutputListener = None

    def has_session(self) -> bool:
        return bool(self._session_id.strip())

    def set_output_listener(self, listener: OutputListener) -> None:
        self._output_listener = listener

    async def start(self, force_new: bool) -> TerminalSnapshot:
        return await asyncio.to_thread(self._start_sync, force_new)

    def _start_sync(self, force_new: bool) -> TerminalSnapshot:
        base_url = normalize_base_url(self.config.base_url)
        if not base_url:
            raise ValueError("Envoy base URL is not configured.")
        if not force_new and self._session_id:
            if not self._stream_thread or not self._stream_thread.is_alive() or self._stream_closed:
                self._start_stream(base_url)
            current_output = self._recent_output()
            with self._lock:
                self._pending_output = ""
            return TerminalSnapshot(self._session_id, current_output)

        session_path = self.config.path.strip() or "/"
        if force_new:
            self._close_sync()
            self._stop_stream()
            with self._lock:
                self._output = ""
                self._pending_output = ""
            self._session_id = ""
            self._client_id = str(uuid.uuid4())

        existing_session_id = ""
        if not force_new and self.config.resume_existing:
            existing_session_id = self._session_id or self._find_existing_session(base_url, session_path)
        requested_client_id = self._client_id or str(uuid.uuid4())
        connect_json = self._post_json(
            f"{base_url}/api/connect",
            {
                "path": session_path,
                "session_id": existing_session_id,
                "client_id": requested_client_id,
                "mode": "takeover" if not existing_session_id else "lead",
            },
        )
        session_id = str(connect_json.get("sid") or connect_json.get("session_id") or "")
        if not session_id:
            raise ValueError("Envoy connect returned no session ID.")
        self._session_id = session_id
        self._client_id = str(connect_json.get("client_id") or requested_client_id)
        logger.debug(
            "Envoy connected session_id=%s client_id=%s role=%s force_new=%s",
            self._session_id,
            self._client_id,
            connect_json.get("role", ""),
            force_new,
        )
        self._stream_closed = False
        self._stream_failure = None
        if self.config.title.strip():
            self._rename_session(base_url, session_id, self.config.title.strip())
        with self._lock:
            self._output = ""
            connect_output = self._append_connect_snapshot(connect_json)
        if connect_output.strip() and not existing_session_id:
            self._notify(clean_terminal_output(connect_output))
        self._start_stream(base_url)
        return self._wait_for_settled_output(0, 1000, 3000)

    async def send(self, input: str) -> TerminalSnapshot:
        return await asyncio.to_thread(self._send_sync, input)

    def _send_sync(self, input: str) -> TerminalSnapshot:
        self._ensure_session()
        base_url = normalize_base_url(self.config.base_url)
        self._ensure_stream_running(base_url)
        if input:
            normalized = input.replace("\r\n", "\n").replace("\r", "\n")
            self._write_bytes(
                base_url,
                terminal_submission_bytes(normalized, self.config.bracketed_paste),
            )
        return TerminalSnapshot(self._session_id, "")

    async def poll(self) -> TerminalSnapshot:
        return await asyncio.to_thread(self._poll_sync)

    def _poll_sync(self) -> TerminalSnapshot:
        self._ensure_session()
        self._ensure_stream_running(normalize_base_url(self.config.base_url))
        return self._drain_pending_output_snapshot()

    async def control(self, name: str) -> TerminalSnapshot:
        controls = {
            "ctrl_c": b"\x03", "ctrl-c": b"\x03", "c": b"\x03",
            "ctrl_d": b"\x04", "ctrl-d": b"\x04", "d": b"\x04",
            "escape": b"\x1b", "esc": b"\x1b",
            "enter": b"\r", "newline": b"\r", "tab": b"\t",
        }
        try:
            data = controls[name.lower()]
        except KeyError as error:
            raise ValueError(f"Unsupported control character: {name}") from error
        return await asyncio.to_thread(self._send_raw_sync, data)

    def _send_raw_sync(self, data: bytes) -> TerminalSnapshot:
        self._ensure_session()
        base_url = normalize_base_url(self.config.base_url)
        self._ensure_stream_running(base_url)
        self._write_bytes(base_url, data)
        return TerminalSnapshot(self._session_id, "")

    async def close(self) -> TerminalSnapshot:
        return await asyncio.to_thread(self._close_sync)

    def _close_sync(self) -> TerminalSnapshot:
        if not self._session_id:
            return TerminalSnapshot("", "")
        old_session_id = self._session_id
        base_url = normalize_base_url(self.config.base_url)
        self._stop_stream()
        self._close_session_id(base_url, old_session_id)
        self._session_id = ""
        self._awaiting_prompt = False
        return TerminalSnapshot(old_session_id, clean_terminal_output(self._recent_output()))

    def has_pending_output(self) -> bool:
        with self._lock:
            return bool(self._pending_output.strip())

    def current_prompt_metadata(self, settled: bool) -> PromptMetadata:
        if not settled:
            return PromptMetadata("working", "")
        if not self._session_id:
            return PromptMetadata("none", "")
        with self._lock:
            output = self._output
        return prompt_metadata(self._session_id, output, True, self.config.prompt_pattern)

    def _append_connect_snapshot(self, connect_json: dict[str, Any]) -> str:
        archive_text = str(connect_json.get("archive_text") or "")
        output_text = ""
        encoded = str(connect_json.get("output") or "")
        if encoded:
            try:
                output_text = base64.b64decode(encoded).decode("utf-8")
            except (ValueError, UnicodeDecodeError):
                pass
        connect_output = ""
        if archive_text:
            connect_output += strip_bracketed_paste_controls(archive_text)
            if not archive_text.endswith("\n"):
                connect_output += "\n"
        if output_text:
            connect_output += strip_bracketed_paste_controls(output_text)
        if connect_output:
            self._output += connect_output
            self._last_output_at = _now_ms()
        return connect_output

    def _start_stream(self, base_url: str) -> None:
        if not self._session_id or not self._client_id:
            return
        self._stop_stream()
        with self._lock:
            self._stream_generation += 1
            generation = self._stream_generation
        self._stream_closed = True
        self._stream_failure = None

        def stream_worker() -> None:
            attempt = 0
            while self._generation_is_current(generation) and self._session_id:
                response: Optional[requests.Response] = None
                try:
                    response = self._client.get(
                        f"{base_url}/api/stream?session_id={quote(self._session_id, safe='')}"
                        f"&client_id={quote(self._client_id, safe='')}",
                        headers=self._headers(),
                        stream=True,
                        timeout=(15, None),
                    )
                    self._stream_response = response
                    if not response.ok:
                        body = response.text
                        if response.status_code in (404, 410):
                            self._clear_stale_session()
                            break
                        raise IOError(f"Envoy stream failed: HTTP {response.status_code} {body}")
                    self._stream_closed = False
                    self._stream_failure = None
                    attempt = 0
                    self._last_stream_connected_at = _now_ms()
                    logger.debug(
                        "Envoy stream connected session_id=%s client_id=%s generation=%s",
                        self._session_id,
                        self._client_id,
                        generation,
                    )
                    self._consume_sse(response, generation)
                    if self._generation_is_current(generation):
                        raise IOError("Envoy stream ended")
                except BaseException as error:
                    if self._generation_is_current(generation):
                        self._stream_failure = error
                        self._stream_closed = True
                        logger.warning(
                            "Envoy stream failure session_id=%s client_id=%s generation=%s",
                            self._session_id,
                            self._client_id,
                            generation,
                            exc_info=error,
                        )
                finally:
                    if response is not None:
                        response.close()
                    if self._generation_is_current(generation):
                        self._stream_response = None
                        self._stream_closed = True
                if not self._generation_is_current(generation) or not self._session_id:
                    break
                attempt += 1
                time.sleep(reconnect_backoff_millis(attempt) / 1000)

        thread = threading.Thread(target=stream_worker, name="EnvoyClientStream", daemon=True)
        self._stream_thread = thread
        thread.start()

    def _consume_sse(self, response: requests.Response, generation: int) -> None:
        decoder = codecs.getincrementaldecoder("utf-8")()
        buffer = ""
        event_lines: list[str] = []
        for chunk in response.iter_content(chunk_size=1):
            if not self._generation_is_current(generation):
                return
            if not chunk:
                continue
            buffer += decoder.decode(chunk)
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                line = line.removesuffix("\r")
                self._last_stream_event_at = _now_ms()
                if not line:
                    self._handle_sse_event(event_lines)
                    event_lines.clear()
                else:
                    event_lines.append(line)
        buffer += decoder.decode(b"", final=True)
        if buffer:
            event_lines.append(buffer.removesuffix("\r"))
        if event_lines:
            self._handle_sse_event(event_lines)

    def _stop_stream(self) -> None:
        with self._lock:
            self._stream_generation += 1
        self._stream_closed = True
        response = self._stream_response
        self._stream_response = None
        if response is not None:
            response.close()
        self._stream_thread = None

    def _generation_is_current(self, generation: int) -> bool:
        with self._lock:
            return generation == self._stream_generation

    def _clear_stale_session(self) -> None:
        with self._lock:
            self._session_id = ""
            self._client_id = ""
            self._pending_output = ""
        self._stream_closed = True
        self._stream_failure = IOError("Envoy session no longer exists")
        if self._stream_response is not None:
            self._stream_response.close()

    def _handle_sse_event(self, lines: list[str]) -> None:
        if not lines:
            return
        event_name = "message"
        data: list[str] = []
        for line in lines:
            if line.startswith(":"):
                continue
            if line.startswith("event:"):
                event_name = line.partition(":")[2].strip()
            elif line.startswith("data:"):
                data.append(line.partition(":")[2].lstrip())
        if event_name == "evicted":
            logger.warning(
                "Envoy stream evicted session_id=%s client_id=%s",
                self._session_id,
                self._client_id,
            )
            self._stream_closed = True
            self._stream_failure = IOError("Envoy stream was evicted")
            if self._stream_response is not None:
                self._stream_response.close()
            return
        if event_name in {"promoted", "resize"}:
            return
        payload = "\n".join(data)
        if not payload.strip():
            return
        try:
            root = json.loads(payload)
        except (TypeError, json.JSONDecodeError):
            return
        if root.get("alive") is False:
            self._stream_closed = True
            self._stream_failure = IOError("Envoy stream reported alive=false")
            if self._stream_response is not None:
                self._stream_response.close()
            return
        encoded = str(root.get("output") or root.get("data") or "")
        if not encoded:
            return
        try:
            decoded = base64.b64decode(encoded).decode("utf-8")
        except (ValueError, UnicodeDecodeError):
            return
        cleaned = strip_bracketed_paste_controls(decoded)
        if not cleaned.strip():
            return
        logger.debug(
            "Envoy stream output session_id=%s client_id=%s decoded_bytes=%s cleaned_chars=%s",
            self._session_id,
            self._client_id,
            len(decoded.encode("utf-8")),
            len(cleaned),
        )
        with self._lock:
            self._output += cleaned
            self._pending_output += cleaned
            self._last_output_at = _now_ms()
        self._notify(clean_terminal_output(cleaned))

    def _ensure_stream_running(self, base_url: str) -> None:
        if self._session_id and (
            not self._stream_thread or not self._stream_thread.is_alive() or self._stream_closed
        ):
            self._start_stream(base_url)

    def _receive_pending_output(
        self,
        idle_millis: int,
        timeout_millis: int,
        require_prompt: bool,
    ) -> TerminalSnapshot:
        started = _now_ms()
        while _now_ms() - started < timeout_millis:
            now = _now_ms()
            with self._lock:
                has_output = bool(self._pending_output)
                prompt_returned_value = self._prompt_returned(self._pending_output)
            if (
                has_output
                and (not require_prompt or prompt_returned_value)
                and now - self._last_output_at >= idle_millis
            ):
                return self._drain_pending_output_snapshot(
                    settled_override=prompt_returned_value or not require_prompt,
                    timed_out_override=False,
                )
            time.sleep(0.1)
        return self._drain_pending_output_snapshot()

    def _drain_pending_output_snapshot(
        self,
        settled_override: Optional[bool] = None,
        timed_out_override: Optional[bool] = None,
    ) -> TerminalSnapshot:
        with self._lock:
            text = self._pending_output
            self._pending_output = ""
            full_output = self._output
        if settled_override is not None:
            settled = settled_override
        elif self._awaiting_prompt:
            settled = self._prompt_returned(text)
        else:
            settled = self._prompt_returned(full_output)
        if settled:
            self._awaiting_prompt = False
        timed_out = not settled if timed_out_override is None else timed_out_override
        return TerminalSnapshot(
            self._session_id,
            clean_terminal_output(text),
            settled,
            timed_out,
        )

    def _wait_for_settled_output(
        self,
        min_new_chars: int,
        idle_millis: int,
        timeout_millis: int,
        started_at: Optional[int] = None,
        require_prompt: bool = True,
    ) -> TerminalSnapshot:
        initial_time = _now_ms() if started_at is None else started_at
        started = _now_ms()
        while _now_ms() - started < timeout_millis:
            now = _now_ms()
            with self._lock:
                has_new_output = len(self._output) > min_new_chars
            if (
                has_new_output
                and (self._last_output_at > initial_time or not require_prompt)
                and now - self._last_output_at >= idle_millis
                and (not require_prompt or self._prompt_returned_since(min_new_chars))
            ):
                return TerminalSnapshot(self._session_id, self._output_since(min_new_chars))
            time.sleep(0.1)
        return TerminalSnapshot(
            self._session_id,
            self._output_since(min_new_chars),
            settled=False,
            timed_out=True,
        )

    def _prompt_returned_since(self, offset: int) -> bool:
        with self._lock:
            if len(self._output) <= offset:
                return False
            text = self._output[offset:]
        return self._prompt_returned(text)

    def _output_since(self, offset: int, max_chars: int = 12_000) -> str:
        with self._lock:
            safe_offset = min(max(offset, 0), len(self._output))
            text = self._output[safe_offset:]
        if len(text) > max_chars:
            text = text[-max_chars:]
        return clean_terminal_output(text)

    def _prompt_returned(self, text: str) -> bool:
        return prompt_returned(text, self.config.prompt_pattern)

    def _write_bytes(self, base_url: str, data: bytes) -> None:
        logger.debug(
            "Envoy write session_id=%s client_id=%s bytes=%s",
            self._session_id,
            self._client_id,
            len(data),
        )
        self._post_json(
            f"{base_url}/api/write",
            {"session_id": self._session_id, "data": base64.b64encode(data).decode("ascii")},
        )

    def _find_existing_session(self, base_url: str, path: str) -> str:
        sessions = self._load_sessions(base_url)
        for item in sessions or []:
            if item.get("path") == path:
                return str(item.get("sid") or item.get("id") or item.get("session_id") or "")
        return ""

    def _load_sessions(self, base_url: str) -> Optional[list[dict[str, Any]]]:
        try:
            response = self._client.get(
                f"{base_url}/api/sessions",
                headers=self._headers(),
                timeout=(15, 15),
            )
            if not response.ok:
                return None
            payload = response.json()
            if isinstance(payload, list):
                return payload
            if isinstance(payload, dict) and isinstance(payload.get("sessions"), list):
                return payload["sessions"]
        except (requests.RequestException, ValueError):
            return None
        return None

    def _rename_session(self, base_url: str, session_id: str, title: str) -> None:
        try:
            self._post_json(
                f"{base_url}/api/rename_session",
                {"session_id": session_id, "title": title},
            )
        except Exception:
            pass

    def _close_session_id(self, base_url: str, session_id: str) -> None:
        if not session_id:
            return
        try:
            self._post_json(f"{base_url}/api/close_session", {"session_id": session_id})
        except Exception:
            pass

    def _post_json(self, url: str, body: dict[str, Any]) -> dict[str, Any]:
        response = self._client.post(
            url,
            json=body,
            headers=self._headers(),
            timeout=(15, 30),
        )
        if not response.ok:
            raise IOError(f"Envoy request failed: HTTP {response.status_code} {response.text}")
        if not response.text.strip():
            return {}
        payload = response.json()
        if not isinstance(payload, dict):
            raise ValueError("Envoy returned a non-object JSON response.")
        return payload

    def _headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.config.token}"} if self.config.token.strip() else {}

    def _ensure_session(self) -> None:
        if not self._session_id:
            raise RuntimeError("Envoy session has not been started.")

    def _recent_output(self) -> str:
        with self._lock:
            return self._output

    def _notify(self, output: str) -> None:
        listener = self._output_listener
        if listener:
            listener(output)




def terminal_submission_bytes(input: str, bracketed_paste_enabled: bool) -> bytes:
    normalized = input.replace("\r\n", "\n").replace("\r", "\n")
    if "\n" not in normalized:
        return f"{normalized}\r".encode()
    if not bracketed_paste_enabled:
        raise ValueError("Multiline terminal input requires bracketed paste support.")
    return f"\x1b[200~{normalized}\x1b[201~\r".encode()


def prompt_metadata(
    session_id: str,
    output: str,
    settled: bool,
    prompt_pattern: str = r"(?:^|\n)[^\n]*[#$%>]\s*$",
) -> PromptMetadata:
    if not settled:
        return PromptMetadata("working", "")
    if not session_id:
        return PromptMetadata("none", "")
    cleaned = clean_terminal_output(output)
    lines = [line.strip() for line in cleaned.splitlines() if line.strip()]
    if not lines:
        return PromptMetadata("unknown", "")
    prompt_text = "\n".join(lines[-5:])[-1000:]
    kind = "prompt" if prompt_returned(cleaned, prompt_pattern) else "unknown"
    return PromptMetadata(kind, prompt_text)


def prompt_returned(
    text: str,
    prompt_pattern: str = r"(?:^|\n)[^\n]*[#$%>]\s*$",
) -> bool:
    if not prompt_pattern:
        return False
    return bool(re.search(prompt_pattern, clean_terminal_output(text)))


def strip_bracketed_paste_controls(text: str) -> str:
    return (
        text.replace("\x1b[200~", "")
        .replace("\x1b[201~", "")
        .replace("^[[200~", "")
        .replace("^[[201~", "")
    )


def clean_terminal_output(raw: str) -> str:
    text = strip_bracketed_paste_controls(raw)
    text = re.sub(r"\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)", "", text)
    text = re.sub(r"\x1b[PX^_].*?(?:\x1b\\|\x07)", "", text, flags=re.DOTALL)
    text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", text)
    text = re.sub(r"\x1b[()][A-Za-z0-9]", "", text)
    text = re.sub(r"\x1b[@-Z\\-_]", "", text)
    text = text.replace("\x0f", "").replace("\x0e", "")
    rendered = render_terminal_controls(text)
    lines = [re.sub(r"[\x00-\x08\x0b\x0c\x10-\x1f\x7f]", "", line).rstrip() for line in rendered.splitlines()]
    return "\n".join(lines).strip()


def render_terminal_controls(text: str) -> str:
    lines: list[str] = []
    current: list[str] = []
    column = 0
    for char in text:
        if char == "\r":
            column = 0
        elif char == "\n":
            lines.append("".join(current))
            current = []
            column = 0
        elif char == "\b":
            column = max(column - 1, 0)
        elif char == "\t":
            for _ in range(4 - column % 4):
                while len(current) < column:
                    current.append(" ")
                if column < len(current):
                    current[column] = " "
                else:
                    current.append(" ")
                column += 1
        elif not _is_control(char):
            while len(current) < column:
                current.append(" ")
            if column < len(current):
                current[column] = char
            else:
                current.append(char)
            column += 1
    if current:
        lines.append("".join(current))
    return "\n".join(lines)


def normalize_base_url(value: str) -> str:
    return value.strip().rstrip("/")


def reconnect_backoff_millis(attempt: int) -> int:
    if attempt <= 1:
        return 250
    if attempt == 2:
        return 500
    if attempt == 3:
        return 1000
    if attempt == 4:
        return 2000
    return 5000


def _is_control(char: str) -> bool:
    code = ord(char)
    return code < 32 or 127 <= code <= 159


def _now_ms() -> int:
    return int(time.time() * 1000)


__all__ = [
    "EnvoyClient",
    "EnvoyConfig",
    "EnvoyTransport",
    "PromptMetadata",
    "TerminalSnapshot",
    "clean_terminal_output",
    "normalize_base_url",
    "prompt_metadata",
    "prompt_returned",
    "reconnect_backoff_millis",
    "render_terminal_controls",
    "strip_bracketed_paste_controls",
    "terminal_submission_bytes",
]
