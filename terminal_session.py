"""Helpers for terminal session context and interaction."""

from __future__ import annotations

import os
import re


ANSI_RE = re.compile(r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07)")


def strip_ansi(text: str) -> str:
    return ANSI_RE.sub("", text)


def get_terminal_context(session) -> str:
    raw = session.get_scrollback()
    new_raw = raw[session.voice_scrollback_mark:]
    session.voice_scrollback_mark = len(raw)
    text = strip_ansi(new_raw.decode("utf-8", errors="replace"))
    text = text.replace("\r", "")
    return "\n".join(line.rstrip() for line in text.splitlines())


class SessionTerminal:
    def __init__(self, session):
        self._session = session
        self.messages = []
        self.commands = []

    def get_terminal_context(self) -> str:
        return get_terminal_context(self._session)

    def run_command(self, cmd: str) -> None:
        os.write(self._session.master, (cmd + "\n").encode())
        self.commands.append(cmd)

    def read_output(self) -> str:
        return get_terminal_context(self._session)

    def send_status(self, text: str) -> None:
        self._session.push_agent_event("status", text)

    def send_message(self, text: str) -> None:
        self.messages.append(text)
        self._session.push_agent_event("message", text)
