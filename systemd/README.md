# Envoy session cgroup installation

Install the aggregate slice and restricted sudo policy:

```bash
sudo install -o root -g root -m 0644 systemd/envoy-sessions.slice /etc/systemd/system/envoy-sessions.slice
sudo install -o root -g root -m 0440 systemd/envoy-sessions.sudoers /etc/sudoers.d/envoy-sessions
sudo visudo -cf /etc/sudoers.d/envoy-sessions
sudo systemctl daemon-reload
sudo systemctl restart envoy.service
```

The supplied sudoers policy is intentionally specific to user `jacob`, group
ID `1000`, the `envoy-session-*` unit namespace, and the approved resource
properties. Adjust those two identity values together with the Envoy service
account when installing on another host.

Diagnostics:

```bash
systemctl status envoy-sessions.slice
systemctl list-units 'envoy-session-*.service'
systemctl show envoy-session-SESSION.service \
  -p ControlGroup -p MemoryCurrent -p MemoryHigh -p MemoryMax \
  -p MemorySwapCurrent -p MemorySwapMax -p TasksCurrent
cat /sys/fs/cgroup/envoy.slice/envoy-sessions.slice/memory.pressure
cat /sys/fs/cgroup/envoy.slice/envoy-sessions.slice/memory.events
```

Each session worker runs as a transient *service* (not a scope), deliberately
without `PartOf=envoy.service`: a session worker outlives the web process.
Restarting or stopping `envoy.service` leaves running sessions untouched, and
the next web process re-attaches to them.

The unit type is what makes teardown reliable. systemd never stops a scope when
its main process dies, so a scope-based worker that was killed left its whole
cgroup running with nobody watching it. A service is supervised: when the worker
dies - killed, crashed, or exited - systemd applies `KillMode=control-group` to
the cgroup, so the session's descendants die with it even when no Envoy process
is running anywhere on the machine. `TimeoutStopSec=10` bounds how long a child
that ignores `SIGTERM` can delay that.

Discovery works through a small SQLite registry plus per-session sockets, both
under `$XDG_RUNTIME_DIR/envoy` (mode 0700; `ENVOY_RUNTIME_DIR` overrides the
location). On startup the web process resumes every registered session whose
unit is still active, and deletes registry rows whose worker is gone. Closing
a session in the UI - or a worker exiting on its own - stops the unit, drops
the registry row, removes the socket directory, and deletes the session's
`/tmp` files.

Diagnostics:

```bash
sqlite3 "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/envoy/registry.db" \
  'select sid, path, worker_pid, scope, title from sessions'
ls "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/envoy/sockets"
```

Stopping a session explicitly means closing it in the UI (or `envoy-sessions`
teardown); stopping the *service* only detaches from it. Rollback requires
restoring any previous resource controls on `envoy.service`, removing the
installed slice and sudoers files, running `systemctl daemon-reload`, and
reverting the cgroup and registry integration code.

## /tmp watcher

`tmp_watch.py` attributes files created in `/tmp` to the session that created them,
and `tmp_tracker.py` lets the server ask it what a session created and delete those
files when the session is torn down. It is optional: without the unit below, envoy
behaves exactly as before and simply leaves session `/tmp` files behind.

Install and start it (it does not touch `envoy.service`, which keeps running):

```bash
sudo install -o root -g root -m 0644 systemd/envoy-tmpwatch.service /etc/systemd/system/envoy-tmpwatch.service
sudo systemctl daemon-reload
sudo systemctl enable --now envoy-tmpwatch.service
```

The watcher needs `CAP_SYS_ADMIN` for `fanotify_init`, so it cannot be launched as a
session scope (scopes reject `AmbientCapabilities=`); it runs as its own service as
`jacob` with that capability, and binds its IPC socket in `/run/envoy-tmpwatch`
via `RuntimeDirectory=`. It enumerates `/tmp` directories once at startup and
indexes their opaque file handles to resolve fanotify filenames. New directories
are added as events arrive; it rescans only after a fanotify queue overflow.
Events from elsewhere on the filesystem do not cause scans. Directory handle
lookup requires filesystem support for `name_to_handle_at()`; files in unresolved
directories are left untouched.

Diagnostics:

```bash
systemctl status envoy-tmpwatch.service
printf 'stats\n' | socat - UNIX-CONNECT:/run/envoy-tmpwatch/sock
printf 'files SESSION\n' | socat - UNIX-CONNECT:/run/envoy-tmpwatch/sock
printf 'dump\n' | socat - UNIX-CONNECT:/run/envoy-tmpwatch/sock
```

What gets deleted: only files the watcher saw an envoy session create. A file at or
above 1 MiB is remembered for the whole session, so a session that leaves large scratch
files behind has all of them removed at teardown. Smaller files are remembered for five
minutes and then forgotten - they are still deleted when the session ends inside that
window, and past it they are left to `systemd-tmpfiles` (the 10 day rule in
`/usr/lib/tmpfiles.d/tmp.conf`), which bounds the watcher's memory. Directories a
session created are removed once they are empty, and only if they did not exist when the
watcher started. Files created outside any envoy session are never touched.

Knobs: `ENVOY_TMPWATCH=0` disables teardown deletion in the server (the watcher keeps
tracking), `ENVOY_TMPWATCH_SOCK` points the server at a different socket, and the watcher
honours `TMPWATCH_ROOTS` (colon-separated, default `/tmp`), `TMPWATCH_MIN_BYTES` /
`TMPWATCH_SMALL_TTL` (the size and age rules above), `TMPWATCH_MAX_FILES` (cap on
remembered small paths per session, 0 disables), `TMPWATCH_SWEEP` (seconds between
leftover sweeps, 0 disables) and `TMPWATCH_STATE` (persisted index).

Known limit, accepted as best effort: a process that exits faster than the watcher is
scheduled cannot be attributed, so files written by very short-lived children may be
missed (measured: 7/40 with a default-priority watcher, 28/40 at `nice -20`). Missing a
file only means it is left to `systemd-tmpfiles` instead of being deleted at teardown.

Restarting `envoy-tmpwatch.service` is safe and independent of envoy: on startup (and
every `TMPWATCH_SWEEP` seconds) it deletes tracked files whose session no longer has a
live scope, so sessions that ended while it was down are cleaned up by that sweep.
