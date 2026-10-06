#!/usr/bin/env python3.11
"""Web entrypoint for envoy."""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import threading
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs, quote, urlparse
from websockets.server import ServerProtocol
from websockets.sync.server import ServerConnection

from app_core import STATIC_DIR, UPLOAD_DIR, EnvoyService, render_html


WEB_PREFIX = "/envoy"
DEFAULT_HTTP_PORT = int(os.environ.get("ENVOY_HTTP_PORT", "8080"))
MIME_TYPES = {
    ".css": "text/css",
    ".js": "application/javascript",
    ".json": "application/json",
    ".html": "text/html",
    ".woff2": "font/woff2",
    ".svg": "image/svg+xml",
    ".png": "image/png",
}

service = EnvoyService()


def normalize_app_path(raw_path: str) -> str:
    path = raw_path or "/"
    if not path.startswith("/"):
        path = "/" + path
    return path or "/"


def request_app_path(handler: SimpleHTTPRequestHandler) -> str:
    parsed = urlparse(handler.path)
    query_path = parse_qs(parsed.query).get("path", [""])[0]
    if query_path:
        return normalize_app_path(query_path)
    if parsed.path.startswith(WEB_PREFIX):
        return normalize_app_path(parsed.path[len(WEB_PREFIX):] or "/")
    return "/"


