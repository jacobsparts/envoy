#!/usr/bin/env python3
"""envoy /tmp watcher: streams fanotify events, attributes file creation to envoy
session units via cgroup, and answers "what /tmp files did session X create?".

Runs as the envoy user with CAP_SYS_ADMIN (fanotify_init needs it), e.g.
    systemd-run --property=User=jacob --property=AmbientCapabilities=CAP_SYS_ADMIN \
                --property=CapabilityBoundingSet=CAP_SYS_ADMIN /path/to/tmp_watch.py

IPC is a UNIX socket, newline-delimited requests, JSON replies:
    stats | dump | files <sid> | delete <sid> | sweep | prune | save | quit

Every SWEEP_INTERVAL seconds (and once at startup) it deletes files whose session no
longer has a live unit, which covers envoy crashes and reboots. Files smaller than
MIN_FILE_BYTES are only remembered for SMALL_FILE_TTL, so the index stays bounded.
"""
import ctypes, json, os, select, socket, stat, struct, sys, time

libc = ctypes.CDLL("libc.so.6", use_errno=True)

FAN_CLOEXEC=0x1; FAN_NONBLOCK=0x2
FAN_REPORT_FID=0x200; FAN_REPORT_DIR_FID=0x400; FAN_REPORT_NAME=0x800
# NOTE: deliberately NOT using FAN_REPORT_PIDFD. The kernel installs a pidfd in the
# reader for every event and the reader must close it; leaking them exhausts the fd
# table, after which accept() fails with EMFILE and the select loop spins. It also
# does not help attribution: the pidfd record is -1 for short-lived writers, and
# holding one open does not keep /proc/<pid> alive after the writer is reaped.
# metadata.pid (offset 20) is populated for every event type and is all we need.
FAN_UNLIMITED_QUEUE=0x10
FAN_MARK_ADD=0x1; FAN_MARK_FILESYSTEM=0x100
FAN_ONDIR=0x40000000
FAN_CREATE=0x100; FAN_DELETE=0x200; FAN_MOVED_FROM=0x40; FAN_MOVED_TO=0x80
FAN_CLOSE_WRITE=0x8; FAN_Q_OVERFLOW=0x4000
T_DFID_NAME=2

IS_CREATE=FAN_CREATE|FAN_MOVED_TO|FAN_CLOSE_WRITE
IS_GONE=FAN_DELETE|FAN_MOVED_FROM
SID_PREFIX="envoy-session-"
# Session units are services; scopes are the older unit type, still matched so a
# worker left behind by an older envoy is attributed and swept correctly.
SID_SUFFIXES=(".service",".scope")

# The watcher runs as the envoy user with CAP_SYS_ADMIN; its systemd unit sets
# RuntimeDirectory=envoy-tmpwatch so both files live in a directory that user owns.
SOCK=os.environ.get("TMPWATCH_SOCK","/run/envoy-tmpwatch/sock")
ROOTS=[r for r in os.environ.get("TMPWATCH_ROOTS","/tmp").split(":") if r]
STATE=os.environ.get("TMPWATCH_STATE","/run/envoy-tmpwatch/state.json")
RECONCILE_INTERVAL=float(os.environ.get("TMPWATCH_RECONCILE","60"))
SWEEP_INTERVAL=float(os.environ.get("TMPWATCH_SWEEP","60"))    # delete leftovers this often
# Ceiling on remembered *small* paths per session. Large files are never evicted:
# they are what teardown deletes. This only bounds the memory used by the small
# files a session churns through while they are still recent. 0 disables the cap.
MAX_FILES_PER_SESSION=int(os.environ.get("TMPWATCH_MAX_FILES","5000"))
# Only files at least this large are remembered for the whole session; smaller ones are
# remembered for SMALL_FILE_TTL and then forgotten, which keeps the in-memory index
# bounded no matter how many temp files a session churns through. A file that is still
# small after SMALL_FILE_TTL is left to systemd-tmpfiles (the 10 day rule in
# /usr/lib/tmpfiles.d/tmp.conf) instead of being tracked. 0 disables pruning entirely.
MIN_FILE_BYTES=int(os.environ.get("TMPWATCH_MIN_BYTES", str(1024*1024)))
SMALL_FILE_TTL=float(os.environ.get("TMPWATCH_SMALL_TTL","300"))
# Remove directories a session created and left empty, as long as they did not exist
# when the watcher started (so a pre-existing directory is never removed).
RMDIR_ORPHANS=os.environ.get("TMPWATCH_RMDIR_ORPHANS","1").strip().lower() not in ("0","false","no","off")
# Live envoy session units are visible here without root: one directory per unit.
LIVE_UNIT_DIR=os.environ.get("TMPWATCH_LIVE_DIR",
    "/sys/fs/cgroup/envoy.slice/envoy-sessions.slice")


