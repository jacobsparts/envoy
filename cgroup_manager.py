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


class SystemdScopeManager:
    def __init__(self, refresh_seconds: float = 5.0):
        self.refresh_seconds = refresh_seconds
        self._lock = threading.Lock()
        self._cache: dict[str, dict[str, object]] = {}
        self._aggregate: dict[str, object] = self._unavailable()
        self._stop = threading.Event()
        self._validate_slice()
        self.reconcile_stale(set())
        self._thread = threading.Thread(target=self._refresh_loop, daemon=True, name="cgroup-statistics")
        self._thread.start()

    def _run(self, args: list[str], timeout: float = 15.0, check: bool = True) -> subprocess.CompletedProcess[str]:
        try:
            result = subprocess.run(args, text=True, capture_output=True, timeout=timeout, check=False)
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
        return f"{UNIT_PREFIX}{sid}.scope"

    def launch_command(self, sid: str, command: list[str]) -> list[str]:
        unit = self.unit_name(sid)
        account = pwd.getpwuid(os.getuid())
        return [
            "sudo", "-n", "systemd-run",
            "--quiet",
            "--uid", account.pw_name,
            "--gid", str(account.pw_gid),
            "--scope",
            "--unit", unit.removesuffix(".scope"),
            "--slice", SESSION_SLICE.removesuffix(".slice"),
            "--property", "MemoryAccounting=yes",
            "--property", f"MemoryHigh={SESSION_MEMORY_HIGH}",
            "--property", f"MemoryMax={SESSION_MEMORY_MAX}",
            "--property", f"MemorySwapMax={SESSION_SWAP_MAX}",
            "--property", "KillMode=control-group",
            "--property", "CollectMode=inactive-or-failed",
            "--property", "PartOf=envoy.service",
            "--",
            *command,
        ]

    def verify_scope(self, sid: str) -> str:
        unit = self.unit_name(sid)
        values = self._show(unit, ["ActiveState", "ControlGroup"])
        if values.get("ActiveState") not in {"active", "activating"}:
            raise RuntimeError(f"session scope failed to start: {unit}")
        cgroup = values.get("ControlGroup", "")
        if not cgroup:
            raise RuntimeError(f"session scope has no cgroup: {unit}")
        return cgroup

    def active_units(self) -> set[str]:
        result = self._run([
            "systemctl", "list-units", "--type=scope", "--state=active",
            "--no-legend", "--plain", f"{UNIT_PREFIX}*.scope",
        ], check=False)
        units = set()
        for line in result.stdout.splitlines():
            unit = line.split(None, 1)[0] if line.strip() else ""
            if unit.startswith(UNIT_PREFIX) and unit.endswith(".scope"):
                units.add(unit)
        return units

    def reconcile_stale(self, live_sids: set[str]) -> None:
        live_units = {self.unit_name(sid) for sid in live_sids}
        for unit in self.active_units() - live_units:
            self._run(["sudo", "-n", "systemctl", "stop", unit], check=False)

    def signal_scope(self, sid: str, sig: signal.Signals) -> None:
        self._run([
            "sudo", "-n", "systemctl", "kill", "--kill-whom=all",
            f"--signal={sig.name}", self.unit_name(sid)
        ], check=False)

    def stop_scope(self, sid: str) -> None:
        self._run(
            ["sudo", "-n", "systemctl", "stop", self.unit_name(sid)],
            timeout=20,
            check=False,
        )

    def scope_active(self, sid: str) -> bool:
        result = self._run(["systemctl", "is-active", "--quiet", self.unit_name(sid)], check=False)
        return result.returncode == 0

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

    def refresh(self, live_sids: set[str]) -> None:
        cache = {
            sid: self._statistics(self.unit_name(sid), framework_processes=1)
            for sid in live_sids
        }
        aggregate = self._statistics(SESSION_SLICE, framework_processes=len(live_sids))
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
        stats = self._statistics(unit, framework_processes=framework_processes)
        if target == "aggregate":
            with self._lock:
                self._aggregate = stats
        else:
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

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=2)
        for unit in self.active_units():
            self._run(["sudo", "-n", "systemctl", "stop", unit], check=False)
