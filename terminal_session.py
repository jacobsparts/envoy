"""Helpers for terminal session context and interaction."""

from __future__ import annotations

import json


def _loads_action_json(action_json: str) -> dict[str, object]:
    try:
        return json.loads(action_json)
    except json.JSONDecodeError:
        return json.loads(action_json.replace("\\x", "\\\\x").replace("\\U", "\\\\U"))



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

    def get_terminal_state(self) -> dict[str, object]:
        return self._session.get_terminal_state()

    def execute_action(self, action_json: str = 'JSON object with exactly one action: {"type":"input","input":"ls -la\\\\r","expect_prompt":"$"} or {"type":"wait"}. For input, ordinary text is UTF-8 encoded and backslash escapes are decoded: \\\\r Enter, \\\\x03 Ctrl-C, \\\\x04 Ctrl-D, \\\\x15 Ctrl-U, \\\\x7f Backspace, \\\\t Tab, \\\\x1b[A arrow up. wait_for_settle is optional and defaults to 0.75 seconds for input actions; set it to a number of seconds to override or false to return immediately. expect_prompt is an optional string expected to appear in the prompt, e.g. "$" for bash, ">>>" for Python.'):
        if isinstance(action_json, str):
            action = _loads_action_json(action_json)
        else:
            action = action_json
        result = self._session.execute_terminal_action(action)
        self.commands.append(action)
        return result

    def send_status(self, text: str) -> None:
        self._session.push_agent_event("status", text)

    def send_message(self, text: str) -> None:
        self.messages.append(text)
        self._session.push_agent_event("message", text)