class FileHandle(ctypes.Structure):
    _fields_=[("handle_bytes",ctypes.c_uint), ("handle_type",ctypes.c_int),
              ("f_handle",ctypes.c_ubyte*128)]


def directory_handle(path):
    handle=FileHandle()
    handle.handle_bytes=128
    mount_id=ctypes.c_int()
    if libc.name_to_handle_at(-100, os.fsencode(path), ctypes.byref(handle),
                              ctypes.byref(mount_id), 0)<0:
        return None
    return (handle.handle_type, bytes(handle.f_handle[:handle.handle_bytes]))


def build_dirmap(root):
    """Map opaque fanotify parent handles to directories under this root."""
    device=os.stat(root).st_dev
    result={}
    for dp,dirs,_ in os.walk(root):
        try:
            if os.stat(dp).st_dev != device:
                dirs[:]=[]
                continue
            key=directory_handle(dp)
            if key is not None:
                result[key]=dp
        except OSError:
            dirs[:]=[]
    return result


def proc_starttime(pid):
    try:
        with open(f"/proc/{pid}/stat","rb") as f: d=f.read()
        return d[d.rindex(b")")+2:].split()[19]
    except (OSError, IndexError, ValueError):
        return None


def proc_cgroup(pid):
    try:
        with open(f"/proc/{pid}/cgroup") as f:
            return f.read().strip().splitlines()[-1].split(":",2)[2]
    except (OSError, IndexError):
        return None


def sid_from_unit_name(name):
    """Session id encoded in an envoy session unit name, None if it is not one."""
    if not name.startswith(SID_PREFIX): return None
    for suffix in SID_SUFFIXES:
        if name.endswith(suffix):
            sid=name[len(SID_PREFIX):-len(suffix)]
            return sid or None
    return None


def live_session_ids():
    """Session ids that currently have a live unit, straight from the cgroup tree.

    Used to sweep leftovers: a session with tracked files but no live unit is gone
    (envoy crashed, the box rebooted, or teardown did not run), so its files are
    deleted. Reading the tree avoids trusting envoy's own view of the world, which
    matters when the watcher outlives a server restart."""
    try: entries=os.listdir(LIVE_UNIT_DIR)
    except OSError: return None
    live=set()
    for name in entries:
        sid=sid_from_unit_name(name)
        if sid: live.add(sid)
    return live


def sid_of_cgroup(cg):
    """Session id for an envoy session cgroup, "" for any other cgroup,
    None when the cgroup could not be read."""
    if not cg: return None
    for comp in cg.split("/"):
        sid=sid_from_unit_name(comp)
        if sid: return sid
    return ""


