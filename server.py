#!/usr/bin/env python3
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

from app_core import STATIC_DIR, UPLOAD_DIR, EnvoyService, render_html


WEB_PREFIX = "/envoy"
DEFAULT_HTTP_PORT = int(os.environ.get("ENVOY_HTTP_PORT", "8080"))
DEFAULT_READ_TIMEOUT = float(os.environ.get("ENVOY_READ_TIMEOUT", "20"))
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

            if parsed.path == f"{WEB_PREFIX}/api/config":
                app_path = request_app_path(self)
                json_response(self, 200, service.get_config(app_path))
                return

            if parsed.path == f"{WEB_PREFIX}/api/sessions":
                json_response(self, 200, service.list_sessions())
                return

            if parsed.path == f"{WEB_PREFIX}/api/stream":
                qs = parse_qs(parsed.query)
                session_id = qs.get("session_id", [""])[0]
                client_id = qs.get("client_id", [""])[0]
                with service._lock:
                    session = service._sessions.get(session_id)
                if not session:
                    self.send_error(404)
                    return
                self.close_connection = True
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("X-Accel-Buffering", "no")
                self.send_header("Connection", "close")
                self.end_headers()
                try:
                    while True:
                        if client_id not in session.clients:
                            self.wfile.write(b"event: evicted\ndata: {}\n\n")
                            self.wfile.flush()
                            break
                        if session.alive:
                            session.cancel_timeout()
                        session.last_seen = time.monotonic()
                        output, events, promoted, resize = session.wait_for_client(client_id, 10)
                        if client_id not in session.clients:
                            self.wfile.write(b"event: evicted\ndata: {}\n\n")
                            self.wfile.flush()
                            break
                        if promoted:
                            self.wfile.write(b"event: promoted\ndata: {}\n\n")
                            self.wfile.flush()
                        if resize:
                            rdata = json.dumps({"cols": resize[0], "rows": resize[1]}, separators=(",", ":"))
                            self.wfile.write(f"event: resize\ndata: {rdata}\n\n".encode())
                            self.wfile.flush()
                        if not output and not events and not promoted and not resize and session.alive:
                            self.wfile.write(b": ping\n\n")
                            self.wfile.flush()
                            continue
                        msg = {"output": service._encode(output), "events": events, "alive": session.alive}
                        if not session.alive:
                            msg["exit_code"] = session.exit_code
                        line = json.dumps(msg, separators=(",", ":"))
                        self.wfile.write(f"data: {line}\n\n".encode())
                        self.wfile.flush()
                        if not session.alive:
                            break
                except (BrokenPipeError, ConnectionResetError, OSError):
                    pass
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

                queue: list[tuple[str, str, dict[str, object]]] = []
                ready = threading.Condition()
                registrations: list[tuple[object, str, object]] = []

                def enqueue(session_id: str, client_id: str, payload: dict[str, object]) -> None:
                    with ready:
                        queue.append((session_id, client_id, payload))
                        ready.notify()

                with service._lock:
                    sessions = {sid: service._sessions.get(sid) for sid, _cid in pairs}
                missing = [sid for sid, _cid in pairs if sessions.get(sid) is None]
                if missing:
                    json_response(self, 404, {"error": "No active session", "session_id": missing[0]})
                    return

                self.close_connection = True
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.send_header("X-Accel-Buffering", "no")
                self.send_header("Connection", "close")
                self.end_headers()

                try:
                    for session_id, client_id in pairs:
                        session = sessions[session_id]
                        if session.alive:
                            session.cancel_timeout()
                        session.last_seen = time.monotonic()

                        def callback(payload: dict[str, object], sid=session_id, cid=client_id) -> None:
                            enqueue(sid, cid, payload)

                        initial = session.register_push(client_id, callback)
                        registrations.append((session, client_id, callback))
                        if initial is not None:
                            enqueue(session_id, client_id, initial)

                    while True:
                        with ready:
                            if not queue:
                                ready.wait(10)
                            pending = list(queue)
                            queue.clear()
                        if not pending:
                            self.wfile.write(b": ping\n\n")
                            self.wfile.flush()
                            continue
                        for session_id, client_id, payload in pending:
                            session = sessions.get(session_id)
                            if session and session.alive:
                                session.cancel_timeout()
                                session.last_seen = time.monotonic()
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
                            self.wfile.write(f"data: {line}\n\n".encode())
                        self.wfile.flush()
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
                disposition = "attachment" if download or not info.get("is_image") else "inline"
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

            body = render_html("web", web_prefix=WEB_PREFIX).encode("utf-8")
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

                if parsed.path == f"{WEB_PREFIX}/api/read":
                    body = read_json_body(self)
                    wait_timeout = body.get("wait_timeout", DEFAULT_READ_TIMEOUT)
                    result = service.read(
                        str(body.get("session_id") or ""),
                        str(body.get("client_id") or ""),
                        float(wait_timeout or 0),
                    )
                    json_response(self, 200, result)
                    return

                if parsed.path == f"{WEB_PREFIX}/api/write":
                    body = read_json_body(self)
                    result = service.write(str(body.get("session_id") or ""), str(body.get("data") or ""))
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
                json_response(self, 400, {"error": str(exc)})
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
