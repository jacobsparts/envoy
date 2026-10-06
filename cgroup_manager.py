"""Systemd-backed resource management for Envoy terminal sessions."""

from __future__ import annotations

import os
import pwd
import re
import signal
import subprocess
import threading
import time
from pathlib import Path

SESSION_SLICE = "envoy-sessions.slice"
UNIT_PREFIX = "envoy-session-"
UNIT_SUFFIX = ".service"
# Session units used to be systemd scopes. The legacy suffix is still accepted
# so a unit left behind by an older Envoy is found and stopped instead of
# lingering forever.
LEGACY_UNIT_SUFFIX = ".scope"
# Bound on how long a child that ignores SIGTERM can delay the cgroup kill that
# follows its worker's death.
STOP_TIMEOUT_SECONDS = 10
STALE_SCOPE_GRACE_SECONDS = 60
SESSION_MEMORY_HIGH = 8 * 1024 ** 3
SESSION_MEMORY_MAX = 12 * 1024 ** 3
SESSION_SWAP_MAX = 1 * 1024 ** 3
AGGREGATE_MEMORY_HIGH = 12 * 1024 ** 3
AGGREGATE_MEMORY_MAX = 18 * 1024 ** 3
AGGREGATE_SWAP_MAX = 4 * 1024 ** 3
MIN_LIMIT = 64 * 1024 ** 2
MAX_LIMIT = 1024 * 1024 ** 3
CGROUP_ROOT = Path("/sys/fs/cgroup")
_SAFE_SID = re.compile(r"^[0-9a-f]{8}$")


def sid_from_unit(unit: str) -> str | None:
    """Session id encoded in a session unit name, if it is one."""
    if not unit.startswith(UNIT_PREFIX):
        return None
    for suffix in (UNIT_SUFFIX, LEGACY_UNIT_SUFFIX):
        if unit.endswith(suffix):
            sid = unit[len(UNIT_PREFIX):-len(suffix)]
            if _SAFE_SID.fullmatch(sid):
                return sid
    return None


