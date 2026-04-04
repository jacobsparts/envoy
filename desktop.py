#!/usr/bin/env python3
"""Desktop entrypoint for envoy using pywebview."""

from __future__ import annotations

import argparse
import os
import signal

import webview

from app_core import DESKTOP_HTML, UPLOAD_DIR, EnvoyService, build_title


class DesktopApi:
    def __init__(self, path: str):
        self.path = path
        self.title = build_title(path)
        self._service = EnvoyService()
        self.window = None

    def get_config(self) -> dict[str, str]:
        return self._service.get_config(self.path)

    def get_settings(self) -> dict[str, dict[str, object]]:
        return self._service.get_settings()

    def save_settings(self, values: dict[str, str]) -> dict[str, object]:
        return self._service.save_settings(values)

    def connect(self, session_id: str = "") -> dict[str, object]:
        return self._service.connect(self.path, session_id)

    def read(self, session_id: str) -> dict[str, object]:
        return self._service.read(session_id)

    def write(self, session_id: str, data_b64: str) -> dict[str, bool]:
        return self._service.write(session_id, data_b64)

    def resize(self, session_id: str, cols: int, rows: int) -> dict[str, bool]:
        return self._service.resize(session_id, cols, rows)

    def upload_file(self, session_id: str, name: str, data_b64: str) -> dict[str, str]:
        return self._service.upload_file(session_id, name, data_b64)

    def send_text_message(self, session_id: str, text: str) -> dict[str, object]:
        return self._service.send_text_message(session_id, text)

    def send_voice_message(self, session_id: str, audio_b64: str, mime_type: str) -> dict[str, object]:
        return self._service.send_voice_message(session_id, audio_b64, mime_type)

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

    def force_shutdown(*_args) -> None:
        try:
            api.shutdown()
        finally:
            os._exit(0)

    signal.signal(signal.SIGINT, force_shutdown)
    signal.signal(signal.SIGTERM, force_shutdown)

    window = webview.create_window(
        api.title,
        DESKTOP_HTML.as_uri(),
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


if __name__ == "__main__":
    main()
