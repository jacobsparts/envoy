#!/usr/bin/env python3.11
from __future__ import annotations

import base64
import json
import os
import socket
import sys
import threading
import time
import traceback

from app_core import Session


def _start_parent_watchdog(parent_pid: int) -> None:
    def watch() -> None:
        while True:
            time.sleep(1)
            if os.getppid() == 1:
                os._exit(0)
            try:
                os.kill(parent_pid, 0)
            except OSError:
                os._exit(0)
    threading.Thread(target=watch, daemon=True, name="parent-watchdog").start()

_write_lock = threading.Lock()


def _send(control_file, msg: dict[str, object]) -> None:
    data = json.dumps(msg, separators=(",", ":")).encode("utf-8") + b"\n"
    with _write_lock:
        control_file.write(data)
        control_file.flush()


def main() -> None:
    if len(sys.argv) != 6:
        raise SystemExit("usage: pty_worker.py CONTROL_FD INPUT_FD OUTPUT_FD CONFIG_B64 PARENT_PID")
    _start_parent_watchdog(int(sys.argv[5]))

    control_fd = int(sys.argv[1])
    input_fd = int(sys.argv[2])
    output_fd = int(sys.argv[3])
    config = json.loads(base64.b64decode(sys.argv[4]).decode("utf-8"))

    control_sock = socket.socket(fileno=control_fd)
    control_file_r = control_sock.makefile("rb", buffering=0)
    control_file_w = control_sock.makefile("wb", buffering=0)

    def output_callback(data: bytes) -> None:
        if data:
            os.write(output_fd, data)

    session = Session(
        str(config["sid"]),
        str(config["path"]),
        list(config["cmd"]),
        str(config["cwd"]),
        login=bool(config.get("login")),
        extra_env=dict(config.get("extra_env") or {}),
        output_callback=output_callback,
    )

    def input_loop() -> None:
        while True:
            try:
                data = os.read(input_fd, 65536)
            except OSError:
                break
            if not data:
                break
            try:
                session.write(data)
            except OSError:
                break

    threading.Thread(target=input_loop, daemon=True, name="worker-input").start()

    def exit_monitor() -> None:
        session._reader.join()
        try:
            _send(control_file_w, {"type": "exit", "exit_code": session.exit_code})
        except Exception:
            pass
        try:
            os.close(output_fd)
        except OSError:
            pass

    threading.Thread(target=exit_monitor, daemon=True, name="worker-exit-monitor").start()

    try:
        for raw in control_file_r:
            try:
                msg = json.loads(raw.decode("utf-8"))
                req_id = msg.get("id")
                typ = msg.get("type")
                resp: dict[str, object] = {"id": req_id, "ok": True} if req_id is not None else {"ok": True}

                if typ == "snapshot":
                    resp.update({
                        "type": "snapshot_result",
                        "sid": session.sid,
                        "role": msg.get("role", "lead"),
                        "cols": session._pyte_screen.columns,
                        "rows": session._pyte_screen.lines,
                        "title": msg.get("title") or "",
                        "archive_text": session.get_archived_text(),
                        "reconnect_debug": session.get_reconnect_debug(),
                        "output": base64.b64encode(session.get_scrollback()).decode("ascii"),
                        "alive": session.alive,
                        "exit_code": session.exit_code,
                    })
                    if session.title:
                        resp["custom_title"] = session.title
                elif typ == "resize":
                    session.resize(int(msg.get("cols") or 0), int(msg.get("rows") or 0))
                    resp["type"] = "resize_result"
                elif typ == "terminal_state":
                    resp.update({"type": "terminal_state_result", "state": session.get_terminal_state()})
                elif typ == "terminal_lines":
                    resp.update({"type": "terminal_lines_result", "lines": session.get_terminal_lines()})
                elif typ == "execute_action":
                    resp.update({"type": "execute_action_result", "result": session.execute_terminal_action(dict(msg.get("action") or {}))})
                elif typ == "save_upload":
                    content = base64.b64decode(str(msg.get("data") or "").encode("ascii"))
                    resp.update({"type": "save_upload_result", "path": session.save_upload(str(msg.get("name") or ""), content)})
                elif typ == "resolve_files":
                    resp.update({"type": "resolve_files_result", "files": session.resolve_files([str(p) for p in msg.get("paths") or []])})
                elif typ == "resolve_file":
                    info = session.resolve_file(str(msg.get("path") or ""))
                    resp.update({"type": "resolve_file_result", "info": info})
                elif typ == "rename":
                    session.title = str(msg.get("title") or "")
                    resp["type"] = "rename_result"
                elif typ == "close":
                    resp["type"] = "close_result"
                    _send(control_file_w, resp)
                    break
                else:
                    resp.update({"ok": False, "error": f"unknown command: {typ}"})

                if req_id is not None:
                    _send(control_file_w, resp)
            except Exception as exc:
                req_id = None
                try:
                    req_id = json.loads(raw.decode("utf-8")).get("id")
                except Exception:
                    pass
                _send(control_file_w, {
                    "id": req_id,
                    "ok": False,
                    "error": str(exc),
                    "traceback": traceback.format_exc(),
                })
    finally:
        try:
            session.cleanup()
        finally:
            for fd in (input_fd, output_fd):
                try:
                    os.close(fd)
                except OSError:
                    pass


if __name__ == "__main__":
    main()