class SystemdScopeManager:
    def __init__(self, refresh_seconds: float = 5.0):
        self.refresh_seconds = refresh_seconds
        self._lock = threading.Lock()
        self._cache: dict[str, dict[str, object]] = {}
        self._ever_registered: set[str] = set()
        self._registered_at: dict[str, float] = {}
        self._aggregate: dict[str, object] = self._unavailable()
        self._stop = threading.Event()
        self._validate_slice()
        self._thread = threading.Thread(target=self._refresh_loop, daemon=True, name="cgroup-statistics")
        self._thread.start()

    @staticmethod
    def _env() -> dict[str, str]:
        """Environment for systemctl/systemd-run.

        A login shell exports DBUS_SESSION_BUS_ADDRESS, which makes a bare
        `systemctl` talk to the *user* manager. Session scopes live in the
        system manager, so the session bus is removed here to keep behaviour
        identical whether Envoy was started from a shell or as a service.
        """
        env = dict(os.environ)
        env.pop("DBUS_SESSION_BUS_ADDRESS", None)
        env.pop("DBUS_SYSTEM_BUS_ADDRESS", None)
        return env

    def _run(self, args: list[str], timeout: float = 15.0, check: bool = True) -> subprocess.CompletedProcess[str]:
        try:
            result = subprocess.run(args, text=True, capture_output=True, timeout=timeout,
                                    check=False, env=self._env())
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RuntimeError(f"systemd operation failed: {exc}") from exc
        if check and result.returncode:
            message = (result.stderr or result.stdout or "systemd operation failed").strip()
            raise RuntimeError(message)
        return result

    def _validate_slice(self) -> None:
        result = self._run(
            ["systemctl", "show", SESSION_SLICE, "--property=LoadState", "--value"],
            check=False,
        )
        if result.returncode or result.stdout.strip() != "loaded":
            raise RuntimeError(
                f"{SESSION_SLICE} is not installed; install systemd/{SESSION_SLICE} before starting Envoy"
            )

    def unit_name(self, sid: str) -> str:
        if not _SAFE_SID.fullmatch(sid):
            raise ValueError("Invalid session ID")
        return f"{UNIT_PREFIX}{sid}{UNIT_SUFFIX}"

    def session_units(self, sid: str) -> list[str]:
        """Every unit name one session could be running under.

        The current unit is a supervised service; the legacy scope name is
        included so a unit left behind by an older Envoy is still stopped.
        """
        if not _SAFE_SID.fullmatch(sid):
            raise ValueError("Invalid session ID")
        return [f"{UNIT_PREFIX}{sid}{UNIT_SUFFIX}", f"{UNIT_PREFIX}{sid}{LEGACY_UNIT_SUFFIX}"]

    def launch_command(self, sid: str, command: list[str],
                       high: int = SESSION_MEMORY_HIGH,
                       maximum: int = SESSION_MEMORY_MAX,
                       swap_max: int = SESSION_SWAP_MAX) -> list[str]:
        """Build the systemd-run argv for one session unit.

        The worker runs as a transient *service*, not a scope. A scope is only a
        container: systemd never stops one when its main process dies, so a
        SIGKILLed worker left its whole cgroup running - including descendants
        that escaped the PTY session with setsid - with nobody watching. A
        service is supervised, so when the worker dies systemd applies
        KillMode=control-group to the cgroup and the children die with it, even
        with no Envoy process anywhere on the machine. TimeoutStopSec bounds how
        long a child that ignores SIGTERM can delay that.

        The unit deliberately does NOT carry ``PartOf=envoy.service``: session
        workers outlive the web process, so stopping or restarting Envoy must
        not stop them. Explicitly closed sessions, and units whose registry row
        is gone, are stopped by the web process instead.
        """
        unit = self.unit_name(sid)
        account = pwd.getpwuid(os.getuid())
        return [
            "sudo", "-n", "systemd-run",
            "--quiet",
            "--uid", account.pw_name,
            "--gid", str(account.pw_gid),
            "--unit", unit.removesuffix(UNIT_SUFFIX),
            "--slice", SESSION_SLICE.removesuffix(".slice"),
            "--property", "MemoryAccounting=yes",
            "--property", f"MemoryHigh={high}",
            "--property", f"MemoryMax={maximum}",
            "--property", f"MemorySwapMax={swap_max}",
            "--property", "KillMode=control-group",
            "--property", f"TimeoutStopSec={STOP_TIMEOUT_SECONDS}",
            "--property", "CollectMode=inactive-or-failed",
            "--",
            *command,
        ]

    def unit_main_pid(self, sid: str, timeout: float = 10.0) -> int | None:
        """PID of the worker process inside the session unit, if it is known."""
        if not _SAFE_SID.fullmatch(sid):
            raise ValueError("Invalid session ID")
        deadline = time.monotonic() + timeout
        while True:
            # A service reports MainPID: that is exactly the worker. A legacy
            # scope does not, so fall back to its first cgroup member, which is
            # the worker the launcher placed there.
            reported = self._show(self.unit_name(sid), ["MainPID"]).get("MainPID", "")
            if reported.strip().isdigit() and int(reported) > 0:
                return int(reported)
            pids = sorted(int(line) for line in self._cgroup_procs(sid) if line.strip().isdigit())
            if pids:
                return pids[0]
            if time.monotonic() >= deadline:
                return None
            time.sleep(0.05)

    def _cgroup_procs(self, sid: str) -> list[str]:
        cgroup = self._show(self.unit_name(sid), ["ControlGroup"]).get("ControlGroup", "")
        if not cgroup:
            return []
        path = (CGROUP_ROOT / cgroup.lstrip("/") / "cgroup.procs")
        try:
            return path.read_text().split()
        except OSError:
            return []

    def verify_scope(self, sid: str, timeout: float = 10.0) -> str:
        """Wait for the transient unit to exist and report its cgroup.

        The unit is registered asynchronously, so a query issued immediately
        after the launcher is spawned can still come back empty. Poll until the
        unit is active instead of failing on the first look; only report failure
        once the deadline passes.
        """
        unit = self.unit_name(sid)
        deadline = time.monotonic() + timeout
        last: dict[str, str] = {}
        while True:
            last = self._show(unit, ["ActiveState", "ControlGroup"])
            state = last.get("ActiveState", "")
            cgroup = last.get("ControlGroup", "")
            if state in {"active", "activating"} and cgroup:
                return cgroup
            if time.monotonic() >= deadline:
                break
            time.sleep(0.05)
        raise RuntimeError(f"session unit failed to start: {unit} ({last.get('ActiveState') or 'unknown'})")

    def active_units(self) -> set[str]:
        """Active session units, service or legacy scope.

        Services are what this version launches. Legacy scopes are included so a
        unit left behind by an older Envoy is still discovered and reaped
        instead of running forever with nobody watching it.
        """
        result = self._run([
            "systemctl", "list-units", "--type=service", "--type=scope", "--state=active",
            "--no-legend", "--plain", f"{UNIT_PREFIX}*",
        ], check=False)
        units = set()
        for line in result.stdout.splitlines():
            unit = line.split(None, 1)[0] if line.strip() else ""
            if sid_from_unit(unit):
                units.add(unit)
        return units

    def reconcile_stale(self, live_sids: set[str]) -> None:
        now = time.monotonic()
        with self._lock:
            stale_sids = {
                sid for sid in self._ever_registered - live_sids
                if now - self._registered_at.get(sid, now) >= STALE_SCOPE_GRACE_SECONDS
            }
        for sid in stale_sids:
            unit = self.unit_name(sid)
            if unit in self.active_units():
                self._run(["sudo", "-n", "systemctl", "stop", unit], check=False)

    def signal_scope(self, sid: str, sig: signal.Signals) -> None:
        self._run([
            "sudo", "-n", "systemctl", "kill", "--kill-whom=all",
            f"--signal={sig.name}", self.unit_name(sid)
        ], check=False)

    def stop_unit(self, unit: str) -> None:
        """Stop one session unit by name, service or legacy scope."""
        self._run(["sudo", "-n", "systemctl", "stop", unit], timeout=20, check=False)

    def stop_scope(self, sid: str) -> None:
        self.stop_unit(self.unit_name(sid))

    def stop_session(self, sid: str) -> None:
        """Stop whichever unit carries this session, service or legacy scope."""
        for unit in self.session_units(sid):
            if self._unit_active(unit):
                self.stop_unit(unit)

    def _unit_active(self, unit: str) -> bool:
        result = self._run(["systemctl", "is-active", "--quiet", unit], check=False)
        return result.returncode == 0

    def scope_active(self, sid: str) -> bool:
        """True while the session runs under either unit name.

        The current name is a service, but a session started by an Envoy that
        predates the switch runs as a scope. Reporting it inactive would make
        startup drop - and therefore kill - a session that is still perfectly
        alive, so both names count.
        """
        return any(self._unit_active(unit) for unit in self.session_units(sid))

    def _show(self, unit: str, properties: list[str]) -> dict[str, str]:
        result = self._run([
            "systemctl", "show", unit,
            *[item for prop in properties for item in ("--property", prop)],
        ])
        values = {}
        for line in result.stdout.splitlines():
            if "=" in line:
                key, value = line.split("=", 1)
                values[key] = value
        return values

    def _cgroup_path(self, unit: str) -> Path:
        cgroup = self._show(unit, ["ControlGroup"]).get("ControlGroup", "")
        if not cgroup:
            raise RuntimeError(f"No cgroup for {unit}")
        path = (CGROUP_ROOT / cgroup.lstrip("/")).resolve()
        root = CGROUP_ROOT.resolve()
        if path != root and root not in path.parents:
            raise RuntimeError("Invalid systemd cgroup path")
        return path

    @staticmethod
    def _read_value(path: Path) -> int | None:
        text = path.read_text().strip()
        if text == "max":
            return None
        return int(text)

    @staticmethod
    def _read_map(path: Path) -> dict[str, int]:
        result = {}
        for line in path.read_text().splitlines():
            parts = line.split()
            if len(parts) == 2:
                result[parts[0]] = int(parts[1])
        return result

    @staticmethod
    def _read_pressure(path: Path) -> dict[str, float]:
        result: dict[str, float] = {}
        for line in path.read_text().splitlines():
            parts = line.split()
            if not parts:
                continue
            kind = parts[0]
            for item in parts[1:]:
                if item.startswith("avg10="):
                    result[f"{kind}_avg10"] = float(item.split("=", 1)[1])
        return result

    @staticmethod
    def _unavailable() -> dict[str, object]:
        return {"available": False, "updated_at": time.time()}

    @staticmethod
    def _process_count(path: Path) -> int:
        count = len((path / "cgroup.procs").read_text().splitlines())
        for child in path.iterdir():
            if child.is_dir():
                count += SystemdScopeManager._process_count(child)
        return count

    def _statistics(self, unit: str, framework_processes: int = 0) -> dict[str, object]:
        try:
            path = self._cgroup_path(unit)
            process_count = self._process_count(path)
            return {
                "current": self._read_value(path / "memory.current"),
                "high": self._read_value(path / "memory.high"),
                "max": self._read_value(path / "memory.max"),
                "peak": self._read_value(path / "memory.peak") if (path / "memory.peak").exists() else None,
                "swap_current": self._read_value(path / "memory.swap.current"),
                "swap_max": self._read_value(path / "memory.swap.max"),
                "processes": max(0, process_count - framework_processes),
                "tasks": self._read_value(path / "pids.current"),
                "pressure": self._read_pressure(path / "memory.pressure"),
                "events": self._read_map(path / "memory.events"),
                "updated_at": time.time(),
                "available": True,
            }
        except (OSError, ValueError, RuntimeError):
            return self._unavailable()

    @staticmethod
    def _sum_optional(values: list[object]) -> int | None:
        total = 0
        saw_value = False
        for value in values:
            if isinstance(value, int):
                total += value
                saw_value = True
        return total if saw_value else None

    def _aggregate_from_sessions(self, slice_stats: dict[str, object], session_stats: dict[str, dict[str, object]]) -> dict[str, object]:
        """Build aggregate usage from live sessions.

        Slice memory.current can retain orphaned charges (for example tmpfs/shmem
        pages left behind after a scope exits). The UI's "All sessions" figure
        should reflect live session units, while keeping slice-level limits and
        pressure/events for threshold editing and health.
        """
        live = [stats for stats in session_stats.values() if stats.get("available")]
        aggregate = dict(slice_stats)
        if not slice_stats.get("available") and not live:
            return aggregate

        aggregate["available"] = True
        aggregate["updated_at"] = time.time()
        aggregate["current"] = self._sum_optional([stats.get("current") for stats in live]) or 0
        aggregate["swap_current"] = self._sum_optional([stats.get("swap_current") for stats in live]) or 0
        aggregate["processes"] = self._sum_optional([stats.get("processes") for stats in live]) or 0
        aggregate["tasks"] = self._sum_optional([stats.get("tasks") for stats in live])

        peaks = [stats.get("peak") for stats in live if isinstance(stats.get("peak"), int)]
        if peaks:
            aggregate["peak"] = max(peaks)
        elif not isinstance(aggregate.get("peak"), int):
            aggregate["peak"] = None

        # Preserve slice high/max/swap_max/pressure/events from slice_stats.
        if not slice_stats.get("available"):
            # If the slice itself is unreadable, still report summed usage with
            # unknown limits rather than marking everything unavailable.
            aggregate.setdefault("high", None)
            aggregate.setdefault("max", None)
            aggregate.setdefault("swap_max", None)
            aggregate.setdefault("pressure", {})
            aggregate.setdefault("events", {})
        return aggregate

    def refresh(self, live_sids: set[str]) -> None:
        cache = {
            sid: self._statistics(self.unit_name(sid), framework_processes=1)
            for sid in live_sids
        }
        slice_stats = self._statistics(SESSION_SLICE, framework_processes=len(live_sids))
        aggregate = self._aggregate_from_sessions(slice_stats, cache)
        with self._lock:
            self._cache = cache
            self._aggregate = aggregate

    def _refresh_loop(self) -> None:
        while not self._stop.wait(self.refresh_seconds):
            with self._lock:
                live = set(self._cache)
            self.refresh(live)
            self.reconcile_stale(live)

    def register(self, sid: str) -> None:
        with self._lock:
            self._cache[sid] = self._unavailable()
            self._ever_registered.add(sid)
            self._registered_at[sid] = time.monotonic()
        self.refresh(set(self.session_ids()))

    def unregister(self, sid: str) -> None:
        with self._lock:
            self._cache.pop(sid, None)

    def session_ids(self) -> list[str]:
        with self._lock:
            return list(self._cache)

    def session_stats(self, sid: str) -> dict[str, object]:
        with self._lock:
            return dict(self._cache.get(sid, self._unavailable()))

    def aggregate_stats(self) -> dict[str, object]:
        with self._lock:
            return dict(self._aggregate)

    def update_limits(self, target: str, sid: str, high: object, maximum: object, swap_max: object) -> dict[str, object]:
        if target not in {"session", "aggregate"}:
            raise ValueError("target must be session or aggregate")
        unit = SESSION_SLICE if target == "aggregate" else self.unit_name(sid)
        framework_processes = len(self.session_ids()) if target == "aggregate" else 1
        current = self._statistics(unit, framework_processes=framework_processes)
        values: dict[str, int] = {}
        if high is not None:
            values["MemoryHigh"] = self._validated_limit(high, "memory_high")
        if high is not None:
            if maximum is None:
                maximum = values["MemoryHigh"] * 3 // 2
            if swap_max is None:
                swap_max = values["MemoryHigh"] // 4
        if maximum is not None:
            values["MemoryMax"] = self._validated_limit(maximum, "memory_max")
        if swap_max is not None:
            values["MemorySwapMax"] = self._validated_limit(swap_max, "memory_swap_max")
        effective_high = values.get("MemoryHigh", current.get("high"))
        effective_max = values.get("MemoryMax", current.get("max"))
        if isinstance(effective_high, int) and isinstance(effective_max, int) and effective_max < effective_high:
            raise ValueError("MemoryMax must be greater than or equal to MemoryHigh")
        if not values:
            raise ValueError("No resource limits supplied")
        args = ["sudo", "-n", "systemctl", "set-property", "--runtime", unit]
        args.extend(f"{key}={value}" for key, value in values.items())
        self._run(args)
        if target == "aggregate":
            with self._lock:
                live_sids = set(self._cache)
            cache = {
                live_sid: self._statistics(self.unit_name(live_sid), framework_processes=1)
                for live_sid in live_sids
            }
            slice_stats = self._statistics(SESSION_SLICE, framework_processes=len(live_sids))
            stats = self._aggregate_from_sessions(slice_stats, cache)
            with self._lock:
                self._cache = cache
                self._aggregate = stats
        else:
            stats = self._statistics(unit, framework_processes=framework_processes)
            with self._lock:
                self._cache[sid] = stats
        return {"ok": True, "target": target, "session_id": sid or None, "memory": stats}

    @staticmethod
    def _validated_limit(value: object, name: str) -> int:
        if isinstance(value, bool):
            raise ValueError(f"{name} must be an integer byte value")
        try:
            number = int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{name} must be an integer byte value") from exc
        if number < MIN_LIMIT or number > MAX_LIMIT:
            raise ValueError(f"{name} must be between {MIN_LIMIT} and {MAX_LIMIT} bytes")
        return number

    def stop_thread(self) -> None:
        """Stop the statistics thread without touching any session unit."""
        self._stop.set()
        self._thread.join(timeout=2)

    def close(self, stop_scopes: bool = True) -> None:
        """Stop the statistics thread, and by default stop every session unit.

        Routine web restarts must not stop sessions: call ``stop_thread()`` (or
        ``close(stop_scopes=False)``) instead, and let the worker keep running.
        """
        self.stop_thread()
        if not stop_scopes:
            return
        for unit in self.active_units():
            self._run(["sudo", "-n", "systemctl", "stop", unit], check=False)