def json_response(handler: SimpleHTTPRequestHandler, code: int, obj: object) -> None:
    payload = json.dumps(obj).encode("utf-8")
    handler.send_response(code)
    handler.send_header("Content-Type", "application/json")
    handler.send_header("Content-Length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


def read_json_body(handler: SimpleHTTPRequestHandler) -> dict[str, object]:
    length = int(handler.headers.get("Content-Length", "0"))
    if length <= 0:
        return {}
    data = handler.rfile.read(length)
    if not data:
        return {}
    return json.loads(data)


def content_disposition(kind: str, filename: str) -> str:
    safe = filename.replace("\\", "_").replace('"', '\\"')
    return f'{kind}; filename="{safe}"; filename*=UTF-8\'\'{quote(filename)}'


def make_handler():
    class Handler(SimpleHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path == "/":
                self.send_response(302)
                self.send_header("Location", f"{WEB_PREFIX}/")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return

            if parsed.path.startswith(f"{WEB_PREFIX}/static/"):
                relpath = parsed.path[len(f"{WEB_PREFIX}/static/"):]
                filepath = os.path.realpath(os.path.join(STATIC_DIR, relpath))
                static_root = os.path.realpath(str(STATIC_DIR))
                if not filepath.startswith(static_root + os.sep) and filepath != static_root:
                    self.send_error(404)
                    return
                if not os.path.isfile(filepath):
                    self.send_error(404)
                    return
                ext = os.path.splitext(filepath)[1]
                with open(filepath, "rb") as handle:
                    body = handle.read()
                self.send_response(200)
                self.send_header("Content-Type", MIME_TYPES.get(ext, "application/octet-stream"))
                self.send_header("Content-Length", str(len(body)))
                if relpath == "sw.js":
                    self.send_header("Service-Worker-Allowed", f"{WEB_PREFIX}/")
                    self.send_header("Cache-Control", "no-cache")
                self.end_headers()
                self.wfile.write(body)
                return

            if parsed.path in (f"{WEB_PREFIX}/ws/transcribe", f"{WEB_PREFIX}/api/transcribe_ws"):
                if self.headers.get("Upgrade", "").lower() == "websocket":
                    req_line = f"{self.command} {self.path} {self.request_version}\r\n"
                    headers_str = "".join(f"{k}: {v}\r\n" for k, v in self.headers.items())
                    raw_req = (req_line + headers_str + "\r\n").encode("latin1")
                    proto = ServerProtocol()
                    proto.receive_data(raw_req)
                    conn = ServerConnection(self.request, proto)
                    for event in proto.events_received():
                        conn.process_event(event)
                    conn.handshake()
                    from voice_chat import stream_transcribe_inworld
                    inworld_key = os.environ.get("INWORLD_API_KEY", "")
                    if not inworld_key:
                        conn.send(json.dumps({"error": "INWORLD_API_KEY is not set"}))
                        conn.close()
                        return
                    stream_transcribe_inworld(conn, inworld_key)
                    return
                self.send_error(400, "WebSocket upgrade required")
                return

            if parsed.path in (f"{WEB_PREFIX}/ws/tts", f"{WEB_PREFIX}/api/tts_ws"):
                if self.headers.get("Upgrade", "").lower() == "websocket":
                    req_line = f"{self.command} {self.path} {self.request_version}\r\n"
                    headers_str = "".join(f"{k}: {v}\r\n" for k, v in self.headers.items())
                    raw_req = (req_line + headers_str + "\r\n").encode("latin1")
                    proto = ServerProtocol()
                    proto.receive_data(raw_req)
                    conn = ServerConnection(self.request, proto)
                    for event in proto.events_received():
                        conn.process_event(event)
                    conn.handshake()
                    try:
                        msg = conn.recv(timeout=10)
                        data = json.loads(msg) if isinstance(msg, str) else json.loads(msg.decode("utf-8"))
                        text = data.get("text", "")
                        voice = data.get("voice", "Ashley")
                    except Exception as e:
                        conn.send(json.dumps({"error": f"Invalid TTS request: {e}"}))
                        conn.close()
                        return

                    from speech import stream_inworld_speech_ws
                    stream_inworld_speech_ws(conn, text, voice=voice)
                    return
                self.send_error(400, "WebSocket upgrade required")
                return

            if parsed.path == f"{WEB_PREFIX}/api/config":
                app_path = request_app_path(self)
                json_response(self, 200, service.get_config(app_path))
                return

            if parsed.path == f"{WEB_PREFIX}/api/sessions":
                qs = parse_qs(parsed.query)
                raw_path = qs.get("path", [None])[0]
                if raw_path is not None and raw_path not in ("all", "*", ""):
                    session_path = normalize_app_path(raw_path)
                else:
                    session_path = None
                json_response(self, 200, service.list_sessions(path=session_path))
                return

            if parsed.path == f"{WEB_PREFIX}/api/stream_all":
                qs = parse_qs(parsed.query)
                pairs = []
                for raw_pair in qs.get("pair", []):
                    if ":" not in raw_pair:
                        continue
                    session_id, client_id = raw_pair.split(":", 1)
                    if session_id and client_id:
                        pairs.append((session_id, client_id))
                if not pairs:
                    self.send_error(400)
                    return

                # `last` carries "<session>:<client>=<id>", the highest SSE event
                # id the browser already applied. A reconnecting stream uses it
                # to resend a frame that reached the socket but never reached the
                # browser.
                acked: dict[tuple[str, str], int] = {}
                for raw_ack in qs.get("last", []):
                    key, sep, raw_id = raw_ack.rpartition("=")
                    if not sep or ":" not in key or not raw_id.isdigit():
                        continue
                    ack_session, ack_client = key.split(":", 1)
                    acked[(ack_session, ack_client)] = int(raw_id)

                # A wakeup carries the client identity and, for notices that do
                # not come from the client's own output buffer (eviction,
                # shutdown), the frame to send. Otherwise the pending bytes stay
                # in the session buffer until the SSE write succeeds.
                wakeups: list[tuple[str, str, dict[str, object] | None]] = []
                ready = threading.Condition()
                registrations: list[tuple[object, str, object]] = []

                def notify_pair(session_id: str, client_id: str,
                                payload: dict[str, object] | None = None) -> None:
                    with ready:
                        wakeups.append((session_id, client_id, payload))
                        ready.notify()

                with service._lock:
                    sessions = {sid: service._sessions.get(sid) for sid, _cid in pairs}

                self.close_connection = True
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("X-Accel-Buffering", "no")
                self.send_header("Connection", "close")
                self.end_headers()

                def encode_frame(session_id: str, client_id: str, seq: int,
                                 payload: dict[str, object]) -> bytes:
                    msg = {
                        "session_id": session_id,
                        "client_id": client_id,
                        "output": service._encode(payload.get("output", b"")),
                        "events": payload.get("events", []),
                        "alive": payload.get("alive", False),
                        "exit_code": payload.get("exit_code"),
                    }
                    if payload.get("evicted"):
                        msg["evicted"] = True
                    if payload.get("promoted"):
                        msg["promoted"] = True
                    if payload.get("resize"):
                        msg["resize"] = payload["resize"]
                    line = json.dumps(msg, separators=(",", ":"))
                    prefix = f"id: {seq}\n" if seq else ""
                    return f"{prefix}data: {line}\n\n".encode()

                def evicted_payload() -> dict[str, object]:
                    return {"output": b"", "events": [], "evicted": True,
                            "alive": False, "exit_code": -1}

                try:
                    # Resend anything a previous stream committed but the
                    # browser never acknowledged.
                    for session_id, client_id in pairs:
                        session = sessions.get(session_id)
                        if session is None:
                            continue
                        last_id = acked.get((session_id, client_id), 0)
                        for _seq, line in session.replay_after(client_id, last_id):
                            self.wfile.write(line.encode())
                    self.wfile.flush()

                    for session_id, client_id in pairs:
                        session = sessions.get(session_id)
                        if session is None:
                            notify_pair(session_id, client_id)
                            continue
                        session.last_seen = time.monotonic()

                        def callback(cid: str, payload: dict[str, object] | None = None,
                                     sid: str = session_id) -> None:
                            notify_pair(sid, cid, payload)

                        registrations.append((session, client_id, callback))
                        if session.register_push(client_id, callback) is not None:
                            notify_pair(session_id, client_id)

                    done_pairs: set[tuple[str, str]] = set()
                    last_ping = time.monotonic()
                    while True:
                        with ready:
                            if not wakeups:
                                # Notifications are normally immediate. Wake
                                # periodically as a fallback for takeovers that
                                # raced registration or a suspended mobile stream.
                                ready.wait(1)
                            pending = list(wakeups)
                            wakeups.clear()

                        # jobs: (session_id, client_id, payload_or_None)
                        jobs: list[tuple[str, str, dict[str, object] | None]] = []
                        notified: set[tuple[str, str]] = set()
                        for session_id, client_id, payload in pending:
                            pair = (session_id, client_id)
                            if pair in done_pairs or pair in notified:
                                continue
                            notified.add(pair)
                            jobs.append((session_id, client_id, payload))
                        for session_id, client_id in pairs:
                            pair = (session_id, client_id)
                            if pair in done_pairs or pair in notified:
                                continue
                            session = sessions.get(session_id)
                            if session is not None:
                                with session._lock:
                                    attached = client_id in session.clients
                                if attached:
                                    continue
                            notified.add(pair)
                            jobs.append((session_id, client_id, evicted_payload()))

                        wrote = False
                        for session_id, client_id, payload in jobs:
                            pair = (session_id, client_id)
                            session = sessions.get(session_id)
                            # `delivered` marks a payload snapshotted from the
                            # client's buffer, which must be committed after a
                            # successful write. Explicit notices (eviction,
                            # shutdown) carry no buffer state.
                            delivered = False
                            if payload is None:
                                if session is None:
                                    payload = evicted_payload()
                                else:
                                    if session.alive:
                                        session.last_seen = time.monotonic()
                                    payload = session.take_delivery(client_id)
                                    if payload is None:
                                        continue
                                    delivered = True
                            seq = session.next_delivery_seq(client_id) if session is not None else 0
                            frame = encode_frame(session_id, client_id, seq, payload)
                            try:
                                self.wfile.write(frame)
                                self.wfile.flush()
                            except (BrokenPipeError, ConnectionResetError, OSError):
                                if delivered:
                                    session.cancel_delivery(client_id)
                                raise
                            if delivered:
                                session.commit_delivery(client_id, payload, seq, frame.decode())
                            elif payload.get("evicted") or not payload.get("alive", True):
                                # Terminal notice: the client is gone or the
                                # session ended, so nothing more will be sent.
                                done_pairs.add(pair)
                            wrote = True

                        if wrote:
                            continue
                        now = time.monotonic()
                        if now - last_ping < 10:
                            continue
                        self.wfile.write(b": ping\n\n")
                        self.wfile.flush()
                        last_ping = now
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass
                finally:
                    for session, client_id, callback in registrations:
                        session.unregister_push(client_id, callback)
                return

            if parsed.path == f"{WEB_PREFIX}/api/settings":
                json_response(self, 200, service.get_settings())
                return

            if parsed.path == f"{WEB_PREFIX}/api/file":
                qs = parse_qs(parsed.query)
                session_id = qs.get("session_id", [""])[0]
                path = qs.get("path", [""])[0]
                download = qs.get("download", [""])[0] == "1"
                try:
                    info, body = service.read_file(session_id, path)
                except ValueError as exc:
                    json_response(self, 404, {"error": str(exc)})
                    return
                disposition = "attachment" if download or not info.get("is_previewable") else "inline"
                self.send_response(200)
                self.send_header("Content-Type", str(info["mime"]))
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Content-Disposition", content_disposition(disposition, str(info["name"])))
                self.send_header("X-Content-Type-Options", "nosniff")
                self.end_headers()
                self.wfile.write(body)
                return

            if not parsed.path.startswith(WEB_PREFIX):
                self.send_error(404)
                return

            body = render_html(web_prefix=WEB_PREFIX).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:
            parsed = urlparse(self.path)
            try:
                if parsed.path == f"{WEB_PREFIX}/api/connect":
                    body = read_json_body(self)
                    app_path = normalize_app_path(str(body.get("path") or request_app_path(self)))
                    result = service.connect(
                        app_path,
                        str(body.get("session_id") or ""),
                        mode=str(body.get("mode") or "takeover"),
                    )
                    json_response(self, 200, result)
                    return

                if parsed.path == f"{WEB_PREFIX}/api/write":
                    body = read_json_body(self)
                    result = service.write(
                        str(body.get("session_id") or ""),
                        str(body.get("data") or ""),
                        client_id=str(body.get("client_id") or ""),
                    )
                    json_response(self, 200, result)
                    return

                if parsed.path == f"{WEB_PREFIX}/api/resize":
                    body = read_json_body(self)
                    result = service.resize(
                        str(body.get("session_id") or ""),
                        int(body.get("cols") or 0),
                        int(body.get("rows") or 0),
                        client_id=str(body.get("client_id") or ""),
                    )
                    json_response(self, 200, result)
                    return

                if parsed.path == f"{WEB_PREFIX}/api/upload":
                    body = read_json_body(self)
                    result = service.upload_file(
                        str(body.get("session_id") or ""),
                        str(body.get("name") or ""),
                        str(body.get("data") or ""),
                    )
                    json_response(self, 200, result)
                    return

                if parsed.path == f"{WEB_PREFIX}/api/upload_file":
                    qs = parse_qs(urlparse(self.path).query)
                    session_id = qs.get("session_id", [""])[0]
                    filename = qs.get("filename", [""])[0]
                    if not session_id or not filename:
                        json_response(self, 400, {"error": "session_id and filename are required"})
                        return
                    length = int(self.headers.get("Content-Length", "0"))
                    file_data = self.rfile.read(length) if length > 0 else b""
                    data_b64 = service._encode(file_data)
                    result = service.upload_file(session_id, filename, data_b64)
                    json_response(self, 200, result)
                    return

                if parsed.path == f"{WEB_PREFIX}/api/resolve_files":
                    body = read_json_body(self)
                    raw_paths = body.get("paths") or []
                    if not isinstance(raw_paths, list):
                        raw_paths = []
                    result = service.resolve_files(
                        str(body.get("session_id") or ""),
                        [str(path) for path in raw_paths],
                    )
                    session_id = str(body.get("session_id") or "")
                    for item in result["files"]:
                        item["url"] = f"{WEB_PREFIX}/api/file?session_id={quote(session_id)}&path={quote(str(item['path']))}"
                        item["download_url"] = item["url"] + "&download=1"
                    json_response(self, 200, result)
                    return

                if parsed.path == f"{WEB_PREFIX}/api/tts":
                    body = read_json_body(self)
                    result = service.synthesize_text(str(body.get("text") or ""))
                    json_response(self, 200, result)
                    return

                if parsed.path == f"{WEB_PREFIX}/api/text":
                    body = read_json_body(self)
                    agent_settings = {
                        k: body[k] for k in ("agent_persistence", "agent_lookback", "agent_turn_limit")
                        if k in body
                    }
                    result = service.send_text_message(
                        str(body.get("session_id") or ""),
                        str(body.get("text") or ""),
                        agent_settings=agent_settings or None,
                    )
                    json_response(self, 200, result)
                    return

                if parsed.path == f"{WEB_PREFIX}/api/transcribe":
                    length = int(self.headers.get("Content-Length", "0"))
                    audio = self.rfile.read(length)
                    mime = self.headers.get("Content-Type", "audio/webm").split(";", 1)[0]
                    result = service.transcribe_audio(service._encode(audio), mime)
                    json_response(self, 200, result)
                    return

                if parsed.path == f"{WEB_PREFIX}/api/voice":
                    length = int(self.headers.get("Content-Length", "0"))
                    audio = self.rfile.read(length)
                    mime = self.headers.get("Content-Type", "audio/webm").split(";", 1)[0]
                    session_id = self.headers.get("X-Session-Id", "")
                    agent_settings = {}
                    for hdr, key in [("X-Agent-Persistence", "agent_persistence"),
                                     ("X-Agent-Lookback", "agent_lookback"),
                                     ("X-Agent-Turn-Limit", "agent_turn_limit")]:
                        val = self.headers.get(hdr, "")
                        if val:
                            agent_settings[key] = int(val) if val.isdigit() else val
                    result = service.send_voice_message(
                        session_id, service._encode(audio), mime,
                        agent_settings=agent_settings or None,
                    )
                    json_response(self, 200, result)
                    return

                if parsed.path == f"{WEB_PREFIX}/api/voice/cancel":
                    body = read_json_body(self)
                    session_id = str(body.get("session_id") or self.headers.get("X-Session-Id", ""))
                    result = service.cancel_agent(session_id)
                    json_response(self, 200, result)
                    return

                if parsed.path == f"{WEB_PREFIX}/api/settings":
                    body = read_json_body(self)
                    result = service.save_settings({str(key): str(value or "") for key, value in body.items()})
                    json_response(self, 200, result)
                    return

                if parsed.path == f"{WEB_PREFIX}/api/rename_session":
                    body = read_json_body(self)
                    result = service.rename_session(
                        str(body.get("session_id") or ""),
                        str(body.get("title") or ""),
                    )
                    json_response(self, 200, result)
                    return

                if parsed.path == f"{WEB_PREFIX}/api/close_session":
                    body = read_json_body(self)
                    result = service.close_session(str(body.get("session_id") or ""))
                    json_response(self, 202, result)
                    return

                if parsed.path == f"{WEB_PREFIX}/api/force_stop_session":
                    body = read_json_body(self)
                    result = service.force_stop_session(str(body.get("session_id") or ""))
                    json_response(self, 200, result)
                    return

                if parsed.path == f"{WEB_PREFIX}/api/resource_limits":
                    body = read_json_body(self)
                    result = service.update_resource_limits(
                        str(body.get("target") or ""),
                        str(body.get("session_id") or ""),
                        body.get("memory_high"),
                        body.get("memory_max"),
                        body.get("memory_swap_max"),
                    )
                    json_response(self, 200, result)
                    return

                if parsed.path == f"{WEB_PREFIX}/api/detach":
                    body = read_json_body(self)
                    service.mark_detached(
                        str(body.get("session_id") or ""),
                        client_id=str(body.get("client_id") or ""),
                    )
                    json_response(self, 200, {"ok": True})
                    return

            except BrokenPipeError:
                return
            except ValueError as exc:
                message = str(exc)
                if message == "Client was evicted":
                    json_response(self, 409, {"error": message, "evicted": True})
                else:
                    json_response(self, 400, {"error": message})
                return
            except Exception as exc:
                logging.exception("Error handling %s", parsed.path)
                try:
                    json_response(self, 500, {"error": str(exc)})
                except BrokenPipeError:
                    pass
                return

            self.send_error(404)

        def log_message(self, *args) -> None:
            pass

    return Handler


class ThreadedHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run envoy as a web app.")
    parser.add_argument("--port", type=int, default=DEFAULT_HTTP_PORT)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    server = ThreadedHTTPServer(("0.0.0.0", args.port), make_handler())

    def shutdown(*_args) -> None:
        threading.Thread(target=lambda: (service.shutdown(), server.shutdown()), daemon=True).start()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    print(f"envoy: http://localhost:{args.port}{WEB_PREFIX}/")
    try:
        server.serve_forever()
    finally:
        service.shutdown()


if __name__ == "__main__":
    main()
