#!/usr/bin/env python3.11
"""Per-session PTY worker.

The worker owns one terminal session: it holds the PTY and the child process,
and it owns three private UNIX sockets that Envoy connects to as a client:

    control.sock   request/response commands + asynchronous events
    input.sock     raw bytes written to the PTY
    output.sock    raw PTY output

The worker never depends on the web process being alive. It exits when:

    * the child exits (drain output, report the exit code, unlink sockets)
    * it receives an explicit ``close`` control command
    * it receives SIGTERM/SIGINT

Envoy may restart at any time and rebuild its view of the session from a
snapshot: PTY output produced while no web process was connected is retained
in the worker's scrollback/archive, which is what the snapshot returns.
"""

from __future__ import annotations

import base64
import json
import os
import signal
import socket
import struct
import sys
import threading
import time

from app_core import Session, encode_output_frame

# Control replies are small; a client this far behind is broken, not slow.
CONTROL_CLIENT_QUEUE_BYTES = 8 * 1024 * 1024
ACCEPT_TIMEOUT = 1.0
SHUTDOWN_DRAIN_SECONDS = 3.0
# Grace period for the PTY reader to flush the child's final output on exit.
EXIT_FLUSH_SECONDS = 2.0


def _json_line(payload: dict) -> bytes:
    return json.dumps(payload, separators=(",", ":")).encode("utf-8") + b"\n"


class ControlConnection:
    """One web-side control reader/writer."""

    def __init__(self, conn: socket.socket):
        self.conn = conn
        self._lock = threading.Lock()
        self._queued_bytes = 0
        self._closed = False

    def send(self, message: dict) -> None:
        data = _json_line(message)
        with self._lock:
            if self._closed:
                return
            if self._queued_bytes + len(data) > CONTROL_CLIENT_QUEUE_BYTES:
                self._closed = True
                try:
                    self.conn.close()
                except OSError:
                    pass
                return
            self._queued_bytes += len(data)
        try:
            self.conn.sendall(data)
        except OSError:
            self.close()
        finally:
            with self._lock:
                self._queued_bytes -= len(data)

    def close(self) -> None:
        with self._lock:
            self._closed = True
        try:
            self.conn.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.conn.close()
        except OSError:
            pass


