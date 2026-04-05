#!/usr/bin/env python3
"""Web entrypoint for envoy."""

from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import threading
from http.server import HTTPServer, SimpleHTTPRequestHandler
from socketserver import ThreadingMixIn
from urllib.parse import parse_qs, urlparse

from app_core import STATIC_DIR, UPLOAD_DIR, WEB_HTML, EnvoyService


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


def make_handler():
    class Handler(SimpleHTTPRequestHandler):
        def do_GET(self) -> None:
            parsed = urlparse(self.path)
            if parsed.path == "/":
                self.send_response(302)
                self.send_header("Location", f"{WEB_PREFIX}/")
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

            if parsed.path == f"{WEB_PREFIX}/api/settings":
                json_response(self, 200, service.get_settings())
                return

            if not parsed.path.startswith(WEB_PREFIX):
                self.send_error(404)
                return

            with open(WEB_HTML, "rb") as handle:
                body = handle.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self) -> None:
            parsed = urlparse(self.path)
            try:
                if parsed.path == f"{WEB_PREFIX}/api/connect":
                    body = read_json_body(self)
                    app_path = normalize_app_path(str(body.get("path") or request_app_path(self)))
                    result = service.connect(app_path, str(body.get("session_id") or ""))
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

                if parsed.path == f"{WEB_PREFIX}/api/close_session":
                    body = read_json_body(self)
                    result = service.close_session(str(body.get("session_id") or ""))
                    json_response(self, 200, result)
                    return

                if parsed.path == f"{WEB_PREFIX}/api/detach":
                    body = read_json_body(self)
                    service.mark_detached(str(body.get("session_id") or ""))
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
