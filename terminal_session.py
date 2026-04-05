"""Helpers for terminal session context and interaction."""

from __future__ import annotations

import os


def get_terminal_context(session) -> str:
    """Return new terminal content since last call, rendered via pyte.

    Compares the current screen state (history + active screen) against
    the snapshot from the previous call.  Returns everything from the
    first line that differs onward, which for typical shell usage means
    just the latest command and its output.
    """
    lines = session.get_terminal_lines()
    known = session._pyte_known_lines
    # Find first divergence between known and current
    prefix_len = 0
    for i in range(min(len(known), len(lines))):
        if known[i] == lines[i]:
            prefix_len = i + 1
        else:
            break
    new_lines = lines[prefix_len:]
    session._pyte_known_lines = list(lines)
    # Strip trailing empty lines
    while new_lines and not new_lines[-1]:
        new_lines.pop()
    return "\n".join(new_lines)


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