class OutputChannel:
    """The session's single output connection to Envoy.

    Invariants:

    * Exactly one Envoy attaches at a time. There is no fan-out and no queue: the
      PTY reader thread writes straight to the socket.
    * While no Envoy is attached, or while a chunk is only partly written, the
      PTY reader blocks. A child that keeps producing output therefore cannot
      outrun a slow or absent reader, and no chunk is ever discarded.
    * A chunk that fails mid-write is retained rather than dropped, and a new
      peer receives it from its first byte. Bytes an earlier peer accepted but
      never read are covered by the session scrollback as well, which is what
      Envoy repaints from a snapshot when it reconnects, so re-sending them can
      at most repaint output Envoy already has - it can never leave a hole.

    Losing a peer is therefore a non-event: the PTY reader simply blocks until
    the next Envoy attaches, and the snapshot covers everything in between.
    """

    def __init__(self) -> None:
        self._cond = threading.Condition()
        self._conn: socket.socket | None = None
        self._pending: bytes = b""
        self._sent: int = 0
        self._released = False
        self._closed = False
        # Sockets with a send() currently inside them, and sockets that must be
        # closed once their send() returns. A socket with a send in flight may
        # only be shutdown(): closing it frees the descriptor, and the kernel can
        # hand that same number to an unrelated socket while the parked send() is
        # still writing through it.
        self._sending: set[socket.socket] = set()
        self._retired: set[socket.socket] = set()

    # -- lifecycle ---------------------------------------------------------

    def attach(self, conn: socket.socket) -> None:
        """Become the output reader for a fresh peer.

        ``_sent`` counted bytes accepted by the previous socket, so it says
        nothing about this one: rewinding it makes the retained chunk go out in
        full instead of leaving the new peer with the tail of a chunk whose
        beginning it never received.
        """
        with self._cond:
            previous = self._conn
            self._conn = conn
            self._sent = 0
            self._cond.notify_all()
            close_now = self._retire_locked(previous, conn)
        self._close_sockets(close_now)

    def detach(self, conn: socket.socket) -> None:
        with self._cond:
            if self._conn is conn:
                self._conn = None
            close_now = self._retire_locked(conn, None)
            self._cond.notify_all()
        self._close_sockets(close_now)

    def release(self) -> None:
        """Stop blocking the PTY reader (child exit, shutdown, signal)."""
        with self._cond:
            self._released = True
            self._cond.notify_all()

    def close(self) -> None:
        with self._cond:
            self._closed = True
            conn = self._conn
            self._conn = None
            self._pending = b""
            self._sent = 0
            close_now = self._retire_locked(conn, None)
            self._cond.notify_all()
        self._close_sockets(close_now)

    @staticmethod
    def _close_sockets(socks: list[socket.socket] | None) -> None:
        for sock in socks or ():
            try:
                sock.close()
            except OSError:
                pass

    def _retire_locked(self, conn: socket.socket | None,
                       keep: socket.socket | None) -> list[socket.socket]:
        """Stop using `conn`, deferring its close while a send is inside it.

        Caller holds ``self._cond``. Returns the sockets that are safe to close
        right now; anything with an in-flight ``send()`` is shut down instead so
        the send returns, and closed by the sending thread instead.
        """
        if conn is None or conn is keep:
            return []
        try:
            conn.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        if conn in self._sending:
            self._retired.add(conn)
            return []
        return [conn]

    # -- writing -----------------------------------------------------------

    def write(self, data: bytes) -> None:
        """Blocking, lossless write from the PTY reader thread.

        Returns only once every byte has been accepted by the peer, or once the
        channel is released/closed during teardown. An absent or too-slow peer
        therefore blocks the PTY reader, which is how backpressure reaches the
        child instead of output being dropped to keep up with it.

        The socket send deliberately happens *outside* ``self._cond``: a send
        that blocks on a full socket buffer must never hold the lock, or
        ``attach`` (a reconnecting Envoy) and ``detach`` (the peer watcher)
        could never make progress and the stream would wedge.
        """
        if not data:
            return
        with self._cond:
            if self._pending:
                # Keep the unacknowledged tail and append the new chunk to it.
                self._pending = self._pending[self._sent:] + data
            else:
                self._pending = data
            self._sent = 0
        while True:
            with self._cond:
                if self._closed:
                    return
                conn = self._conn
                if conn is None:
                    if self._released:
                        # Nobody will read this again; drop it so teardown can
                        # finish instead of blocking on a vanished peer.
                        self._pending = b""
                        self._sent = 0
                        return
                    self._cond.wait(0.5)
                    continue
                payload = self._pending[self._sent:]
                if not payload:
                    return
                self._sending.add(conn)
            error = False
            written = 0
            try:
                written = conn.send(payload)
            except OSError:
                error = True
            close_now: list[socket.socket] = []
            done = False
            with self._cond:
                self._sending.discard(conn)
                if conn in self._retired:
                    # Retired while this send was inside it; the descriptor is
                    # ours to close now that nothing else can be using it.
                    self._retired.discard(conn)
                    close_now.append(conn)
                if self._conn is conn:
                    if error or written <= 0:
                        close_now.extend(self._retire_locked(conn, None))
                        self._conn = None
                        self._cond.notify_all()
                    else:
                        self._sent += written
                        if self._sent >= len(self._pending):
                            self._pending = b""
                            self._sent = 0
                            done = True
                # Otherwise a reconnect swapped peers while this send was in
                # flight; attach() rewound the cursor, so the next pass replays
                # the chunk from its first byte to the new peer.
            self._close_sockets(close_now)
            if done:
                return

    # -- introspection -----------------------------------------------------

    @property
    def attached(self) -> bool:
        with self._cond:
            return self._conn is not None

    def unsent_bytes(self) -> int:
        with self._cond:
            return len(self._pending) - self._sent


