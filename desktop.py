#!/usr/bin/env python3
"""Desktop entrypoint for envoy using pywebview."""

from __future__ import annotations

import argparse
import json
import os
import signal
import tempfile
from pathlib import Path

import webview

from app_core import STATIC_DIR, UPLOAD_DIR, EnvoyService, build_title, desktop_inherited_env, render_html


class DesktopApi:
    def __init__(self, path: str):
        self.path = path
        self.title = build_title(path)
        self._service = EnvoyService(extra_env=desktop_inherited_env())
        self.window = None

    def get_config(self) -> dict[str, str]:
        return self._service.get_config(self.path)

    def get_settings(self) -> dict[str, dict[str, object]]:
        return self._service.get_settings()

    def save_settings(self, values: dict[str, str]) -> dict[str, object]:
        return self._service.save_settings(values)

    def connect(self, session_id: str = "") -> dict[str, object]:
        return self._service.connect(self.path, session_id)

    def read(self, session_id: str, client_id: str = "") -> dict[str, object]:
        return self._service.read(session_id, client_id)

    def start_push(self, session_id: str, client_id: str) -> dict[str, bool]:
        session = self._service._get_session(session_id)

        def push(payload: dict[str, object]) -> None:
            if not self.window:
                return
            encoded = dict(payload)
            output = encoded.get("output")
            if isinstance(output, (bytes, bytearray)):
                encoded["output"] = self._service._encode(bytes(output))
            js_arg = json.dumps(json.dumps(encoded, separators=(",", ":")))
            self.window.evaluate_js(f"window.__envoyPush_{client_id}({js_arg})")

        initial = session.register_push(client_id, push)
        if initial:
            push(initial)
        return {"ok": True}

    def stop_push(self, session_id: str, client_id: str) -> dict[str, bool]:
        session = self._service._get_session(session_id)
        session.unregister_push(client_id)
        return {"ok": True}

    def write(self, session_id: str, data_b64: str) -> dict[str, bool]:
        return self._service.write(session_id, data_b64)

    def resize(self, session_id: str, cols: int, rows: int, client_id: str = "") -> dict[str, bool]:
        return self._service.resize(session_id, cols, rows, client_id=client_id)

    def upload_file(self, session_id: str, name: str, data_b64: str) -> dict[str, str]:
        return self._service.upload_file(session_id, name, data_b64)

    def resolve_files(self, session_id: str, paths: list[str]) -> dict[str, object]:
        result = self._service.resolve_files(session_id, paths)
        for item in result["files"]:
            item["url"] = ""
            item["download_url"] = ""
            if item.get("is_image"):
                _info, body = self._service.read_file(session_id, str(item["path"]))
                item["preview_url"] = f"data:{item['mime']};base64,{self._service._encode(body)}"
        return result

    def read_file(self, session_id: str, path: str) -> dict[str, object]:
        info, body = self._service.read_file(session_id, path)
        return {**info, "data": self._service._encode(body)}

    def send_text_message(self, session_id: str, text: str,
                          agent_settings: dict | None = None) -> dict[str, object]:
        return self._service.send_text_message(session_id, text, agent_settings)

    def send_voice_message(self, session_id: str, audio_b64: str, mime_type: str,
                           agent_settings: dict | None = None) -> dict[str, object]:
        return self._service.send_voice_message(session_id, audio_b64, mime_type, agent_settings)

    def transcribe_audio(self, audio_b64: str, mime_type: str) -> dict[str, str]:
        return self._service.transcribe_audio(audio_b64, mime_type)

    def cancel_agent(self, session_id: str) -> dict[str, bool]:
        return self._service.cancel_agent(session_id)

    def close_session(self, session_id: str) -> dict[str, bool]:
        return self._service.close_session(session_id)

    def toggle_fullscreen(self) -> dict[str, bool]:
        if self.window:
            self.window.toggle_fullscreen()
        return {"ok": True}

    def close_app(self) -> dict[str, bool]:
        if self.window:
            self.window.destroy()
        return {"ok": True}

    def shutdown(self) -> None:
        self._service.shutdown()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run envoy as a local desktop app.")
    parser.add_argument(
        "path",
        nargs="?",
        default="/",
        help="Alias or path under $HOME to launch. Defaults to / for an interactive shell.",
    )
    parser.add_argument("--width", type=int, default=1280)
    parser.add_argument("--height", type=int, default=820)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    api = DesktopApi(args.path)

    rendered = render_html("desktop")
    html_file = tempfile.NamedTemporaryFile(
        mode="w",
        encoding="utf-8",
        suffix=".html",
        dir=str(STATIC_DIR),
        delete=False,
    )
    html_file.write(rendered)
    html_file.close()
    html_path = html_file.name

    def cleanup_html() -> None:
        try:
            os.unlink(html_path)
        except OSError:
            pass

    def force_shutdown(*_args) -> None:
        try:
            api.shutdown()
        finally:
            cleanup_html()
            os._exit(0)

    signal.signal(signal.SIGINT, force_shutdown)
    signal.signal(signal.SIGTERM, force_shutdown)

    window = webview.create_window(
        api.title,
        Path(html_path).as_uri(),
        js_api=api,
        width=args.width,
        height=args.height,
        min_size=(720, 480),
        text_select=True,
    )
    api.window = window
    window.events.closed += force_shutdown
    icon_path = os.path.join(os.path.dirname(__file__), "static", "icon-512.png")
    try:
        webview.start(gui="qt", icon=icon_path)
    finally:
        api.shutdown()
        cleanup_html()


if __name__ == "__main__":
    main()