class Watcher:
    def __init__(self):
        self.sid_files={}        # sid -> {path: created_ts}
        self.path_sid={}         # path -> sid
        self.pid_cache={}        # pid -> (sid, starttime)
        self.dirmaps={}          # root -> {directory handle: path}
        self.dir_key={}          # directory path -> handle
        self.preexisting_dirs=set()   # dirs that already existed when we started
        self.overflow_pending=False
        self.stats={"events":0,"create":0,"gone":0,"tracked":0,"untracked":0,
                    "not_envoy":0,"unattributable":0,"no_dir":0,"dirs_added":0,
                    "dirs_removed":0,"rescan":0,"overflow":0,"reconcile":0,
                    "reconciled_dropped":0,"pid_cache_hits":0,"pid_lookups":0,
                    "existence_misses":0,"swept_sessions":0,
                    "swept_files":0,"small_dropped":0,"capped":0,"orphan_dirs":0}
        self.conns={}
        self._save_warned=False
        self._stop=False
        self.fds={self._open_fanotify(root): root for root in ROOTS}
        for root in ROOTS:
            self.dirmaps[root]=build_dirmap(root)
            for key,p in self.dirmaps[root].items(): self.dir_key[p]=key
        self.preexisting_dirs=set(self.dir_key)
        if STATE: self._load()
        try: os.unlink(SOCK)
        except OSError: pass
        self.ls=socket.socket(socket.AF_UNIX); self.ls.bind(SOCK); os.chmod(SOCK,0o600)
        self.ls.listen(8); self.ls.setblocking(False)

    # ---- fanotify ----
    def _open_fanotify(self, root):
        flags=(FAN_CLOEXEC|FAN_NONBLOCK|FAN_REPORT_FID|FAN_REPORT_DIR_FID|
               FAN_REPORT_NAME|FAN_UNLIMITED_QUEUE)
        fd=libc.fanotify_init(flags, os.O_RDONLY|os.O_LARGEFILE)
        if fd<0:
            raise SystemExit(f"fanotify_init failed errno={ctypes.get_errno()}")
        mask=FAN_CREATE|FAN_DELETE|FAN_MOVED_FROM|FAN_MOVED_TO|FAN_CLOSE_WRITE|FAN_ONDIR
        if libc.fanotify_mark(fd, FAN_MARK_ADD|FAN_MARK_FILESYSTEM, mask, -1,
                              ctypes.create_string_buffer(root.encode()+b"\x00"))<0:
            raise SystemExit(f"fanotify_mark({root}) failed errno={ctypes.get_errno()}")
        return fd

    # ---- attribution ----
    def session_of(self, pid):
        """pid -> session id, cached, with pid-reuse protection via start time."""
        ent=self.pid_cache.get(pid)
        if ent:
            sid, started=ent
            if proc_starttime(pid)==started:
                self.stats["pid_cache_hits"]+=1
                return sid
            del self.pid_cache[pid]
        self.stats["pid_lookups"]+=1
        sid=sid_of_cgroup(proc_cgroup(pid))
        if sid is None:
            self.stats["unattributable"]+=1
            return None
        if sid=="":
            self.stats["not_envoy"]+=1
            return ""
        self.pid_cache[pid]=(sid, proc_starttime(pid))
        return sid

    # ---- state ----
    def track(self, sid, path):
        if path in self.path_sid: return
        if not os.path.lexists(path):          # merged/duplicated events: already gone
            self.stats["existence_misses"]+=1
            return
        files=self.sid_files.setdefault(sid,{})
        if not self._make_room(files, path):
            # The index is full of large files and this new path is a small one, so
            # nothing worth deleting would be evicted to make room. Small files are
            # left to systemd-tmpfiles.
            self.stats["capped"]+=1
            return
        files[path]=time.time()
        self.path_sid[path]=sid
        self.stats["tracked"]+=1

    def _is_small(self, path):
        try: st=os.stat(path)
        except OSError: return True          # gone, or unreadable: treat as forgettable
        return not stat.S_ISDIR(st.st_mode) and st.st_size<MIN_FILE_BYTES

    def _make_room(self, files, incoming):
        """Keep the index bounded before tracking `incoming`.

        Large files are never forgotten: they are the reason the tracker exists, so a
        session that leaves 100 GB of temporary files behind still gets all of them
        deleted at teardown. The cap only limits small entries - when it is reached,
        the oldest small paths are forgotten, and if the index is full of large files
        then a new small file is simply not remembered. Either way a forgotten small
        file is left to systemd-tmpfiles."""
        if MAX_FILES_PER_SESSION<=0: return True      # cap disabled
        if len(files)<MAX_FILES_PER_SESSION: return True
        by_age=sorted(files.items(), key=lambda kv: kv[1])
        small=[p for p,_ in by_age if self._is_small(p)]
        if not small: return not self._is_small(incoming)
        for p in small[:max(1, MAX_FILES_PER_SESSION//10)]:
            files.pop(p, None); self.path_sid.pop(p, None)
            self.stats["capped"]+=1
        return True

    def untrack(self, path):
        sid=self.path_sid.pop(path, None)
        if sid is None: return
        self.sid_files.get(sid,{}).pop(path, None)
        self.stats["untracked"]+=1

    # ---- event handling ----
    def _remove_directory(self, root, path):
        dm=self.dirmaps[root]
        for key,old_path in list(dm.items()):
            if old_path==path or old_path.startswith(path+os.sep):
                del dm[key]
                self.dir_key.pop(old_path, None)
                self.stats["dirs_removed"]+=1

    def apply(self, mask, pid, path):
        if mask & IS_CREATE:
            self.stats["create"]+=1
            if mask & FAN_ONDIR:
                for root, dm in self.dirmaps.items():
                    if path.startswith(root + os.sep) and os.path.isdir(path):
                        # Only a moved-in directory can contain an existing subtree.
                        directories=(build_dirmap(path) if mask & FAN_MOVED_TO
                                     else {directory_handle(path): path})
                        for key, directory in directories.items():
                            if key is None: continue
                            dm[key]=directory
                            self.dir_key[directory]=key
                            self.stats["dirs_added"]+=1
                        break
            sid=self.session_of(pid)
            if sid: self.track(sid, path)
        if mask & IS_GONE:
            self.stats["gone"]+=1
            self.untrack(path)
            if mask & FAN_ONDIR:
                for root in self.dirmaps:
                    if path.startswith(root + os.sep):
                        self._remove_directory(root, path)
                        break

    def parse(self, data, root):
        off=0
        while off<len(data):
            ev_len, vers, res, meta = struct.unpack_from("IBBH", data, off)
            mask=struct.unpack_from("Q", data, off+8)[0]
            pid=struct.unpack_from("i", data, off+20)[0]
            o2=off+meta; dirkey=None; name=None
            while o2<off+ev_len:
                itype, ipad, ilen = struct.unpack_from("BBH", data, o2)
                if itype==T_DFID_NAME:
                    body=data[o2+4:o2+ilen]
                    hb, ht = struct.unpack_from("iI", body, 8)
                    dirkey=(ht, body[16:16+hb])
                    name=body[16+hb:].split(b"\x00")[0].decode("utf-8","replace")
                o2+=ilen
            self.stats["events"]+=1
            if mask & FAN_Q_OVERFLOW:
                self.stats["overflow"]+=1
                self.overflow_pending=True
            elif name is not None and dirkey is not None:
                base=self.dirmaps[root].get(dirkey)
                if base is not None:
                    self.apply(mask, pid, base + "/" + name)
                else:
                    self.stats["no_dir"]+=1
            off+=ev_len

    # ---- maintenance ----
    def rescan(self):
        self.dir_key.clear()
        for root in ROOTS:
            self.dirmaps[root]=build_dirmap(root)
            for key,p in self.dirmaps[root].items(): self.dir_key[p]=key
        self.stats["rescan"]+=1
        self.overflow_pending=False
        self.reconcile()

    def reconcile(self):
        """Drop paths that are gone, and forget small files once they are old.

        A file at or above MIN_FILE_BYTES is remembered for the whole session. Smaller
        ones are remembered only for SMALL_FILE_TTL: they are still deleted when the
        session ends inside that window, and after it they are left to systemd-tmpfiles
        (the 10 day rule in /usr/lib/tmpfiles.d/tmp.conf). That keeps the index
        proportional to recent activity plus the number of large files, rather than to
        everything a session has ever created. Directories are always kept: there are
        few of them, and teardown needs their paths to remove the empty ones."""
        self.stats["reconcile"]+=1
        now=time.time()
        for sid, files in list(self.sid_files.items()):
            for path, created in list(files.items()):
                if not os.path.lexists(path):
                    files.pop(path, None); self.path_sid.pop(path, None)
                    self.stats["reconciled_dropped"]+=1
                    continue
                if MIN_FILE_BYTES<=0 or now-created<=SMALL_FILE_TTL: continue
                try: st=os.stat(path)
                except OSError: continue
                if stat.S_ISDIR(st.st_mode) or st.st_size>=MIN_FILE_BYTES: continue
                files.pop(path, None); self.path_sid.pop(path, None)
                self.stats["small_dropped"]+=1
            if not files: self.sid_files.pop(sid, None)
        for pid,(sid,started) in list(self.pid_cache.items()):
            if proc_starttime(pid)!=started: del self.pid_cache[pid]

    def save(self):
        if not STATE: return
        tmp=STATE+".tmp"
        try:
            with open(tmp,"w") as f:
                json.dump({s:sorted(v) for s,v in self.sid_files.items()}, f)
            os.replace(tmp, STATE)
        except OSError as exc:
            # Persistence is best effort: a missing RuntimeDirectory must not stop
            # the watcher from tracking or from deleting files.
            if not self._save_warned:
                self._save_warned=True
                print(f"tmpwatch: cannot persist state to {STATE}: {exc}", file=sys.stderr)

    def _load(self):
        try:
            with open(STATE) as f: data=json.load(f)
        except (OSError, ValueError):
            return
        now=time.time()
        for sid, paths in data.items():
            for p in paths:
                self.path_sid[p]=sid
                self.sid_files.setdefault(sid,{})[p]=now

    # ---- deletion ----
    def delete_session(self, sid):
        """Remove every tracked path for a session, deepest first so that
        directories can be rmdir'd once they are empty."""
        removed=[]; failed=[]
        for p in sorted(self.sid_files.get(sid,{}), key=len, reverse=True):
            try:
                if os.path.isdir(p) and not os.path.islink(p): os.rmdir(p)
                else: os.unlink(p)
                removed.append(p)
            except OSError as e:
                # Something the session created is already gone, or the directory
                # still holds files it did not create; report only real failures.
                if os.path.lexists(p): failed.append({"path":p,"error":str(e)})
                else: removed.append(p)
            self.path_sid.pop(p, None)
        self.sid_files.pop(sid, None)
        # Remove directories the session created that we never managed to attribute.
        # A directory only qualifies if it did not exist when the watcher started,
        # so a pre-existing (possibly empty) directory is never removed, and rmdir
        # fails harmlessly on anything that still holds files.
        for path in removed if RMDIR_ORPHANS else []:
            parent=os.path.dirname(path)
            while parent and parent not in self.preexisting_dirs:
                if parent in self.path_sid:
                    break                      # another session's tree, or still tracked
                try:
                    os.rmdir(parent)
                    removed.append(parent)
                except OSError:
                    break                      # not empty, or not ours to remove
                parent=os.path.dirname(parent)
        if removed or failed: self.save()
        return {"removed":removed, "failed":failed}

    def sweep(self):
        """Delete tracked files for sessions that no longer have a live unit."""
        live=live_session_ids()
        if live is None:
            return {"skipped":"live unit directory unreadable", "removed":0}
        stale=[sid for sid in self.sid_files if sid not in live]
        removed=0; failed=[]
        for sid in stale:
            res=self.delete_session(sid)
            removed+=len(res["removed"]); failed.extend(res["failed"])
            self.stats["swept_sessions"]+=1
        return {"sessions":stale, "removed":removed, "failed":failed}

    # ---- ipc ----
    def reply(self, req):
        if req=="stats":
            o=dict(self.stats)
            o.update({"sessions":len(self.sid_files),
                      "files":sum(len(v) for v in self.sid_files.values()),
                      "pid_cache":len(self.pid_cache),
                      "dirs":sum(len(d) for d in self.dirmaps.values()),
                      "pid":os.getpid(),
                      "min_bytes":MIN_FILE_BYTES, "small_ttl":SMALL_FILE_TTL,
                      "max_files":MAX_FILES_PER_SESSION, "rmdir_orphans":RMDIR_ORPHANS})
            return o
        if req=="dump": return {s:sorted(v) for s,v in self.sid_files.items()}
        if req.startswith("files "): return sorted(self.sid_files.get(req.split(None,1)[1],{}))
        if req.startswith("delete "):
            return self.delete_session(req.split(None,1)[1])
        if req=="sweep": return self.sweep()
        if req=="prune": self.reconcile(); self.save(); return "ok"
        if req=="save": self.save(); return "ok"
        if req=="quit": self._stop=True; return "bye"
        return {"error":"unknown request"}

    def run(self):
        last_reconcile=time.time(); last_sweep=time.time()
        while not self._stop:
            try:
                r,_,_=select.select([*self.fds, self.ls, *self.conns], [], [], 0.25)
            except OSError:
                break
            for s in r:
                if s in self.fds:
                    try: data=os.read(s, 1<<18)
                    except BlockingIOError: continue
                    except OSError: return
                    if data: self.parse(data, self.fds[s])
                elif s is self.ls:
                    try: c,_=self.ls.accept()
                    except OSError:
                        # never spin: a transient failure (EMFILE, ECONNABORTED)
                        # leaves the connection pending and select would report
                        # the listener readable again immediately.
                        time.sleep(0.05); continue
                    c.setblocking(False); self.conns[c]=b""
                else:
                    try: chunk=s.recv(4096)
                    except BlockingIOError: continue
                    except OSError: chunk=b""
                    if not chunk:
                        self.conns.pop(s, None)
                        try: s.close()
                        except OSError: pass
                        continue
                    buf=self.conns[s]+chunk
                    if b"\n" not in buf:
                        self.conns[s]=buf; continue
                    req=buf.split(b"\n",1)[0].decode().strip()
                    self.conns[s]=b""
                    try: s.sendall(json.dumps(self.reply(req)).encode()+b"\n")
                    except OSError: pass
            now=time.time()
            if self.overflow_pending:
                self.rescan()
            if now-last_reconcile>RECONCILE_INTERVAL:
                self.reconcile(); self.save(); last_reconcile=now
            if SWEEP_INTERVAL>0 and now-last_sweep>SWEEP_INTERVAL:
                res=self.sweep()
                self.stats["swept_files"]+=res.get("removed",0)
                last_sweep=now


def main():
    w=Watcher()
    res=w.sweep()
    w.stats["swept_files"]+=res.get("removed",0)
    print(f"tmpwatch pid={os.getpid()} uid={os.getuid()} roots={ROOTS} "
          f"dirs={sum(len(d) for d in w.dirmaps.values())} sock={SOCK}", flush=True)
    try: w.run()
    finally:
        w.save()
        try: os.unlink(SOCK)
        except OSError: pass


if __name__ == "__main__":
    main()