class Worker:
    def __init__(self, socket_dir: str, config: dict):
        self.socket_dir = socket_dir
        self.config = config
        self.sid = str(config["sid"])
        self._lock = threading.Lock()
        self._output = OutputChannel()
        self._control_connections: list[ControlConnection] = []
        self._stop = threading.Event()
        self._closing = False
        self._listeners: list[socket.socket] = []
        self._input_conn: socket.socket | None = None
        self._input_lock = threading.Lock()
        self._exit_code: int | None = None

        self.paths = {name: os.path.join(socket_dir, f"{name}.sock")
                      for name in ("control", "input", "output")}
        self._bind_listeners()

        self.session = Session(
            self.sid,
            str(config["path"]),
            list(config["cmd"]),
            str(config["cwd"]),
            login=bool(config.get("login")),
            extra_env=dict(config.get("extra_env") or {}),
            prompt_sentinel=str(config.get("prompt_sentinel") or ""),
            output_callback=self._broadcast_output,
        )

    # -- sockets -----------------------------------------------------------

    def _bind_listeners(self) -> None:
        os.makedirs(self.socket_dir, mode=0o700, exist_ok=True)
        os.chmod(self.socket_dir, 0o700)
        for path in self.paths.values():
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(path)
            os.chmod(path, 0o600)
            listener.listen(8)
            listener.settimeout(ACCEPT_TIMEOUT)
            self._listeners.append(listener)

    def _unlink_sockets(self) -> None:
        for path in self.paths.values():
            try:
                os.unlink(path)
            except OSError:
                pass
        try:
            os.rmdir(self.socket_dir)
        except OSError:
            pass

    # -- output ------------------------------------------------------------

    def _broadcast_output(self, data: bytes, offset: int) -> None:
        """Forward PTY output to Envoy, blocking when Envoy is absent.

        Runs on the PTY reader thread. Blocking here is the point: the child is
        throttled by PTY backpressure instead of losing output. Bytes that never
        reached a peer are covered by the session scrollback, which the next
        snapshot repaints.

        `offset` is where this chunk starts in the session's output stream. It
        travels with the chunk so a reconnecting web process can tell which live
        bytes its snapshot repaint already covers and drop exactly those.
        """
        if not data:
            return
        # No lock is held here: OutputChannel.write blocks until the byte is
        # accepted, or until a reconnect re-attaches a peer. Holding a worker
        # lock across that wait would deadlock the control handler.
        self._output.write(encode_output_frame(offset, data))

    def _accept_output(self, listener: socket.socket) -> None:
        conn, _ = listener.accept()
        # A larger send buffer absorbs bursts so the PTY reader blocks less often,
        # but it is only a cushion: the channel's blocking write is what
        # guarantees the child cannot outrun its reader.
        conn.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 1 << 20)
        # attach() retires any previous peer, deferring its close if a send is
        # still inside that socket.
        self._output.attach(conn)
        threading.Thread(target=self._output_peer_loop, args=(conn,), daemon=True,
                         name="worker-output-peer").start()

    def _output_peer_loop(self, conn: socket.socket) -> None:
        """Detect a vanished Envoy while blocked writes are in flight.

        The PTY reader blocks inside OutputChannel.write; this thread only
        watches for the peer closing so the channel can drop the dead socket and
        wait for the next attach.
        """
        try:
            while conn.recv(65536):
                pass
        except OSError:
            pass
        finally:
            # detach() retires the socket and closes it once no send() is inside
            # it, so this thread must not close it itself.
            self._output.detach(conn)

    # -- input -------------------------------------------------------------

    def _input_loop(self, conn: socket.socket) -> None:
        try:
            while not self._stop.is_set():
                try:
                    data = conn.recv(65536)
                except OSError:
                    break
                if not data:
                    break
                try:
                    self.session.write(data)
                except OSError:
                    break
        finally:
            try:
                conn.close()
            except OSError:
                pass
            with self._input_lock:
                if self._input_conn is conn:
                    self._input_conn = None

    def _accept_input(self, listener: socket.socket) -> None:
        conn, _ = listener.accept()
        with self._input_lock:
            previous = self._input_conn
            self._input_conn = conn
        if previous is not None:
            try:
                previous.close()
            except OSError:
                pass
        threading.Thread(target=self._input_loop, args=(conn,), daemon=True,
                         name="worker-input").start()

    # -- control -----------------------------------------------------------

    def _broadcast_event(self, message: dict) -> None:
        with self._lock:
            connections = list(self._control_connections)
        for connection in connections:
            connection.send(message)

    def _handle_control(self, message: dict) -> dict:
        request_id = message.get("id")
        response: dict = {"id": request_id, "ok": True}
        typ = message.get("type")
        session = self.session
        if typ == "ping":
            response["type"] = "pong"
        elif typ == "status":
            response.update({
                "type": "status_result",
                # The session id lets an adopting web process confirm it reached
                # the worker it meant to reach, not a socket left over from some
                # other session.
                "sid": session.sid,
                "pid": os.getpid(),
                "child_pid": session.proc.pid,
                "alive": session.alive,
                "exit_code": session.exit_code,
            })
        elif typ == "snapshot":
            # The scrollback is the authoritative replay, and it is complete: the
            # worker appends every PTY chunk to it *before* handing that chunk to
            # the output socket, so output produced while Envoy was away - and any
            # chunk that a vanished reader never accepted - is all in here. This
            # worker also owns the pyte screen, and the web process renders the
            # snapshot, so these bytes are the single record of the session.
            with session._lock:
                scrollback = b"".join(session.scrollback)
                # The stream position this repaint reaches. Read under the same
                # lock as the scrollback so the pair is consistent, and report
                # it so the web process can drop live bytes it has already
                # painted instead of showing them twice.
                output_offset = session._output_total_bytes
            response.update({
                "type": "snapshot_result",
                "sid": session.sid,
                "role": message.get("role", "lead"),
                "cols": session._pyte_screen.columns,
                "rows": session._pyte_screen.lines,
                "title": message.get("title") or "",
                "archive_text": session.get_archived_text(),
                "output": base64.b64encode(scrollback).decode("ascii"),
                "output_offset": output_offset,
                "alive": session.alive,
                "exit_code": session.exit_code,
            })
            if session.title:
                response["custom_title"] = session.title
        elif typ == "resize":
            session.resize(int(message.get("cols") or 0), int(message.get("rows") or 0))
            response["type"] = "resize_result"
        elif typ == "terminal_state":
            response.update({"type": "terminal_state_result",
                             "state": session.get_terminal_state()})
        elif typ == "terminal_lines":
            response.update({"type": "terminal_lines_result",
                             "lines": session.get_terminal_lines()})
        elif typ == "execute_action":
            response.update({"type": "execute_action_result",
                             "result": session.execute_terminal_action(dict(message.get("action") or {}))})
        elif typ == "save_upload":
            content = base64.b64decode(str(message.get("data") or "").encode("ascii"))
            response.update({"type": "save_upload_result",
                             "path": session.save_upload(str(message.get("name") or ""), content)})
        elif typ == "resolve_files":
            response.update({"type": "resolve_files_result",
                             "files": session.resolve_files([str(p) for p in message.get("paths") or []])})
        elif typ == "resolve_file":
            info = session.resolve_file(str(message.get("path") or ""))
            response.update({"type": "resolve_file_result", "info": info})
        elif typ == "rename":
            session.title = str(message.get("title") or "")
            response["type"] = "rename_result"
        elif typ == "close":
            response["type"] = "close_result"
            threading.Thread(target=self.shutdown, daemon=True,
                             name="worker-close").start()
        else:
            response.update({"ok": False, "error": f"unknown command: {typ}"})
        return response

    def _control_loop(self, connection: ControlConnection) -> None:
        reader = connection.conn.makefile("rb", buffering=0)
        try:
            for raw in reader:
                try:
                    message = json.loads(raw.decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    continue
                try:
                    response = self._handle_control(message)
                except Exception as exc:  # report failures, never die on them
                    response = {"id": message.get("id"), "ok": False, "error": str(exc)}
                if response.get("id") is not None:
                    connection.send(response)
        except OSError:
            pass
        finally:
            connection.close()
            with self._lock:
                self._control_connections = [existing for existing in self._control_connections
                                             if existing is not connection]

    def _accept_control(self, listener: socket.socket) -> None:
        conn, _ = listener.accept()
        connection = ControlConnection(conn)
        with self._lock:
            self._control_connections.append(connection)
        threading.Thread(target=self._control_loop, args=(connection,), daemon=True,
                         name="worker-control").start()

    # -- lifecycle ---------------------------------------------------------

    def _accept_loop(self) -> None:
        handlers = {
            "control": self._accept_control,
            "input": self._accept_input,
            "output": self._accept_output,
        }
        while not self._stop.is_set():
            for name, listener in zip(("control", "input", "output"), self._listeners):
                try:
                    handlers[name](listener)
                except socket.timeout:
                    continue
                except OSError:
                    if self._stop.is_set():
                        return

    def _exit_monitor(self) -> None:
        # Wait on the child, not on the PTY reader: with no output peer attached
        # the reader is parked inside a blocking write() and would never reach
        # its own cleanup, so joining it first would hang the worker with a dead
        # child forever.
        proc = self.session.proc
        try:
            proc.wait()
        except Exception:
            pass
        # Brief grace for the reader to hand the child's last output to an
        # attached peer; shutdown() releases the channel either way.
        self.session._reader.join(timeout=EXIT_FLUSH_SECONDS)
        code = self.session.exit_code
        self._exit_code = code if isinstance(code, int) else proc.returncode
        # Flush the exit notice before the sockets disappear.
        self._broadcast_event({"type": "exit", "exit_code": self._exit_code})
        self.shutdown()

    def _stop_accepting(self) -> None:
        self._stop.set()
        for listener in self._listeners:
            try:
                listener.close()
            except OSError:
                pass
        self._listeners = []
        with self._input_lock:
            if self._input_conn is not None:
                try:
                    self._input_conn.close()
                except OSError:
                    pass

    def _drain_output(self, timeout: float) -> bool:
        """Give a still-attached Envoy a bounded chance to accept pending bytes.

        The PTY reader is the only writer, so a live attached socket is already
        flushed by the time it parks in OutputChannel.write; this wait covers
        the small window where that thread is between chunks.
        """
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self._output.unsent_bytes() == 0:
                return True
            if not self._output.attached:
                return False
            time.sleep(0.02)
        return self._output.unsent_bytes() == 0

    def shutdown(self, timeout: float = SHUTDOWN_DRAIN_SECONDS) -> None:
        with self._lock:
            if self._closing:
                return
            self._closing = True
        self._stop_accepting()
        # Bounded graceful drain: the final chunk (and the exit notice) reaches
        # Envoy if it is still attached, but a vanished reader must not stall
        # teardown past the deadline.
        self._drain_output(timeout)
        # From here the channel lets the PTY reader go instead of blocking it.
        self._output.release()
        try:
            self.session.cleanup()
        except Exception:
            pass
        self._output.close()
        self._unlink_sockets()

    def run(self) -> int:
        threading.Thread(target=self._exit_monitor, daemon=True,
                         name="worker-exit-monitor").start()
        try:
            self._accept_loop()
        finally:
            self.shutdown()
        return self._exit_code if isinstance(self._exit_code, int) else 0


def main() -> None:
    if len(sys.argv) != 4 or sys.argv[1] != "--socket-dir":
        raise SystemExit("usage: pty_worker.py --socket-dir DIR CONFIG_B64")
    socket_dir = sys.argv[2]
    config = json.loads(base64.b64decode(sys.argv[3]).decode("utf-8"))
    worker = Worker(socket_dir, config)

    def on_signal(_signum, _frame):
        worker.shutdown()
        os._exit(0)

    signal.signal(signal.SIGTERM, on_signal)
    signal.signal(signal.SIGINT, on_signal)
    sys.exit(worker.run())


if __name__ == "__main__":
    main()
