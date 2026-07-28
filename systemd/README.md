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
ID `1000`, the `envoy-session-*.scope` namespace, and the approved resource
properties. Adjust those two identity values together with the Envoy service
account when installing on another host.

Diagnostics:

```bash
systemctl status envoy-sessions.slice
systemctl list-units 'envoy-session-*.scope'
systemctl show envoy-session-SESSION.scope \
  -p ControlGroup -p MemoryCurrent -p MemoryHigh -p MemoryMax \
  -p MemorySwapCurrent -p MemorySwapMax -p TasksCurrent
cat /sys/fs/cgroup/envoy.slice/envoy-sessions.slice/memory.pressure
cat /sys/fs/cgroup/envoy.slice/envoy-sessions.slice/memory.events
```

Stopping or restarting `envoy.service` stops its transient session scopes.
Rollback requires restoring any previous resource controls on `envoy.service`,
removing the installed slice and sudoers files, running `systemctl
daemon-reload`, and reverting the cgroup integration code.
