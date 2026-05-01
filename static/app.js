window.addEventListener("error", e => {
  const el = document.getElementById("toast");
  if (el) {
    el.textContent = e.message;
    el.classList.add("active");
    setTimeout(() => el.classList.remove("active"), 5000);
  }
});

window.addEventListener("unhandledrejection", e => {
  const el = document.getElementById("toast");
  if (el) {
    el.textContent = String(e.reason);
    el.classList.add("active");
    setTimeout(() => el.classList.remove("active"), 5000);
  }
});

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function stringToBase64(text) {
  return bytesToBase64(new TextEncoder().encode(text));
}

function base64ToBytes(text) {
  if (!text) return new Uint8Array();
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function copyToClipboard(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    return navigator.clipboard.writeText(text).catch(() => copyToClipboardFallback(text));
  }
  return copyToClipboardFallback(text);
}

function copyToClipboardFallback(text) {
  const active = document.activeElement;
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
  if (active) active.focus();
}

const FILE_CANDIDATE_EXT = "[A-Za-z0-9][A-Za-z0-9._-]{0,15}";
const QUOTED_FILE_RE = new RegExp("([\"'])([^\"'\\r\\n]{1,400}\\." + FILE_CANDIDATE_EXT + ")\\1", "g");
const UNQUOTED_FILE_RE = new RegExp("(?:file://)?(?:~|\\.{1,2}|/)?[A-Za-z0-9_@%+=:,./~\\\\-]*[A-Za-z0-9_@%+=:,/~\\\\-]\\." + FILE_CANDIDATE_EXT, "g");
const FILE_CHECK_FAIL_TTL_MS = 1000;
const URL_RE = /\bhttps?:\/\/[^\s'"<>]+/g;

function extractFileCandidates(text) {
  const out = [];
  const quotedSpans = [];
  const add = (raw, index) => {
    raw = raw.replace(/\\/g, "/").replace(/[),.;:]+$/g, "");
    if (!raw || raw.length > 400 || !raw.includes(".")) return;
    out.push({ raw, index });
  };
  for (const match of text.matchAll(QUOTED_FILE_RE)) {
    quotedSpans.push([match.index, match.index + match[0].length]);
    add(match[2], match.index + 1);
  }
  for (const match of text.matchAll(UNQUOTED_FILE_RE)) {
    if (quotedSpans.some(([start, end]) => match.index >= start && match.index < end)) continue;
    add(match[0], match.index);
  }
  return out;
}

function trimUrl(raw) {
  while (/[),.;:!?]$/.test(raw)) raw = raw.slice(0, -1);
  return raw;
}

function extractUrlCandidates(text) {
  const out = [];
  for (const match of text.matchAll(URL_RE)) {
    const raw = trimUrl(match[0]);
    if (raw) out.push({ raw, index: match.index });
  }
  return out;
}

function fileUrlFor(info, download = false) {
  if (download && info.download_url) return info.download_url;
  return info.url || info.download_url || "";
}

function stripTerminalControls(text) {
  return text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r/g, "\n");
}

function waitForPywebview() {
  if (window.pywebview && window.pywebview.api) {
    return Promise.resolve(window.pywebview.api);
  }
  return new Promise(resolve => {
    window.addEventListener("pywebviewready", () => resolve(window.pywebview.api), { once: true });
  });
}

function getEnvoyPath() {
  const prefix = "/envoy";
  const pathname = window.location.pathname || "/";
  if (!pathname.startsWith(prefix)) {
    return "/";
  }
  const trimmed = pathname.slice(prefix.length);
  return trimmed || "/";
}

class PywebviewTransport {
  constructor(api = null) {
    this.api = api;
    this.sessionId = "";
    this.clientId = "";
    this.closed = false;
    this._pushCallbackName = "";
    this._streamCallbacks = null;
    this._paused = false;
  }

  async init() {
    this.api = this.api || await waitForPywebview();
    return this.api.get_config();
  }

  clone() {
    return new PywebviewTransport(this.api);
  }

  async getSettings() {
    return this.api.get_settings();
  }

  async saveSettings(values) {
    return this.api.save_settings(values);
  }

  async connect(existingSessionId) {
    const result = await this.api.connect(existingSessionId || "");
    this.sessionId = result.sid;
    this.clientId = result.client_id || "";
    this.closed = false;
    return result;
  }

  startReading(onData, onDisconnect, onEvents, onPromoted) {
    this.stopReading();
    if (!this.sessionId || !this.clientId) return;
    this.closed = false;
    this._paused = false;
    this._streamCallbacks = { onData, onDisconnect, onEvents, onPromoted };
    this._pushCallbackName = `__envoyPush_${this.clientId}`;
    const isActive = () => !this.closed && !!this.sessionId && window[this._pushCallbackName];
    window[this._pushCallbackName] = (jsonStr) => {
      if (!isActive()) return;
      const result = JSON.parse(jsonStr);
      if (result.evicted) {
        this.closed = true;
        delete window[this._pushCallbackName];
        onDisconnect({ kind: "evicted" });
        return;
      }
      const chunk = base64ToBytes(result.output);
      if (chunk.length) onData(chunk);
      if (result.events && result.events.length) onEvents(result.events);
      if (result.promoted) {
        if (onPromoted) onPromoted();
      }
      if (result.resize && this.onResize) {
        this.onResize(result.resize.cols, result.resize.rows);
      }
      if (!result.alive) {
        this.closed = true;
        delete window[this._pushCallbackName];
        onDisconnect({ kind: "exit", exitCode: result.exit_code });
      }
    };
    this.api.start_push(this.sessionId, this.clientId).catch(err => {
      if (!isActive()) return;
      this.closed = true;
      delete window[this._pushCallbackName];
      onDisconnect({ kind: "error", error: err });
    });
  }

  stopReading() {
    this.closed = true;
    const callbackName = this._pushCallbackName;
    if (callbackName) {
      delete window[callbackName];
      this._pushCallbackName = "";
    }
    if (this.sessionId && this.clientId) {
      this.api.stop_push(this.sessionId, this.clientId).catch(() => {});
    }
  }

  pauseStream() {
    this._paused = true;
    this.stopReading();
  }

  resumeReading() {
    if (!this._paused || !this._streamCallbacks || !this.sessionId || !this.clientId) return;
    this._paused = false;
    const { onData, onDisconnect, onEvents, onPromoted } = this._streamCallbacks;
    this.startReading(onData, onDisconnect, onEvents, onPromoted);
  }

  async write(data) {
    if (!this.sessionId) return;
    const transformed = window.__envoyTransformWriteData ? window.__envoyTransformWriteData(data) : data;
    if (transformed == null) return;
    if (transformed instanceof Uint8Array) {
      await this.api.write(this.sessionId, bytesToBase64(transformed));
      return;
    }
    await this.api.write(this.sessionId, stringToBase64(transformed));
  }

  async writeBytes(bytes) {
    if (!this.sessionId) return;
    await this.api.write(this.sessionId, bytesToBase64(bytes));
  }

  async resize(cols, rows) {
    if (!this.sessionId) return;
    await this.api.resize(this.sessionId, cols, rows, this.clientId);
  }

  async uploadFile(name, b64data) {
    if (!this.sessionId) return;
    await this.api.upload_file(this.sessionId, name, b64data);
  }

  async resolveFiles(paths) {
    if (!this.sessionId || !paths.length) return { files: [] };
    return this.api.resolve_files(this.sessionId, paths);
  }

  async openFile(info, download = false) {
    const result = await this.api.read_file(this.sessionId, info.path);
    const bytes = base64ToBytes(result.data);
    const blob = new Blob([bytes], { type: result.mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    if (download) a.download = result.name || "download";
    a.target = "_blank";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  async readFileText(path) {
    const result = await this.api.read_file(this.sessionId, path);
    const bytes = base64ToBytes(result.data);
    return new TextDecoder().decode(bytes);
  }

  async sendTextMessage(text, agentSettings) {
    return this.api.send_text_message(this.sessionId, text, agentSettings || {});
  }

  async sendVoiceMessage(audioBlob, mime, agentSettings) {
    const bytes = new Uint8Array(await audioBlob.arrayBuffer());
    return this.api.send_voice_message(this.sessionId, bytesToBase64(bytes), mime, agentSettings || {});
  }

  async transcribeAudio(audioBlob, mime) {
    const bytes = new Uint8Array(await audioBlob.arrayBuffer());
    return this.api.transcribe_audio(bytesToBase64(bytes), mime);
  }

  async cancelAgent() {
    if (!this.sessionId) return;
    await this.api.cancel_agent(this.sessionId);
  }

  async detach() {
    this.stopReading();
    if (!this.sessionId) return;
    this.sessionId = "";
  }

  async close() {
    this.stopReading();
    if (!this.sessionId) return;
    const sid = this.sessionId;
    this.sessionId = "";
    await this.api.close_session(sid);
  }

  abandon() {
    this.stopReading();
    this.sessionId = "";
  }

  async toggleFullscreen() {
    await this.api.toggle_fullscreen();
  }

  async closeApp() {
    await this.api.close_app();
  }
}

class BrowserTransport {
  constructor(basePath = "/envoy", targetPath = getEnvoyPath()) {
    this.basePath = basePath;
    this.targetPath = targetPath;
    this.sessionId = "";
    this.clientId = "";
    this.role = "lead";
    this.closed = false;
    this.eventSource = null;
  }

  async requestJson(path, options = {}) {
    const response = await fetch(this.basePath + path, {
      credentials: "same-origin",
      ...options,
      headers: {
        ...(options.headers || {}),
      },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `${response.status} ${response.statusText}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  async init() {
    return this.requestJson(`/api/config?path=${encodeURIComponent(this.targetPath)}`);
  }

  clone() {
    return new BrowserTransport(this.basePath, this.targetPath);
  }

  async getSettings() {
    return this.requestJson("/api/settings");
  }

  async saveSettings(values) {
    return this.requestJson("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(values),
    });
  }

  async connect(existingSessionId, mode = "takeover") {
    const result = await this.requestJson("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: this.targetPath, session_id: existingSessionId || "", mode }),
    });
    this.sessionId = result.sid;
    this.clientId = result.client_id || "";
    this.role = result.role || "lead";
    return result;
  }

  startReading(onData, onDisconnect, onEvents, onPromoted) {
    this.stopReading();
    this._streamCallbacks = { onData, onDisconnect, onEvents, onPromoted };
    this.closed = false;
    this._paused = false;
    BrowserStreamMultiplexer.instance(this.basePath).register(this);
  }

  _openStream() {
    if (!this._streamCallbacks) return;
    const { onData, onDisconnect, onEvents, onPromoted } = this._streamCallbacks;
    const url = new URL(this.basePath + "/api/stream", location.origin);
    url.searchParams.set("session_id", this.sessionId);
    url.searchParams.set("client_id", this.clientId);
    const es = new EventSource(url);
    this.eventSource = es;
    const isActive = () => !this.closed && !this._paused && this.eventSource === es;
    es.onmessage = (e) => {
      if (!isActive()) return;
      const result = JSON.parse(e.data);
      const chunk = base64ToBytes(result.output);
      if (chunk.length) onData(chunk);
      if (result.events && result.events.length) onEvents(result.events);
      if (!result.alive) {
        es.close();
        onDisconnect({ kind: "exit", exitCode: result.exit_code });
      }
    };
    es.addEventListener("evicted", () => {
      es.close();
      if (isActive()) onDisconnect({ kind: "evicted" });
    });
    es.addEventListener("promoted", () => {
      if (!isActive()) return;
      this.role = "lead";
      if (onPromoted) onPromoted();
    });
    es.addEventListener("resize", (e) => {
      if (!isActive()) return;
      const { cols, rows } = JSON.parse(e.data);
      if (this.onResize) this.onResize(cols, rows);
    });
    es.onerror = () => {
      if (!isActive()) return;
      if (es.readyState === EventSource.CLOSED) {
        const suppress = document.hidden || (performance.now() - (this._visibleAt || 0) < 1500);
        if (suppress) {
          this._paused = true;
          this.eventSource = null;
          if (!document.hidden) queueMicrotask(() => { try { this.resumeReading(); } catch {} });
          return;
        }
        onDisconnect({ kind: "error", error: new Error("stream closed") });
      }
    };
  }

  _handleStreamResult(result) {
    if (this.closed || this._paused || !this._streamCallbacks) return;
    const { onData, onDisconnect, onEvents, onPromoted } = this._streamCallbacks;
    if (result.evicted) {
      this.closed = true;
      onDisconnect({ kind: "evicted" });
      return;
    }
    const chunk = base64ToBytes(result.output);
    if (chunk.length) onData(chunk);
    if (result.events && result.events.length) onEvents(result.events);
    if (result.promoted) {
      this.role = "lead";
      if (onPromoted) onPromoted();
    }
    if (result.resize && this.onResize) {
      this.onResize(result.resize.cols, result.resize.rows);
    }
    if (!result.alive) {
      this.closed = true;
      onDisconnect({ kind: "exit", exitCode: result.exit_code });
    }
  }

  pauseStream() {
    if (this._paused) return;
    this._paused = true;
    BrowserStreamMultiplexer.instance(this.basePath).unregister(this);
    if (this.eventSource) {
      const es = this.eventSource;
      this.eventSource = null;
      try { es.close(); } catch {}
    }
  }

  resumeReading() {
    if (this.closed || !this._streamCallbacks || !this.sessionId) return;
    this._paused = false;
    this._visibleAt = performance.now();
    BrowserStreamMultiplexer.instance(this.basePath).register(this);
  }

  stopReading() {
    this.closed = true;
    BrowserStreamMultiplexer.instance(this.basePath).unregister(this);
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
  }

  write(data) {
    if (!this.sessionId) return Promise.resolve();
    const transformed = window.__envoyTransformWriteData ? window.__envoyTransformWriteData(data) : data;
    if (transformed == null) return Promise.resolve();
    return this._enqueueWrite(transformed);
  }

  writeBytes(bytes) {
    if (!this.sessionId) return Promise.resolve();
    return this._enqueueWrite(bytes);
  }

  _enqueueWrite(data) {
    return new Promise((resolve, reject) => {
      (this._writeQueue || (this._writeQueue = [])).push({ data, resolve, reject });
      if (!this._writeInFlight) this._flushWrites();
    });
  }

  _combineWriteEntries(entries) {
    const parts = entries.map(e => e.data instanceof Uint8Array ? e.data : new TextEncoder().encode(e.data));
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) { out.set(p, offset); offset += p.length; }
    return out;
  }

  async _flushWrites() {
    if (this._writeInFlight) return;
    this._writeInFlight = true;
    try {
      while (this._writeQueue && this._writeQueue.length) {
        const batch = this._writeQueue;
        this._writeQueue = [];
        const payload = bytesToBase64(this._combineWriteEntries(batch));
        try {
          await this.requestJson("/api/write", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: this.sessionId, data: payload }),
          });
          for (const entry of batch) entry.resolve();
          this._writeRetries = 0;
        } catch (err) {
          if (err?.status) {
            for (const entry of batch) entry.reject(err);
          } else {
            this._writeQueue = batch.concat(this._writeQueue);
            const attempt = (this._writeRetries || 0) + 1;
            this._writeRetries = attempt;
            await new Promise(r => setTimeout(r, Math.min(2000, 100 * attempt)));
          }
        }
      }
    } finally {
      this._writeInFlight = false;
    }
  }

  async resize(cols, rows) {
    if (!this.sessionId) return;
    if (this.role === "follow") return;
    await this.requestJson("/api/resize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: this.sessionId, client_id: this.clientId, cols, rows }),
    });
  }

  waitForStream() {
    return BrowserStreamMultiplexer.instance(this.basePath).whenConnected();
  }

  async uploadFile(name, b64data) {
    if (!this.sessionId) return;
    await this.requestJson("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: this.sessionId, name, data: b64data }),
    });
  }

  async resolveFiles(paths) {
    if (!this.sessionId || !paths.length) return { files: [] };
    return this.requestJson("/api/resolve_files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: this.sessionId, paths }),
    });
  }

  async openFile(info, download = false) {
    const url = fileUrlFor(info, download);
    if (!url) return;
    if (download) {
      const iframe = document.createElement("iframe");
      iframe.style.display = "none";
      iframe.src = url;
      document.body.appendChild(iframe);
      setTimeout(() => iframe.remove(), 60000);
    } else {
      window.open(url, "_blank");
    }
  }

  async readFileText(path) {
    const url = fileUrlFor({ url: this.basePath + `/api/file?session_id=${encodeURIComponent(this.sessionId)}&path=${encodeURIComponent(path)}` });
    const resp = await fetch(url);
    return resp.text();
  }

  async sendTextMessage(text, agentSettings) {
    return this.requestJson("/api/text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: this.sessionId, text, ...agentSettings }),
    });
  }

  async sendVoiceMessage(audioBlob, mime, agentSettings) {
    const headers = {
      "Content-Type": mime,
      "X-Session-Id": this.sessionId,
    };
    if (agentSettings) {
      headers["X-Agent-Persistence"] = agentSettings.agent_persistence || "";
      headers["X-Agent-Lookback"] = String(agentSettings.agent_lookback ?? "");
      headers["X-Agent-Turn-Limit"] = String(agentSettings.agent_turn_limit ?? "");
    }
    const response = await fetch(this.basePath + "/api/voice", {
      method: "POST",
      headers,
      body: audioBlob,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
    return data;
  }

  async transcribeAudio(audioBlob, mime) {
    const response = await fetch(this.basePath + "/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": mime },
      body: audioBlob,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `${response.status} ${response.statusText}`);
    return data;
  }

  async cancelAgent() {
    if (!this.sessionId) return;
    await this.requestJson("/api/voice/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: this.sessionId }),
    });
  }

  async detach() {
    this.stopReading();
    if (!this.sessionId) return;
    const sid = this.sessionId;
    const cid = this.clientId;
    this.sessionId = "";
    this.clientId = "";
    await this.requestJson("/api/detach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sid, client_id: cid }),
    });
  }

  async close() {
    this.stopReading();
    if (!this.sessionId) return;
    const sid = this.sessionId;
    this.sessionId = "";
    this.clientId = "";
    await this.requestJson("/api/close_session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sid }),
    });
  }

  abandon() {
    this.stopReading();
    this.sessionId = "";
    this.clientId = "";
  }

  async closeApp() {}
}

class BrowserStreamMultiplexer {
  static _instances = new Map();

  static instance(basePath) {
    if (!this._instances.has(basePath)) {
      this._instances.set(basePath, new BrowserStreamMultiplexer(basePath));
    }
    return this._instances.get(basePath);
  }

  constructor(basePath) {
    this.basePath = basePath;
    this.transports = new Map();
    this.eventSource = null;
    this.reopenTimer = null;
  }

  keyFor(transport) {
    return `${transport.sessionId}:${transport.clientId}`;
  }

  register(transport) {
    if (!transport.sessionId || !transport.clientId || transport.closed || transport._paused) return;
    this.transports.set(this.keyFor(transport), transport);
    this.scheduleOpen();
  }

  unregister(transport) {
    this.transports.delete(this.keyFor(transport));
    this.scheduleOpen();
  }

  scheduleOpen() {
    if (this.reopenTimer) clearTimeout(this.reopenTimer);
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null;
      this.open();
    }, 0);
  }

  open() {
    if (this.eventSource) {
      try { this.eventSource.close(); } catch {}
      this.eventSource = null;
    }
    const entries = this.activeEntries();
    if (!entries.length) return;

    const url = new URL(this.basePath + "/api/stream_all", location.origin);
    for (const [key] of entries) url.searchParams.append("pair", key);
    const es = new EventSource(url);
    this.eventSource = es;
    this._connectedResolve = null;
    this._connected = new Promise(r => { this._connectedResolve = r; });
    es.addEventListener("open", () => { if (this._connectedResolve) { this._connectedResolve(); this._connectedResolve = null; } }, { once: true });
    const isActive = () => this.eventSource === es;
    es.onmessage = e => {
      if (!isActive()) return;
      const result = JSON.parse(e.data);
      const key = `${result.session_id}:${result.client_id}`;
      const transport = this.transports.get(key);
      if (transport) transport._handleStreamResult(result);
    };
    es.onerror = () => {
      if (!isActive()) return;
      if (es.readyState === EventSource.CLOSED) {
        this.eventSource = null;
        setTimeout(() => this.open(), 1000);
      }
    };
  }

  activeEntries() {
    return Array.from(this.transports.entries())
      .filter(([_key, transport]) => !transport.closed && !transport._paused && transport._streamCallbacks);
  }

  whenConnected(timeout = 5000) {
    if (!this._connected) return Promise.resolve();
    return Promise.race([
      this._connected,
      new Promise(resolve => setTimeout(resolve, timeout)),
    ]);
  }
}

async function loadTransport() {
  if (window.pywebview && window.pywebview.api) {
    return new PywebviewTransport();
  }
  if (location.protocol === "file:") {
    const api = await waitForPywebview();
    return new PywebviewTransport(api);
  }
  return new BrowserTransport();
}

class TerminalTab {
  constructor(manager, transport, index) {
    this.manager = manager;
    this.transport = transport;
    this.index = index;
    this.title = `Tab ${index}`;
    this.role = "lead";
    this.ptySize = null;
    this.disconnected = false;
    this.disconnectInfo = null;
    this.closed = false;
    this.reconnecting = false;
    this.hasInput = false;
    this.agentLog = [];
    this.liveAgentEvents = [];
    this.resolvedFiles = new Map();
    this.checkedFileCandidates = new Map();
    this.fileScanTail = "";
    this.fileResolveTimer = null;
    this.pendingFileCandidates = new Set();

    this.pane = document.createElement("div");
    this.pane.className = "terminal-pane";
    this.host = document.createElement("div");
    this.host.className = "terminal-host";
    this.pane.appendChild(this.host);

    this.term = new Terminal({
      cursorBlink: true,
      fontSize: parseInt(localStorage.getItem("envoy-font-size")) || 17,
      fontFamily: "'Source Code Pro', monospace",
      scrollback: 10000,
    });
    this.fit = new FitAddon.FitAddon();
    this.serialize = new SerializeAddon.SerializeAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.serialize);
    this.term.open(this.host);
    this.term.registerLinkProvider({
      provideLinks: (line, callback) => callback(this.provideUrlLinks(line)),
    });
    this.term.registerLinkProvider({
      provideLinks: (line, callback) => callback(this.provideFileLinks(line)),
    });
    this.term.attachCustomKeyEventHandler(e => {
      if (e.key === "AltGraph" && e.code === "CapsLock") {
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.key === "C" && e.type === "keydown") {
        const sel = this.term.getSelection();
        if (sel) copyToClipboard(sel);
        return false;
      }
      if (e.ctrlKey && e.shiftKey && e.key === "V") return false;
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "ArrowLeft" && e.type === "keydown") {
        this.transport.write("\x1bb").catch(err => this.handleWriteError(err));
        return false;
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key === "ArrowRight" && e.type === "keydown") {
        this.transport.write("\x1bf").catch(err => this.handleWriteError(err));
        return false;
      }
      return true;
    });
    this.updateScrollbackClass();
    this.button = document.createElement("div");
    this.button.className = "tab-item";
    this.button.draggable = true;
    this.button.innerHTML = `<span class="tab-title"></span><input class="tab-title-input" type="text" spellcheck="false"><button class="tab-close" type="button" title="Close tab">&times;</button>`;
    this.button.querySelector(".tab-title").textContent = this.title;
    this.button.addEventListener("click", () => this.manager.activateTab(this.id));
    const titleSpan = this.button.querySelector(".tab-title");
    const titleInput = this.button.querySelector(".tab-title-input");
    const startEditing = () => {
      titleInput.value = this.title;
      this.button.classList.add("editing");
      titleInput.focus();
      titleInput.setSelectionRange(titleInput.value.length, titleInput.value.length);
    };
    titleSpan.addEventListener("click", e => {
      if (this.manager.activeTab !== this) return;
      const range = document.createRange();
      range.selectNodeContents(titleSpan);
      const textRect = range.getBoundingClientRect();
      if (e.clientX > textRect.right) return;
      e.stopPropagation();
      startEditing();
    });
    let longPressTimer = null;
    this.button.addEventListener("touchstart", () => {
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        const val = prompt("Rename tab", this.title);
        if (val === null) return;
        const newTitle = val.trim() || this.transport.sessionId || `Tab ${this.index}`;
        this.updateTitle(newTitle);
        if (this.transport.sessionId) {
          const basePath = this.transport.basePath || "/envoy";
          fetch(basePath + "/api/rename_session", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: this.transport.sessionId, title: val.trim() }),
          }).catch(() => {});
        }
        this.manager.saveTabState();
      }, 500);
    });
    this.button.addEventListener("touchend", () => { if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; } });
    this.button.addEventListener("touchmove", () => { if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; } });
    this.button.addEventListener("dragstart", e => {
      this.manager._dragTab = this;
      this.button.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    this.button.addEventListener("dragend", () => {
      this.button.classList.remove("dragging");
      this.manager._dragTab = null;
      for (const el of this.manager.elements.tabs.children) {
        el.classList.remove("drag-over-left", "drag-over-right");
      }
    });
    this.button.addEventListener("dragover", e => {
      if (!this.manager._dragTab || this.manager._dragTab === this) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      const rect = this.button.getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      this.button.classList.toggle("drag-over-left", e.clientX < mid);
      this.button.classList.toggle("drag-over-right", e.clientX >= mid);
    });
    this.button.addEventListener("dragleave", () => {
      this.button.classList.remove("drag-over-left", "drag-over-right");
    });
    this.button.addEventListener("drop", e => {
      e.preventDefault();
      this.button.classList.remove("drag-over-left", "drag-over-right");
      const from = this.manager._dragTab;
      if (!from || from === this) return;
      const rect = this.button.getBoundingClientRect();
      const mid = rect.left + rect.width / 2;
      const before = e.clientX < mid;
      this.manager.moveTab(from, this, before);
    });
    const commitTitle = () => {
      this.button.classList.remove("editing");
      const val = titleInput.value.trim();
      const newTitle = val || this.transport.sessionId || `Tab ${this.index}`;
      this.updateTitle(newTitle);
      if (this.transport.sessionId) {
        const basePath = this.transport.basePath || "/envoy";
        fetch(basePath + "/api/rename_session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: this.transport.sessionId, title: val }),
        }).catch(() => {});
      }
      this.manager.saveTabState();
      this.focus();
    };
    titleInput.addEventListener("blur", commitTitle);
    titleInput.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter") { e.preventDefault(); titleInput.blur(); }
      else if (e.key === "Escape") { e.preventDefault(); titleInput.value = this.title; titleInput.blur(); }
    });
    titleInput.addEventListener("click", e => e.stopPropagation());
    this.button.querySelector(".tab-close").addEventListener("click", e => {
      e.stopPropagation();
      this.manager.closeTab(this.id);
    });

    this.term.onData(data => {
      if (!this.disconnected && !this._suppressInput) {
        this.hasInput = true;
        this.transport.write(data).catch(err => this.handleWriteError(err));
      }
    });
    this.term.onRender(() => this.updateScrollbackClass());
    this.lastMeasuredSize = { width: 0, height: 0 };
    this.resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
      if (this.manager.activeTab !== this) return;
      const rect = this.host.getBoundingClientRect();
      const width = Math.round(rect.width);
      const height = Math.round(rect.height);
      if (!width || !height) return;
      if (width === this.lastMeasuredSize.width && height === this.lastMeasuredSize.height) return;
      this.lastMeasuredSize = { width, height };
      requestAnimationFrame(() => {
        if (this.manager.activeTab === this) this.fitTerminal();
      });
    }) : null;
    this.resizeObserver?.observe(this.host);
  }

  get id() {
    return this.transport.sessionId || `pending-${this.index}`;
  }

  async connect(existingSessionId = "", mode = "takeover") {
    const result = await this.transport.connect(existingSessionId, mode);
    this.isNew = !existingSessionId;
    this.role = result.role || "lead";
    this.ptySize = (result.cols && result.rows) ? { cols: result.cols, rows: result.rows } : null;
    this.button.dataset.sid = result.sid;
    this.updateRoleIndicator();
    this.updateTitle(result.custom_title || result.sid || this.title);
    this.term.reset();
    // For follow clients, adopt the PTY's size before writing scrollback
    if (this.role === "follow" && this.ptySize) {
      const baseFontSize = parseInt(localStorage.getItem("envoy-font-size")) || 17;
      this.term.options.fontSize = baseFontSize;
      const dims = this.fit.proposeDimensions();
      if (dims && (dims.cols < this.ptySize.cols || dims.rows < this.ptySize.rows)) {
        const scale = Math.min(dims.cols / this.ptySize.cols, dims.rows / this.ptySize.rows);
        this.term.options.fontSize = Math.max(4, Math.floor(baseFontSize * scale));
      }
      try { this.term.resize(this.ptySize.cols, this.ptySize.rows); } catch {}
    }
    if (result.archive_text) {
      this._suppressInput = true;
      this.term.write(result.archive_text.replace(/\n/g, "\r\n"));
    }
    const chunk = base64ToBytes(result.output);
    if (result.reconnect_debug) {
      const debug = {
        sid: result.sid,
        archiveTextChars: result.archive_text ? result.archive_text.length : 0,
        rawReplayBytes: chunk.length,
        ...result.reconnect_debug,
      };
      console.info("envoy reconnect debug", debug);
      this._lastReconnectDebug = debug;
    } else {
      this._lastReconnectDebug = null;
    }
    this.resetFileLinks();
    this.scanTerminalText(result.archive_text || "");
    if (chunk.length) {
      this._suppressInput = true;
      this.term.write(chunk, () => { this._suppressInput = false; });
      this.scanTerminalBytes(chunk);
    } else if (this._suppressInput) {
      this._suppressInput = false;
    }
    this.disconnected = false;
    this.disconnectInfo = null;
    this.reconnecting = false;
    this._autoReconnectAttempts = 0;
    if (this._autoReconnectTimer) {
      clearTimeout(this._autoReconnectTimer);
      this._autoReconnectTimer = null;
    }
    this.button.classList.remove("exited");
    this.updateScrollbackClass();
    this.transport.onResize = (cols, rows) => {
      this.ptySize = { cols, rows };
      if (this.role === "follow") {
        this.fitFollower();
      } else {
        try { this.term.resize(cols, rows); } catch {}
      }
    };
    this.transport.startReading(
      data => this.writeTerminalData(data),
      info => this.handleDisconnect(info),
      events => this.handleAgentEvents(events),
      () => this.handlePromotion(),
    );
  }

  resetFileLinks() {
    this.resolvedFiles.clear();
    this.checkedFileCandidates.clear();
    this.fileScanTail = "";
    this.pendingFileCandidates.clear();
  }

  writeTerminalData(data) {
    this.term.write(data);
    this.scanTerminalBytes(data);
  }

  scanTerminalBytes(bytes) {
    this.scanTerminalText(new TextDecoder().decode(bytes));
  }

  scanTerminalText(text) {
    if (!text) return;
    const plain = stripTerminalControls(this.fileScanTail + text);
    this.fileScanTail = plain.slice(-500);
    const now = Date.now();
    for (const item of extractFileCandidates(plain)) {
      if (this.resolvedFiles.has(item.raw)) continue;
      const lastFail = this.checkedFileCandidates.get(item.raw);
      if (lastFail && now - lastFail < FILE_CHECK_FAIL_TTL_MS) continue;
      this.pendingFileCandidates.add(item.raw);
    }
    if (this.pendingFileCandidates.size && !this.fileResolveTimer) {
      this.fileResolveTimer = setTimeout(() => this.flushFileCandidates(), 150);
    }
  }

  async flushFileCandidates() {
    this.fileResolveTimer = null;
    const paths = Array.from(this.pendingFileCandidates);
    this.pendingFileCandidates.clear();
    if (!paths.length || this.closed) return;
    try {
      const result = await this.transport.resolveFiles(paths);
      const resolved = new Set();
      for (const info of result.files || []) {
        this.resolvedFiles.set(info.raw, info);
        resolved.add(info.raw);
      }
      const now = Date.now();
      for (const path of paths) {
        if (!resolved.has(path)) this.checkedFileCandidates.set(path, now);
      }
      if (result.files?.length) this.term.refresh(0, this.term.rows - 1);
    } catch (err) {
      console.warn("envoy: file resolution failed", err);
    }
  }

  provideFileLinks(line) {
    const buffer = this.term.buffer.active;
    const bufLine = buffer.getLine(line - 1);
    if (!bufLine) return [];
    const text = bufLine.translateToString(false);
    return extractFileCandidates(text)
      .map(item => {
        const info = this.resolvedFiles.get(item.raw);
        if (!info) return null;
        return {
          text: item.raw,
          range: {
            start: { x: item.index + 1, y: line },
            end: { x: item.index + item.raw.length, y: line },
          },
          activate: () => this.openResolvedFile(info, false),
          hover: event => this.showFilePreview(info, event),
          leave: () => this.scheduleFilePreviewDismiss(),
        };
      })
      .filter(Boolean);
  }

  provideUrlLinks(line) {
    const buffer = this.term.buffer.active;
    const bufLine = buffer.getLine(line - 1);
    if (!bufLine) return [];
    const text = bufLine.translateToString(false);
    return extractUrlCandidates(text).map(item => ({
      text: item.raw,
      range: {
        start: { x: item.index + 1, y: line },
        end: { x: item.index + item.raw.length, y: line },
      },
      activate: () => window.open(item.raw, "_blank", "noopener"),
    }));
  }

  openResolvedFile(info, download) {
    this.hideFilePreview();
    if ((info.is_image || info.is_previewable) && !download) {
      this.manager.openFileViewer(info, this);
    } else {
      this.transport.openFile(info, download).catch(err => this.manager.showToast(String(err)));
    }
  }

  showFilePreview(info, event) {
    if (!info.is_image) {
      this.manager.showFileTooltip(info, event, this);
      return;
    }
    this.manager.showFileTooltip(info, event, this);
  }

  hideFilePreview() {
    this.manager.hideFileTooltip();
  }

  scheduleFilePreviewDismiss() {
    this.manager.scheduleFileTooltipDismiss();
  }

  updateRoleIndicator() {
    this.button.classList.toggle("follow-tab", this.role === "follow");
  }

  handlePromotion() {
    this.role = "lead";
    this.ptySize = null;
    this.term.options.fontSize = parseInt(localStorage.getItem("envoy-font-size")) || 17;
    this.updateRoleIndicator();
    this.fitTerminal();
  }

  show() {
    this.pane.classList.add("active");
    this.button.classList.add("active");
    this.scheduleActivationResize();
    this.focus();
  }

  hide() {
    this.pane.classList.remove("active");
    this.button.classList.remove("active");
    if (this._activationResizeTimer) {
      clearTimeout(this._activationResizeTimer);
      this._activationResizeTimer = null;
    }
  }

  scheduleActivationResize() {
    this.fitTerminal();
    if (this._activationResizeTimer) {
      clearTimeout(this._activationResizeTimer);
    }
    this._activationResizeTimer = setTimeout(() => {
      this._activationResizeTimer = null;
      if (this.manager.activeTab === this && !this.closed) {
        this.fitTerminal();
      }
    }, 1000);
  }

  fitTerminal() {
    if (!this.host.offsetWidth || !this.host.offsetHeight) return;
    try {
      this.term._core?._charSizeService?.measure();
    } catch {}
    if (this.role === "follow" && this.ptySize) {
      this.fitFollower();
    } else {
      this.term.options.fontSize = parseInt(localStorage.getItem("envoy-font-size")) || 17;
      this.fit.fit();
      try { this.term.resize(this.term.cols, this.term.rows); } catch {}
    }
    this.term.scrollToBottom();
    this.updateScrollbackClass();
    if (!this.disconnected) {
      this.transport.resize(this.term.cols, this.term.rows).catch(err => this.handleWriteError(err));
    }
  }

  fitFollower() {
    const baseFontSize = parseInt(localStorage.getItem("envoy-font-size")) || 17;
    this.term.options.fontSize = baseFontSize;
    const dims = this.fit.proposeDimensions();
    if (!dims || !dims.cols || !dims.rows) {
      try { this.term.resize(this.ptySize.cols, this.ptySize.rows); } catch {}
      return;
    }
    if (dims.cols < this.ptySize.cols || dims.rows < this.ptySize.rows) {
      const scale = Math.min(dims.cols / this.ptySize.cols, dims.rows / this.ptySize.rows);
      this.term.options.fontSize = Math.max(4, Math.floor(baseFontSize * scale));
    }
    try { this.term.resize(this.ptySize.cols, this.ptySize.rows); } catch {}
  }

  focus() {
    const textarea = this.host.querySelector(".xterm-helper-textarea");
    if (textarea) textarea.focus();
  }

  markDisconnected(info = { kind: "error" }) {
    if (this.disconnected) return;
    this.disconnected = true;
    this.disconnectInfo = info;
    this.reconnecting = false;
    this.button.classList.add("exited");
    if (this.manager.activeTab === this) {
      this.manager.updateDisconnectOverlay();
    }
  }

  handleWriteError(err) {
    if (err?.status) this.markDisconnected();
    else console.warn("envoy: transient write error", err);
  }

  handleDisconnect(info) {
    if (this.closed) return;
    if (info?.kind === "evicted") {
      this.markDisconnected(info);
      return;
    }
    if (info?.kind === "exit" && info.exitCode === 0) {
      this.manager.closeTab(this.id).catch(err => console.error(err));
      return;
    }
    this.markDisconnected(info);
    if (info?.kind === "error") this.scheduleAutoReconnect();
  }

  scheduleAutoReconnect() {
    if (this._autoReconnectTimer) return;
    const delay = Math.min(30000, 1000 * Math.pow(2, this._autoReconnectAttempts || 0));
    this._autoReconnectAttempts = (this._autoReconnectAttempts || 0) + 1;
    this._autoReconnectTimer = setTimeout(async () => {
      this._autoReconnectTimer = null;
      if (!this.canAutoReconnect()) return;
      const ok = await this.reconnect().catch(() => false);
      if (ok) {
        this._autoReconnectAttempts = 0;
      } else if (this.disconnected && !this.closed) {
        this.scheduleAutoReconnect();
      }
    }, delay);
  }

  canReconnect() {
    if (this.closed || !this.disconnected || this.reconnecting) return false;
    if (!this.transport.sessionId) return false;
    return this.disconnectInfo?.kind !== "exit";
  }

  canAutoReconnect() {
    return this.canReconnect() && this.disconnectInfo?.kind !== "evicted";
  }

  async reconnect() {
    if (!this.canReconnect()) return false;
    this.reconnecting = true;
    try {
      await this.connect(this.transport.sessionId);
      this.fitTerminal();
      if (this.manager.activeTab === this) {
        this.manager.updateDisconnectOverlay();
      }
      return true;
    } catch (err) {
      this.reconnecting = false;
      this.markDisconnected({ kind: "error", error: err });
      return false;
    }
  }

  resumeReading() {
    if (typeof this.transport.resumeReading === "function") {
      this.transport.resumeReading();
    }
  }

  updateTitle(title) {
    this.title = title;
    this.button.querySelector(".tab-title").textContent = title;
  }

  addAgentLog(response, commands, userMessage) {
    const time = new Date().toLocaleTimeString();
    this.agentLog.push({ time, response, commands, userMessage });
    this.liveAgentEvents = [];
  }

  addLiveAgentEvent(event) {
    const time = new Date().toLocaleTimeString();
    this.liveAgentEvents.push({ time, ...event });
  }

  handleAgentEvents(events) {
    for (const event of events) {
      this.addLiveAgentEvent(event);
      this.manager.handleAgentEvent(this, event);
    }
    if (this.manager.activeTab === this) {
      this.manager.renderAgentLog();
    }
  }

  updateScrollbackClass() {
    const buffer = this.term?.buffer?.active;
    const hasScrollback = !!buffer && buffer.baseY > 0;
    this.host.classList.toggle("has-scrollback", hasScrollback);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this._activationResizeTimer) {
      clearTimeout(this._activationResizeTimer);
      this._activationResizeTimer = null;
    }
    if (this._autoReconnectTimer) {
      clearTimeout(this._autoReconnectTimer);
      this._autoReconnectTimer = null;
    }
    this.resizeObserver?.disconnect();
    this.pane.remove();
    this.button.remove();
    const transport = this.transport;
    const exited = this.disconnected && this.disconnectInfo?.kind === "exit";
    setTimeout(() => {
      if (this.disconnected && this.disconnectInfo?.kind === "evicted" && typeof transport.abandon === "function") {
        transport.abandon();
        return;
      }
      if (exited || (this.isNew && !this.hasInput)) {
        transport.close().catch(err => console.error(err));
      } else if (typeof transport.detach === "function") {
        transport.detach().catch(err => console.error(err));
      } else {
        transport.close().catch(err => console.error(err));
      }
    }, 0);
  }
}

class TabManager {
  constructor(baseTransport, elements) {
    this.baseTransport = baseTransport;
    this.tabs = [];
    this.activeTab = null;
    this.nextIndex = 1;
    this.elements = elements;
    this._dragTab = null;
    this._bc = typeof BroadcastChannel === "function" ? new BroadcastChannel("envoy-tabs") : null;
    if (this._bc) {
      this._bc.onmessage = e => {
        if (e.data?.type === "claim-query") {
          this._bc.postMessage({ type: "claim-reply", sids: this.tabs.map(t => t.transport.sessionId).filter(Boolean) });
        }
      };
    }
  }

  async getClaimedSids() {
    if (!this._bc) return new Set();
    return new Promise(resolve => {
      const sids = new Set();
      const handler = e => {
        if (e.data?.type === "claim-reply") {
          for (const sid of e.data.sids) sids.add(sid);
        }
      };
      this._bc.addEventListener("message", handler);
      this._bc.postMessage({ type: "claim-query" });
      setTimeout(() => {
        this._bc.removeEventListener("message", handler);
        resolve(sids);
      }, 150);
    });
  }

  moveTab(from, to, before) {
    const fromIdx = this.tabs.indexOf(from);
    if (fromIdx < 0) return;
    this.tabs.splice(fromIdx, 1);
    let toIdx = this.tabs.indexOf(to);
    if (!before) toIdx++;
    this.tabs.splice(toIdx, 0, from);
    const parent = this.elements.tabs;
    if (before) {
      parent.insertBefore(from.button, to.button);
    } else {
      parent.insertBefore(from.button, to.button.nextSibling);
    }
    this.saveTabState();
  }

  saveTabState() {
    if (!window.matchMedia('(display-mode: standalone)').matches) return;
    const sids = this.tabs.map(t => t.transport.sessionId).filter(Boolean);
    const active = this.activeTab?.transport.sessionId || "";
    if (sids.length) {
      localStorage.setItem("envoy-tab-state", JSON.stringify({ tabs: sids, active }));
    } else {
      localStorage.removeItem("envoy-tab-state");
    }
  }

  static loadTabState() {
    try {
      const raw = localStorage.getItem("envoy-tab-state");
      if (!raw) return null;
      const state = JSON.parse(raw);
      if (Array.isArray(state.tabs) && state.tabs.length) return state;
    } catch {}
    return null;
  }

  updateTabBar() {
    const el = this.elements.tabs.parentElement;
    el.classList.toggle("single", this.tabs.length <= 1 && !el.classList.contains("force-show"));
  }

  syncHash() {
    const sid = this.activeTab?.transport.sessionId || "";
    const hash = sid ? "#" + sid : "";
    if (window.location.hash !== hash) {
      history.replaceState(null, "", hash || window.location.pathname + window.location.search);
    }
  }

  async createTab({ activate = true, sessionId = "", mode = "takeover" } = {}) {
    const tab = new TerminalTab(this, this.baseTransport.clone(), this.nextIndex++);
    this.tabs.push(tab);
    this.elements.stack.appendChild(tab.pane);
    this.elements.tabs.appendChild(tab.button);
    this.updateTabBar();
    await tab.connect(sessionId, mode);
    if (activate || !this.activeTab) this.activateTab(tab.id);
    this.syncHash();
    this.saveTabState();
    return tab;
  }

  getTabById(id) {
    return this.tabs.find(tab => tab.id === id) || null;
  }

  activateTab(id) {
    const tab = this.getTabById(id);
    if (!tab) return;
    if (this.activeTab) this.activeTab.hide();
    this.activeTab = tab;
    tab.show();
    const selOv = this.elements.selectOverlay || document.getElementById("select-overlay");
    if (selOv?.classList.contains("active")) {
      selOv.classList.remove("active");
      selOv.innerHTML = "";
      selOv.style.height = "";
      for (const x of this.elements.stack.querySelectorAll(".xterm.select-mode")) x.classList.remove("select-mode");
    }
    this.updateDisconnectOverlay();
    this.renderAgentLog();
    this.syncHash();
    this.saveTabState();
  }

  updateDisconnectOverlay() {
    const tab = this.activeTab;
    const disconnected = !!(tab && tab.disconnected);
    this.elements.disconnect.classList.toggle("active", disconnected);
    if (!this.elements.disconnectMessage || !this.elements.disconnectReconnect || !this.elements.disconnectClose) return;
    if (!disconnected) {
      this.elements.disconnectMessage.textContent = "Disconnected";
      this.elements.disconnectReconnect.disabled = false;
      this.elements.disconnectClose.disabled = false;
      return;
    }
    const kind = tab.disconnectInfo?.kind;
    this.elements.disconnectMessage.textContent = kind === "evicted" ? "Session evicted" : "Disconnected";
    this.elements.disconnectReconnect.disabled = !tab.canReconnect();
    this.elements.disconnectClose.disabled = false;
  }

  renderAgentLog() {
    const entries = this.activeTab ? this.activeTab.agentLog : [];
    const liveEvents = this.activeTab ? this.activeTab.liveAgentEvents : [];
    if (!entries.length && !liveEvents.length) {
      this.elements.agentLog.innerHTML = '<p class="voice-log-empty">No entries yet.</p>';
      return;
    }
    const liveHtml = liveEvents.map(event => {
      let html = '<div class="voice-log-entry live">';
      html += `<div class="voice-log-time">${event.time}</div>`;
      if (event.kind === "status") html += `<div class="voice-log-agent">${event.text}</div>`;
      if (event.kind === "message") html += `<div class="voice-log-agent">${event.text}</div>`;
      return html + "</div>";
    }).join("");
    const entryHtml = entries.map(entry => {
      let html = '<div class="voice-log-entry">';
      html += `<div class="voice-log-time">${entry.time}</div>`;
      if (entry.userMessage) html += `<div class="voice-log-you">${entry.userMessage}</div>`;
      if (entry.commands && entry.commands.length) {
        html += entry.commands.map(command => `<div class="voice-log-cmd">$ ${command}</div>`).join("");
      }
      if (entry.response) html += `<div class="voice-log-agent">${entry.response}</div>`;
      return html + "</div>";
    }).join("");
    this.elements.agentLog.innerHTML = liveHtml + entryHtml;
    this.elements.agentLog.scrollTop = this.elements.agentLog.scrollHeight;
  }

  handleAgentEvent(tab, event) {
    if (tab !== this.activeTab) return;
    if (!event || !event.text) return;
    if (this.showToast) this.showToast(event.text, false, true);
  }

  copyFilePath(info) {
    const path = info.path || info.raw || "";
    if (!path) return;
    Promise.resolve(copyToClipboard(path))
      .then(() => this.showToast?.("Path copied"))
      .catch(() => this.showToast?.("Failed to copy path"))
      .finally(() => requestAnimationFrame(() => this.activeTab?.focus()));
  }

  showFileTooltip(info, event, tab) {
    this.hideFileTooltip();
    const el = document.createElement("div");
    el.id = "file-tooltip";
    el.addEventListener("mouseenter", () => this.cancelFileTooltipDismiss());
    el.addEventListener("mouseleave", () => this.scheduleFileTooltipDismiss());
    const title = document.createElement("div");
    title.className = "file-tooltip-title";
    title.textContent = info.name || info.raw || info.path;
    el.appendChild(title);
    const meta = document.createElement("div");
    meta.className = "file-tooltip-meta";
    meta.textContent = `${info.mime || "file"} · ${this.formatBytes(info.size || 0)}`;
    el.appendChild(meta);
    if (info.is_image) {
      const img = document.createElement("img");
      if (info.preview_url) {
        img.src = info.preview_url;
      } else {
        const url = fileUrlFor(info);
        if (url) {
          fetch(url).then(r => r.blob()).then(blob => {
            img.src = URL.createObjectURL(blob);
          }).catch(() => {});
        }
      }
      img.alt = info.name || "image preview";
      el.appendChild(img);
    }
    const actions = document.createElement("div");
    actions.className = "file-tooltip-actions";
    const copyPath = document.createElement("button");
    copyPath.type = "button";
    copyPath.textContent = "Copy Path";
    copyPath.addEventListener("click", e => {
      e.stopPropagation();
      this.copyFilePath(info);
    });
    actions.appendChild(copyPath);
    const open = document.createElement("button");
    open.type = "button";
    const canDownload = !!info.download_url;
    open.textContent = info.is_previewable || !canDownload ? "Open" : "Download";
    open.addEventListener("click", e => {
      e.stopPropagation();
      tab.openResolvedFile(info, !info.is_previewable && canDownload);
    });
    actions.appendChild(open);
    if (info.is_image && canDownload) {
      const download = document.createElement("button");
      download.type = "button";
      download.textContent = "Download";
      download.addEventListener("click", e => {
        e.stopPropagation();
        tab.openResolvedFile(info, true);
      });
      actions.appendChild(download);
    }
    el.appendChild(actions);
    document.body.appendChild(el);
    const rect = el.getBoundingClientRect();
    const x = Math.min(window.innerWidth - rect.width - 8, Math.max(8, event.clientX + 12));
    const y = Math.min(window.innerHeight - rect.height - 8, Math.max(8, event.clientY + 12));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    this.fileTooltip = el;
  }

  hideFileTooltip() {
    this.cancelFileTooltipDismiss();
    this.fileTooltip?.remove();
    this.fileTooltip = null;
  }

  scheduleFileTooltipDismiss() {
    this.cancelFileTooltipDismiss();
    this.fileTooltipDismissTimer = setTimeout(() => this.hideFileTooltip(), 300);
  }

  cancelFileTooltipDismiss() {
    if (this.fileTooltipDismissTimer) {
      clearTimeout(this.fileTooltipDismissTimer);
      this.fileTooltipDismissTimer = null;
    }
  }

  formatBytes(size) {
    if (!size) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let value = size;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value.toFixed(unit ? 1 : 0)} ${units[unit]}`;
  }

  openFileViewer(info, tab) {
    this.hideFileTooltip();
    const modal = document.getElementById("file-viewer-modal");
    const title = document.getElementById("file-viewer-title");
    const body = document.getElementById("file-viewer-body");
    const downloadBtn = document.getElementById("file-viewer-download");
    title.textContent = `${info.name || info.raw} — ${info.mime || "file"} · ${this.formatBytes(info.size || 0)}`;
    body.innerHTML = "";
    if (info.is_image) {
      const img = document.createElement("img");
      if (info.preview_url) {
        img.src = info.preview_url;
      } else {
        const url = fileUrlFor(info);
        if (url) {
          fetch(url).then(r => r.blob()).then(blob => {
            img.src = URL.createObjectURL(blob);
          }).catch(() => { img.alt = "Failed to load image"; });
        }
      }
      img.alt = info.name || "image";
      body.appendChild(img);
    } else {
      const pre = document.createElement("pre");
      pre.className = "file-viewer-text";
      pre.textContent = "Loading...";
      body.appendChild(pre);
      this._loadFileText(info, pre);
    }
    this._fileViewerInfo = info;
    this._fileViewerTab = tab;
    const canDownload = !!info.download_url;
    downloadBtn.style.display = canDownload ? "" : "none";
    modal.classList.add("active");
  }

  async _loadFileText(info, pre) {
    try {
      const url = fileUrlFor(info);
      if (!url) { pre.textContent = "No URL available"; return; }
      const resp = await fetch(url);
      const text = await resp.text();
      pre.textContent = text;
    } catch (err) {
      pre.textContent = `Failed to load: ${err}`;
    }
  }

  closeFileViewer() {
    const modal = document.getElementById("file-viewer-modal");
    modal.classList.remove("active");
    const body = document.getElementById("file-viewer-body");
    body.innerHTML = "";
    this._fileViewerInfo = null;
    this._fileViewerTab = null;
  }

  async closeTab(id) {
    const tab = this.getTabById(id);
    if (!tab) return;
    const wasActive = this.activeTab === tab;
    const tabIndex = this.tabs.indexOf(tab);
    const remaining = this.tabs.filter(item => item !== tab);
    this.tabs = remaining;
    this.updateTabBar();
    this.saveTabState();
    if (wasActive) {
      this.activeTab = null;
    }
    if (!remaining.length) {
      await tab.close();
      this.updateDisconnectOverlay();
      if (window.pywebview) {
        await this.baseTransport.closeApp();
        return;
      }
      localStorage.removeItem("envoy-tab-state");
      window.close();
      if (this.onLastTabClosed) this.onLastTabClosed();
      return;
    }
    if (wasActive) {
      const fallbackIndex = Math.min(tabIndex, remaining.length - 1);
      this.activateTab(remaining[fallbackIndex].id);
    } else {
      this.renderAgentLog();
      this.updateDisconnectOverlay();
    }
    await tab.close();
    this.syncHash();
  }

  async closeAll() {
    const tabs = [...this.tabs];
    this.tabs = [];
    this.activeTab = null;
    await Promise.all(tabs.map(tab => tab.close()));
  }

  current() {
    return this.activeTab;
  }

  resumeActiveReads() {
    for (const tab of this.tabs) {
      tab.resumeReading();
    }
  }

  pauseActiveReads() {
    for (const tab of this.tabs) {
      if (typeof tab.transport.pauseStream === "function") {
        tab.transport.pauseStream();
      }
    }
  }

  reconnectDisconnectedTabs() {
    for (const tab of this.tabs) {
      if (tab.canAutoReconnect()) {
        tab.reconnect().catch(err => console.error(err));
      }
    }
  }

  selectAllVisibleTerminal() {
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(this.elements.selectOverlay);
    selection.addRange(range);
  }
}

document.fonts.load("13pt 'Source Code Pro'").then(async () => {
  const transport = await loadTransport();
  const config = await transport.init();
  init(transport, config);
});

function init(baseTransport, config) {
  document.title = config.title || "envoy";

  const isMobileClient = !window.matchMedia("(pointer: fine)").matches;
  const workspace = document.getElementById("workspace");
  const tabBar = document.getElementById("tabs");
  const tabAdd = document.getElementById("tab-add");
  const terminalStack = document.getElementById("terminal-stack");
  const disconnectOverlay = document.getElementById("disconnect-overlay");
  const disconnectMessage = document.getElementById("disconnect-message");
  const disconnectReconnect = document.getElementById("disconnect-reconnect");
  const disconnectClose = document.getElementById("disconnect-close");
  const helpModal = document.getElementById("help-modal");
  const toast = document.getElementById("toast");
  const selectOverlay = document.getElementById("select-overlay");
  const overlay = document.getElementById("drop-overlay");
  const agentLogModal = document.getElementById("voice-log-modal");
  const agentLogEntries = document.getElementById("voice-log-entries");
  const mobileInputBar = document.getElementById("mobile-input-bar");
  const textInputModal = document.getElementById("text-input-modal");
  const pasteEditorModal = document.getElementById("paste-editor-modal");
  const settingsModal = document.getElementById("settings-modal");

  let toastTimer = null;
  let toastLocked = false;
  let terminalInputActive = false;
  let keyboardVisible = false;
  let mobileSuppressNextData = null;
  let mobileSuppressUntil = 0;

  let resizeObserver = null;
  let mobileRepeatTimer = null;
  let mobileRepeatDelayTimer = null;
  let suppressNextTerminalFocus = false;
  let suppressTerminalFocusUntil = 0;
  let lastMobileTouchTime = 0;
  let baselineViewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const mobileModifiers = { Control: false, Alt: false };
  const mobileLockedModifiers = { Control: false, Alt: false };
  let mobileModifierLongPressTimer = null;
  let mobileModifierLongPressKey = "";
  let mobileModifierLongPressTriggered = false;
  let mobileNavLongPressTimer = null;
  let mobileNavLongPressAction = "";
  let mobileNavLongPressTriggered = false;
  const MOBILE_MODIFIER_LONG_PRESS_MS = 450;
  const MOBILE_NAV_LONG_PRESS_MS = 450;
  const mobileInputSequences = {
    escape: "\x1b",
    tab: "\t",
    left: "\x1b[D",
    up: "\x1b[A",
    down: "\x1b[B",
    right: "\x1b[C",
    home: "\x1b[H",
    end: "\x1b[F",
    pageup: "\x1b[5~",
    pagedown: "\x1b[6~",
  };
  const MOBILE_ALT_LEFT_TOKEN = "__ENVOY_ALT_LEFT__";
  const MOBILE_ALT_RIGHT_TOKEN = "__ENVOY_ALT_RIGHT__";
  const MOBILE_ALT_BACKSPACE_TOKEN = "__ENVOY_ALT_BACKSPACE__";

  function dismissToast() {
    toastLocked = false;
    toast.classList.remove("active", "persistent");
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
  }

  function showToast(msg, persistent, sticky) {
    toast.textContent = msg;
    toast.classList.remove("active", "persistent");
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    toastLocked = false;
    if (persistent) {
      toast.classList.add("persistent");
    } else if (sticky) {
      toast.classList.add("active", "persistent");
    } else {
      toast.classList.add("active");
      toastTimer = setTimeout(() => toast.classList.remove("active"), 1500);
    }
  }

  const sessionsModal = document.getElementById("sessions-modal");

  function hasActiveModal() {
    return helpModal.classList.contains("active")
      || agentLogModal.classList.contains("active")
      || textInputModal.classList.contains("active")
      || pasteEditorModal.classList.contains("active")
      || settingsModal.classList.contains("active")
      || sessionsModal.classList.contains("active")
      || document.getElementById("file-viewer-modal")?.classList.contains("active");
  }

  document.addEventListener("keydown", () => dismissToast(), { capture: true });
  document.addEventListener("click", () => dismissToast(), { capture: true });

  const manager = new TabManager(baseTransport, {
    stack: terminalStack,
    tabs: tabBar,
    disconnect: disconnectOverlay,
    disconnectMessage,
    disconnectReconnect,
    disconnectClose,
    agentLog: agentLogEntries,
    selectOverlay,
  });
  manager.showToast = showToast;
  manager.dismissToast = dismissToast;
  window.__envoyTransformWriteData = data => transformMobileTerminalInput(data);

  function currentTab() {
    return manager.current();
  }

  function currentTerm() {
    return currentTab()?.term || null;
  }

  function currentSerialize() {
    return currentTab()?.serialize || null;
  }

  function currentXtermEl() {
    return currentTab()?.host.querySelector(".xterm") || null;
  }

  function syncSelectOverlaySize() {
    if (!selectOverlay.classList.contains("active")) return;
    const tab = currentTab();
    if (!tab) return;
    const dims = tab.term?._core?._renderService?.dimensions?.css?.cell;
    if (dims) {
      selectOverlay.style.setProperty("--cell-height", dims.height + "px");
      selectOverlay.style.setProperty("--cell-font-size", tab.term.options.fontSize + "px");
    }
    selectOverlay.style.height = `${terminalStack.clientHeight}px`;
  }

  function focusCurrent() {
    if (isMobileClient && hasFindQuery()) return;
    currentTab()?.focus();
  }

  let pendingResize = null;
  function sendResize() {
    if (pendingResize) cancelAnimationFrame(pendingResize);
    pendingResize = requestAnimationFrame(() => {
      pendingResize = null;
      if (manager.activeTab) manager.activeTab.fitTerminal();
      syncSelectOverlaySize();
    });
  }

  function applyMobileInputBarInset() {
    if (!mobileInputBar || !isMobileClient) return;
    const vv = window.visualViewport;
    if (!vv) { mobileInputBar.style.bottom = '0px'; return; }
    const bottom = Math.max(0, window.innerHeight - (vv.offsetTop + vv.height));
    mobileInputBar.style.bottom = `${Math.round(bottom)}px`;
  }

  function updateMobileInputBar() {
    if (!mobileInputBar || !isMobileClient) return;
    const visible = keyboardVisible && terminalInputActive && !selectOverlay.classList.contains("active") && !hasActiveModal() && !hasFindQuery();
    mobileInputBar.classList.toggle("active", visible);
    workspace.classList.toggle("with-mobile-input-bar", visible);
    sidePanel.classList.toggle("with-mobile-input-bar", visible);
    applyMobileInputBarInset();
  }

  function setTerminalInputActive(active) {
    if (active && isMobileClient && hasFindQuery()) active = false;
    if (terminalInputActive === active) return;
    terminalInputActive = active;
    updateMobileInputBar();
  }

  function syncMobileModifierButtons() {
    for (const button of mobileInputBar?.querySelectorAll(".mobile-modifier-key") || []) {
      const key = button.dataset.key;
      button.classList.toggle("active", !!mobileModifiers[key]);
      button.classList.toggle("locked", !!mobileLockedModifiers[key]);
    }
  }

  function resetMobileModifiers() {
    mobileModifiers.Control = !!mobileLockedModifiers.Control;
    mobileModifiers.Alt = !!mobileLockedModifiers.Alt;
    syncMobileModifierButtons();
  }

  function clearMobileModifierLongPress() {
    if (mobileModifierLongPressTimer) {
      clearTimeout(mobileModifierLongPressTimer);
      mobileModifierLongPressTimer = null;
    }
    mobileModifierLongPressKey = "";
  }

  function clearMobileNavLongPress() {
    if (mobileNavLongPressTimer) {
      clearTimeout(mobileNavLongPressTimer);
      mobileNavLongPressTimer = null;
    }
    mobileNavLongPressAction = "";
  }

  function toggleMobileModifier(key) {
    if (mobileLockedModifiers[key]) {
      setMobileModifier(key, false, false);
    } else {
      setMobileModifier(key, !mobileModifiers[key], false);
    }
  }

  function setMobileModifier(key, active, locked = false) {
    mobileLockedModifiers[key] = !!locked;
    mobileModifiers[key] = !!active || !!mobileLockedModifiers[key];
    syncMobileModifierButtons();
  }

  function pulseMobileInputButton(button) {
    if (!button) return;
    button.classList.remove("pressed");
    void button.offsetWidth;
    button.classList.add("pressed");
    setTimeout(() => button.classList.remove("pressed"), 120);
  }

  function encodeMobileInputSequence(sequence) {
    let result = "";
    for (const char of sequence) {
      let next = char;
      if (mobileModifiers.Control && next === "\t") {
        next = "\x00";
      } else if (mobileModifiers.Control && next.length === 1) {
        const upper = next.toUpperCase();
        const code = upper.charCodeAt(0);
        if (code >= 64 && code <= 95) next = String.fromCharCode(code - 64);
        else if (upper === " ") next = "\x00";
      }
      if (mobileModifiers.Alt) next = "\x1b" + next;
      result += next;
    }
    resetMobileModifiers();
    return result;
  }

  function getMobileActionSequence(action) {
    if (mobileModifiers.Alt && !mobileModifiers.Control) {
      if (action === "left") return MOBILE_ALT_LEFT_TOKEN;
      if (action === "right") return MOBILE_ALT_RIGHT_TOKEN;
    }
    return mobileInputSequences[action] || "";
  }

  function getMobileModifiedKeySequence(key) {
    if (mobileModifiers.Alt && !mobileModifiers.Control) {
      if (key === "Backspace") return MOBILE_ALT_BACKSPACE_TOKEN;
      if (key === "ArrowLeft") return MOBILE_ALT_LEFT_TOKEN;
      if (key === "ArrowRight") return MOBILE_ALT_RIGHT_TOKEN;
    }
    let sequence = "";
    if (key === "Backspace") {
      sequence = encodeMobileInputSequence("\x7f");
    } else if (key === "Enter") {
      sequence = encodeMobileInputSequence("\r");
    }
    return sequence;
  }

  function writeSequenceToCurrentTab(sequence) {
    const tab = currentTab();
    if (!tab || tab.disconnected) return Promise.resolve();
    return tab.transport.write(sequence).catch(err => tab.handleWriteError(err));
  }

  function writeBytesToCurrentTab(bytes) {
    const tab = currentTab();
    if (!tab || tab.disconnected) return Promise.resolve();
    return tab.transport.writeBytes(bytes).catch(err => tab.handleWriteError(err));
  }

  function suppressNextMobileTerminalData(values) {
    mobileSuppressNextData = new Set(Array.isArray(values) ? values : [values]);
    mobileSuppressUntil = performance.now() + 1000;
  }

  function transformMobileTerminalInput(data) {
    if (!isMobileClient) return data;
    if (mobileSuppressNextData && performance.now() <= mobileSuppressUntil && mobileSuppressNextData.has(data)) {
      mobileSuppressNextData = null;
      mobileSuppressUntil = 0;
      return null;
    }

    if (data === MOBILE_ALT_BACKSPACE_TOKEN) {
      resetMobileModifiers();
      return new Uint8Array([0x1b, 0x7f]);
    }
    if (data === MOBILE_ALT_LEFT_TOKEN) {
      resetMobileModifiers();
      return new Uint8Array([0x1b, 0x62]);
    }
    if (data === MOBILE_ALT_RIGHT_TOKEN) {
      resetMobileModifiers();
      return new Uint8Array([0x1b, 0x66]);
    }

    if (mobileModifiers.Control && typeof data === "string" && data.length > 0 && data[0] !== "\x1b") {
      return encodeMobileInputSequence(data);
    }
    if (!mobileModifiers.Alt || mobileModifiers.Control) return data;
    if (data === "\x7f" || data === "\x08") {
      resetMobileModifiers();
      return new Uint8Array([0x1b, 0x7f]);
    }
    if (data === "\x1b[D" || data === "\x1bOD") {
      resetMobileModifiers();
      return new Uint8Array([0x1b, 0x62]);
    }
    if (data === "\x1b[C" || data === "\x1bOC") {
      resetMobileModifiers();
      return new Uint8Array([0x1b, 0x66]);
    }
    return data;
  }

  function sendMobileInput(sequence) {
    writeSequenceToCurrentTab(encodeMobileInputSequence(sequence));
    focusCurrent();
  }

  resetMobileModifiers();

  function stopMobileInputRepeat() {
    if (mobileRepeatDelayTimer) {
      clearTimeout(mobileRepeatDelayTimer);
      mobileRepeatDelayTimer = null;
    }
    if (mobileRepeatTimer) {
      clearInterval(mobileRepeatTimer);
      mobileRepeatTimer = null;
    }
  }

  function startMobileInputRepeat(sequence) {
    stopMobileInputRepeat();
    mobileRepeatDelayTimer = setTimeout(() => {
      mobileRepeatTimer = setInterval(() => {
        if (sequence instanceof Uint8Array) writeBytesToCurrentTab(sequence);
        else writeSequenceToCurrentTab(sequence);
      }, 60);
    }, 350);
  }

  function adjustFontSize(delta) {
    const term = currentTerm();
    if (!term) return;
    const next = Math.max(8, Math.min(40, term.options.fontSize + delta));
    if (next === term.options.fontSize) return;
    term.options.fontSize = next;
    localStorage.setItem("envoy-font-size", next);
    sendResize();
    showToast(`Font size ${next}`);
  }

  function resetFontSize() {
    const term = currentTerm();
    if (!term) return;
    if (term.options.fontSize === 17) return;
    term.options.fontSize = 17;
    localStorage.setItem("envoy-font-size", "17");
    sendResize();
    showToast("Font size 17");
  }

  function updateViewportState() {
    const vv = window.visualViewport;
    const viewportHeight = vv ? vv.height : window.innerHeight;

    if (!terminalInputActive && !hasActiveModal()) {
      baselineViewportHeight = Math.max(baselineViewportHeight, viewportHeight);
    }

    const keyboardDelta = Math.max(0, baselineViewportHeight - viewportHeight);
    keyboardVisible = isMobileClient && terminalInputActive && (window.visualViewport ? keyboardDelta > 100 : true);
  }

  function performLayoutRefresh() {
    updateViewportState();
    updateMobileInputBar();
    sendResize();
  }

  updateViewportState();

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      performLayoutRefresh();
    });
    window.visualViewport.addEventListener("scroll", () => {
      performLayoutRefresh();
      window.scrollTo(0, 0);
    });
  }

  window.onresize = () => {
    baselineViewportHeight = Math.max(baselineViewportHeight, window.visualViewport ? window.visualViewport.height : window.innerHeight);
    performLayoutRefresh();
  };

  const sidePanel = document.getElementById("side-panel");
  const spMic = document.getElementById("sp-mic");
  const spDict = document.getElementById("sp-dict");
  const spCancel = document.getElementById("sp-cancel");
  const spHelp = document.getElementById("sp-help");
  const spFindPrev = document.getElementById("sp-find-prev");
  const spFind = document.getElementById("sp-find");
  const spFindNext = document.getElementById("sp-find-next");
  const spSessions = document.getElementById("sp-sessions");
  const spSettings = document.getElementById("sp-settings");
  const spLog = document.getElementById("sp-log");
  const spText = document.getElementById("sp-text");
  const spPaste = document.getElementById("sp-paste");
  const spSel = document.getElementById("sp-sel");
  const spFs = document.getElementById("sp-fs");
  const spUpload = document.getElementById("sp-upload");

  if (window.pywebview) spUpload.style.display = "none";

  let pendingSidebarTouchButton = null;
  let sidebarTouchStart = null;
  let findQuery = "";
  let selectModeFindMatches = [];
  let selectModeFindIndex = -1;
  let terminalFindMatches = [];
  let terminalFindIndex = -1;

  const MODAL_OPENING_SIDEBAR_BUTTON_IDS = new Set([
    "sp-help",
    "sp-sessions",
    "sp-log",
    "sp-text",
    "sp-paste",
    "sp-settings",
    "sp-mic",
  ]);
  const NO_REFOCUS_SIDEBAR_BUTTON_IDS = new Set([
    "sp-find",
    "sp-find-prev",
    "sp-find-next",
  ]);

  function setSidebarButtonsFocusable(focusable) {
    for (const button of sidePanel.querySelectorAll(".sp-btn")) {
      button.tabIndex = focusable ? 0 : -1;
    }
  }

  function shouldRestoreTerminalFocusAfterSidebarClick(button) {
    if (!button || button.disabled) return false;
    if (NO_REFOCUS_SIDEBAR_BUTTON_IDS.has(button.id)) return false;
    return !MODAL_OPENING_SIDEBAR_BUTTON_IDS.has(button.id);
  }

  function maybeRestoreTerminalFocusAfterSidebarClick(button) {
    if (!shouldRestoreTerminalFocusAfterSidebarClick(button)) return;
    requestAnimationFrame(() => {
      button.blur();
      if (!hasActiveModal() && !(isMobileClient && hasFindQuery())) focusCurrent();
    });
  }

  function hasFindQuery() {
    return !!findQuery;
  }

  function updateFindButtonState() {
    const enabled = hasFindQuery();
    const searchIcon = spFind?.querySelector(".find-icon-search");
    const clearIcon = spFind?.querySelector(".find-icon-clear");
    if (spFind) {
      spFind.title = enabled ? "Clear find" : "Find";
      spFind.setAttribute("aria-label", enabled ? "Clear find" : "Find");
      spFind.classList.toggle("sp-active", enabled);
    }
    if (searchIcon) searchIcon.hidden = enabled;
    if (clearIcon) clearIcon.hidden = !enabled;
    for (const button of [spFindPrev, spFindNext]) {
      if (!button) continue;
      button.disabled = !enabled;
      button.classList.toggle("find-nav-disabled", !enabled);
    }
  }

  function preserveTerminalFocusFromSidebarPress(e) {
    if (!isMobileClient) return;
    const button = e.target.closest("#side-panel .sp-btn");
    if (!button) return;
    if (!keyboardVisible) {
      pendingSidebarTouchButton = null;
      sidebarTouchStart = null;
      return;
    }
    e.preventDefault();
    pendingSidebarTouchButton = button;
    const touch = e.touches[0];
    sidebarTouchStart = touch ? { x: touch.clientX, y: touch.clientY, lastY: touch.clientY } : null;
  }

  function cancelSidebarTouchIfMoved(e) {
    if (!sidebarTouchStart) return;
    const touch = e.touches[0];
    if (!touch) return;
    const dx = touch.clientX - sidebarTouchStart.x;
    const dy = touch.clientY - sidebarTouchStart.y;
    if (pendingSidebarTouchButton && dx * dx + dy * dy > 100) {
      pendingSidebarTouchButton = null;
    }
    // Manual sidebar scroll (preventDefault on touchstart blocks native scroll)
    sidePanel.scrollTop += sidebarTouchStart.lastY - touch.clientY;
    sidebarTouchStart.lastY = touch.clientY;
  }

  function triggerSidebarButtonWithoutBlur(e) {
    if (!isMobileClient) return;
    const button = e.target.closest("#side-panel .sp-btn");
    if (!button || button !== pendingSidebarTouchButton) {
      pendingSidebarTouchButton = null;
      sidebarTouchStart = null;
      return;
    }
    e.preventDefault();
    pendingSidebarTouchButton = null;
    sidebarTouchStart = null;
    button.click();
  }

  function clearSidebarTouchButton() {
    pendingSidebarTouchButton = null;
    sidebarTouchStart = null;
  }

  function syncPanelWidth() {
    workspace.classList.toggle("with-panel", sidePanel.classList.contains("active"));
    sendResize();
    setTimeout(sendResize, 220);
  }

  function toggleSidePanel() {
    sidePanel.classList.toggle("active");
    syncPanelWidth();
  }

  function installResizeObserver() {
    if (resizeObserver || typeof ResizeObserver !== "function") return;
    resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => {
        sendResize();
        requestAnimationFrame(() => sendResize());
      });
    });
    resizeObserver.observe(workspace);
    resizeObserver.observe(terminalStack);
    resizeObserver.observe(tabBar);
    if (mobileInputBar) resizeObserver.observe(mobileInputBar);
  }

  sidePanel.addEventListener("transitionend", syncPanelWidth);
  setSidebarButtonsFocusable(false);
  updateFindButtonState();
  sidePanel.addEventListener("mousedown", e => {
    const button = e.target.closest(".sp-btn");
    if (!button) return;
    e.preventDefault();
  }, { capture: true });
  sidePanel.addEventListener("click", e => {
    const button = e.target.closest(".sp-btn");
    if (!button) return;
    maybeRestoreTerminalFocusAfterSidebarClick(button);
  }, { capture: false });
  sidePanel.addEventListener("contextmenu", e => {
    if (e.target.closest(".sp-btn")) e.preventDefault();
  });
  sidePanel.addEventListener("touchstart", preserveTerminalFocusFromSidebarPress, { passive: false, capture: true });
  sidePanel.addEventListener("touchmove", cancelSidebarTouchIfMoved, { passive: true, capture: true });
  sidePanel.addEventListener("touchend", triggerSidebarButtonWithoutBlur, { passive: false, capture: true });
  sidePanel.addEventListener("touchcancel", clearSidebarTouchButton, { capture: true });
  if (window.matchMedia("(pointer: fine)").matches) toggleSidePanel();
  installResizeObserver();

  let swipeStart = null;
  let twoFingerStart = null;
  let lastTwoFingerTapAt = 0;
  let scrollLastY = null;
  let scrollLastTime = 0;
  let scrollAccum = 0;
  let scrollVelocity = 0;
  let scrollMomentumFrame = null;
  let gestureAxis = null;
  let scrollbarDrag = null;
  const SWIPE_MIN = 60;

  function getCellHeight() {
    try { return currentTerm()._core._renderService.dimensions.css.cell.height; }
    catch { return 20; }
  }

  function stopScrollMomentum() {
    if (scrollMomentumFrame) {
      cancelAnimationFrame(scrollMomentumFrame);
      scrollMomentumFrame = null;
    }
    scrollVelocity = 0;
  }

  function isScrollbarTarget(target) {
    return !!target?.closest?.(".xterm-scrollable-element > .scrollbar, .xterm-scrollable-element .scrollbar, .xterm-scrollable-element > .scrollbar > .slider, .xterm-scrollable-element .scrollbar .slider");
  }

  function stopScrollbarDrag() {
    scrollbarDrag = null;
  }

  function beginScrollbarDrag(target, clientY, pointerId = null) {
    const term = currentTerm();
    const scrollbar = target?.closest?.(".xterm-scrollable-element > .scrollbar, .xterm-scrollable-element .scrollbar");
    if (!term || !scrollbar) return false;
    const slider = scrollbar.querySelector(".slider");
    const buffer = term.buffer?.active;
    const maxTopLine = Math.max(0, (buffer?.length || 0) - term.rows);
    if (!maxTopLine) return false;
    const trackRect = scrollbar.getBoundingClientRect();
    const sliderRect = (slider || scrollbar).getBoundingClientRect();
    scrollbarDrag = {
      pointerId,
      maxTopLine,
      trackTop: trackRect.top,
      sliderHeight: Math.max(1, sliderRect.height),
      availableHeight: Math.max(1, trackRect.height - sliderRect.height),
    };
    updateScrollbarDrag(clientY);
    return true;
  }

  function updateScrollbarDrag(clientY) {
    if (!scrollbarDrag) return;
    const term = currentTerm();
    if (!term) {
      stopScrollbarDrag();
      return;
    }
    const offset = clientY - scrollbarDrag.trackTop - scrollbarDrag.sliderHeight / 2;
    const ratio = scrollbarDrag.availableHeight > 0 ? offset / scrollbarDrag.availableHeight : 0;
    const nextTopLine = Math.max(0, Math.min(scrollbarDrag.maxTopLine, Math.round(ratio * scrollbarDrag.maxTopLine)));
    term.scrollToLine(nextTopLine);
  }

  function startScrollMomentum() {
    const term = currentTerm();
    const xtermEl = currentXtermEl();
    if (!term || !xtermEl || xtermEl.classList.contains("select-mode")) return;
    if (Math.abs(scrollVelocity) < 0.02) {
      scrollVelocity = 0;
      return;
    }
    if (scrollMomentumFrame) cancelAnimationFrame(scrollMomentumFrame);
    let lastFrameTime = performance.now();
    const tick = now => {
      const activeTerm = currentTerm();
      const activeXtermEl = currentXtermEl();
      if (!activeTerm || !activeXtermEl || activeXtermEl.classList.contains("select-mode")) {
        stopScrollMomentum();
        return;
      }
      const dt = Math.min(40, now - lastFrameTime || 16);
      lastFrameTime = now;
      scrollAccum += scrollVelocity * dt;
      const cellHeight = getCellHeight();
      const lines = Math.trunc(scrollAccum / cellHeight);
      if (lines !== 0) {
        activeTerm.scrollLines(lines);
        scrollAccum -= lines * cellHeight;
      }
      scrollVelocity *= Math.pow(0.95, dt / 16.6667);
      if (Math.abs(scrollVelocity) < 0.02) {
        stopScrollMomentum();
        return;
      }
      scrollMomentumFrame = requestAnimationFrame(tick);
    };
    scrollMomentumFrame = requestAnimationFrame(tick);
  }

  document.addEventListener("touchstart", e => {
    stopScrollMomentum();
    gestureAxis = null;
    if (e.touches.length === 1 && isScrollbarTarget(e.target)) {
      const touch = e.touches[0];
      beginScrollbarDrag(e.target, touch.clientY);
      swipeStart = null;
      twoFingerStart = null;
      scrollLastY = null;
      scrollLastTime = 0;
      return;
    }
    if (e.touches.length === 2) {
      scrollLastY = null;
      scrollLastTime = 0;
      swipeStart = null;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      twoFingerStart = { time: Date.now(), dist: Math.hypot(dx, dy), pinched: false };
    } else if (e.touches.length === 1) {
      const touch = e.touches[0];
      swipeStart = { x: touch.clientX, y: touch.clientY };
      scrollLastY = e.target.closest("#side-panel, #mobile-input-bar") || isScrollbarTarget(e.target) ? null : touch.clientY;
      scrollLastTime = scrollLastY === null ? 0 : performance.now();
      scrollAccum = 0;
      scrollVelocity = 0;
    }
  }, { passive: true, capture: true });

  document.addEventListener("touchmove", e => {
    const term = currentTerm();
    const xtermEl = currentXtermEl();
    if (!term || !xtermEl) return;
    if (scrollbarDrag && e.touches.length === 1) {
      updateScrollbarDrag(e.touches[0].clientY);
      return;
    }
    if (e.touches.length === 2 && twoFingerStart && twoFingerStart.dist) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const delta = dist - twoFingerStart.dist;
      if (Math.abs(delta) > 30) {
        const newSize = Math.max(8, Math.min(40, term.options.fontSize + (delta > 0 ? 1 : -1)));
        if (newSize !== term.options.fontSize) {
          term.options.fontSize = newSize;
          localStorage.setItem("envoy-font-size", newSize);
          sendResize();
        }
        twoFingerStart.dist = dist;
        twoFingerStart.pinched = true;
      }
    }
    if (e.touches.length === 1 && scrollLastY !== null && !xtermEl.classList.contains("select-mode")) {
      if (swipeStart) {
        const touch = e.touches[0];
        const dx = swipeStart.x - touch.clientX;
        const dy = swipeStart.y - touch.clientY;
        if (!gestureAxis && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
          gestureAxis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        }
        if (gestureAxis === "x" && Math.abs(dx) > Math.abs(dy)) {
          scrollLastY = null;
          scrollLastTime = 0;
          scrollAccum = 0;
          scrollVelocity = 0;
          return;
        }
      }
      const y = e.touches[0].clientY;
      const now = performance.now();
      const delta = scrollLastY - y;
      scrollAccum += delta;
      const cellHeight = getCellHeight();
      const lines = Math.trunc(scrollAccum / cellHeight);
      if (lines !== 0) {
        term.scrollLines(lines);
        scrollAccum -= lines * cellHeight;
      }
      const dt = Math.max(1, now - (scrollLastTime || now));
      const instantVelocity = delta / dt;
      scrollVelocity = scrollVelocity * 0.75 + instantVelocity * 0.25;
      scrollLastY = y;
      scrollLastTime = now;
    }
  }, { passive: true, capture: true });

  document.addEventListener("touchend", e => {
    stopScrollbarDrag();
    scrollLastY = null;
    scrollLastTime = 0;
    if (e.touches.length === 0) {
      startScrollMomentum();
    }
    if (swipeStart && e.touches.length === 0 && e.changedTouches.length === 1) {
      const touch = e.changedTouches[0];
      const dx = swipeStart.x - touch.clientX;
      const dy = swipeStart.y - touch.clientY;
      if (Math.abs(dy) < Math.abs(dx)) {
        const isOpen = sidePanel.classList.contains("active");
        if (!isOpen && dx > SWIPE_MIN) toggleSidePanel();
        if (isOpen && -dx > SWIPE_MIN) toggleSidePanel();
      }
      swipeStart = null;
    }
    if (twoFingerStart && e.touches.length === 0) {
      if (Date.now() - twoFingerStart.time < 500 && !twoFingerStart.pinched) {
        const now = Date.now();
        if (lastTwoFingerTapAt && now - lastTwoFingerTapAt < 500) {
          lastTwoFingerTapAt = 0;
          toggleDictation();
        } else {
          lastTwoFingerTapAt = now;
        }
      }
      twoFingerStart = null;
    }
  }, { passive: true, capture: true });

  document.addEventListener("touchcancel", () => {
    stopScrollbarDrag();
    gestureAxis = null;
    scrollLastY = null;
    scrollLastTime = 0;
  }, { passive: true, capture: true });

  document.addEventListener("pointerdown", e => {
    if (beginScrollbarDrag(e.target, e.clientY, e.pointerId)) {
      e.preventDefault();
    }
  }, { capture: true });

  document.addEventListener("pointermove", e => {
    if (!scrollbarDrag) return;
    if (scrollbarDrag.pointerId !== null && e.pointerId !== scrollbarDrag.pointerId) return;
    e.preventDefault();
    updateScrollbarDrag(e.clientY);
  }, { capture: true });

  document.addEventListener("pointerup", e => {
    if (!scrollbarDrag) return;
    if (scrollbarDrag.pointerId !== null && e.pointerId !== scrollbarDrag.pointerId) return;
    stopScrollbarDrag();
  }, { capture: true });

  document.addEventListener("pointercancel", e => {
    if (!scrollbarDrag) return;
    if (scrollbarDrag.pointerId !== null && e.pointerId !== scrollbarDrag.pointerId) return;
    stopScrollbarDrag();
  }, { capture: true });

  helpModal.addEventListener("click", () => {
    helpModal.classList.remove("active");
  });

  function hexToRgb(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgb(${r}, ${g}, ${b})`;
  }

  function buildBoldBrightMap(term) {
    const ansi = term._core._themeService?.colors?.ansi;
    if (!ansi) return null;
    const map = {};
    for (let i = 0; i < 8; i++) {
      const dark = ansi[i].css;
      const bright = ansi[i + 8].css;
      map[dark.toLowerCase()] = bright;
      map[hexToRgb(dark).toLowerCase()] = bright;
    }
    return map;
  }

  function enterSelectMode() {
    const tab = currentTab();
    if (!tab) return;
    const html = currentSerialize().serializeAsHTML({ includeGlobalBackground: true });
    const match = html.match(/<pre>([\s\S]*)<\/pre>/);
    if (match) selectOverlay.innerHTML = match[1];
    const buf = tab.term.buffer.active;
    const wrapper = selectOverlay.querySelector("div");
    const rows = wrapper ? wrapper.children : [];
    for (let i = 0; i < rows.length && i < buf.length; i++) {
      const line = buf.getLine(i);
      if (!line) continue;
      const trimmedLen = line.translateToString(true).length;
      const spans = rows[i].children;
      let total = 0;
      for (const span of spans) {
        const len = span.textContent.length;
        if (total + len > trimmedLen) {
          span.textContent = span.textContent.substring(0, Math.max(0, trimmedLen - total));
        }
        total += len;
      }
      if (trimmedLen === 0 && spans.length > 0) {
        spans[0].textContent = "\n";
      }
    }
    if (wrapper) {
      while (wrapper.lastElementChild && wrapper.lastElementChild.textContent === "\n") {
        wrapper.lastElementChild.remove();
      }
    }
    if (tab.term.options.drawBoldTextInBrightColors !== false) {
      const boldBrightMap = buildBoldBrightMap(tab.term);
      if (boldBrightMap) {
        for (const span of selectOverlay.querySelectorAll("span")) {
          if (span.style.fontWeight === "bold" && span.style.color) {
            const bright = boldBrightMap[span.style.color.toLowerCase()];
            if (bright) span.style.color = bright;
          }
        }
      }
    }
    const dims = tab.term._core._renderService.dimensions.css.cell;
    selectOverlay.style.setProperty("--cell-height", dims.height + "px");
    selectOverlay.style.setProperty("--cell-font-size", tab.term.options.fontSize + "px");
    selectOverlay.style.height = `${terminalStack.clientHeight}px`;
    selectOverlay.classList.add("active");
    const xtermEl = currentXtermEl();
    if (xtermEl) xtermEl.classList.add("select-mode");
    selectOverlay.scrollTop = selectOverlay.scrollHeight;
    spSel.classList.add("sp-active");
    setTerminalInputActive(false);
  }

  function clearSelectModeFindHighlights() {
    for (const match of selectModeFindMatches) {
      const parent = match.parentNode;
      if (!parent) continue;
      parent.replaceChild(document.createTextNode(match.textContent || ""), match);
      parent.normalize();
    }
    selectModeFindMatches = [];
    selectModeFindIndex = -1;
  }

  function clearTerminalFindSelection() {
    const term = currentTerm();
    try { term?.clearSelection?.(); } catch {}
    terminalFindIndex = -1;
  }

  function clearAllFindState({ keepQuery = false } = {}) {
    clearSelectModeFindHighlights();
    clearTerminalFindSelection();
    terminalFindMatches = [];
    if (!keepQuery) findQuery = "";
    if (isMobileClient && !keepQuery) {
      updateViewportState();
      updateMobileInputBar();
    }
    updateFindButtonState();
  }

  function setActiveSelectModeFindMatch(index) {
    if (!selectModeFindMatches.length) {
      selectModeFindIndex = -1;
      return false;
    }
    const nextIndex = ((index % selectModeFindMatches.length) + selectModeFindMatches.length) % selectModeFindMatches.length;
    for (let i = 0; i < selectModeFindMatches.length; i++) {
      selectModeFindMatches[i].classList.toggle("active", i === nextIndex);
    }
    selectModeFindIndex = nextIndex;
    selectModeFindMatches[nextIndex].scrollIntoView({ block: "center", inline: "nearest" });
    return true;
  }

  function buildSelectModeFindHighlights(query) {
    clearSelectModeFindHighlights();
    if (!query) return 0;
    const lowerQuery = query.toLocaleLowerCase();
    const walker = document.createTreeWalker(selectOverlay, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (node.parentElement?.closest(".select-find-match")) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const textNodes = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      textNodes.push(node);
    }
    for (const node of textNodes) {
      const text = node.nodeValue || "";
      const lowerText = text.toLocaleLowerCase();
      let searchIndex = 0;
      let matchIndex = lowerText.indexOf(lowerQuery, searchIndex);
      if (matchIndex === -1) continue;
      const fragment = document.createDocumentFragment();
      while (matchIndex !== -1) {
        if (matchIndex > searchIndex) {
          fragment.appendChild(document.createTextNode(text.slice(searchIndex, matchIndex)));
        }
        const mark = document.createElement("mark");
        mark.className = "select-find-match";
        mark.textContent = text.slice(matchIndex, matchIndex + query.length);
        fragment.appendChild(mark);
        selectModeFindMatches.push(mark);
        searchIndex = matchIndex + query.length;
        matchIndex = lowerText.indexOf(lowerQuery, searchIndex);
      }
      if (searchIndex < text.length) {
        fragment.appendChild(document.createTextNode(text.slice(searchIndex)));
      }
      node.parentNode.replaceChild(fragment, node);
    }
    return selectModeFindMatches.length;
  }

  function buildTerminalFindMatches(query) {
    terminalFindMatches = [];
    terminalFindIndex = -1;
    const term = currentTerm();
    const buffer = term?.buffer?.active;
    if (!term || !buffer || !query) return 0;
    const lowerQuery = query.toLocaleLowerCase();
    for (let row = 0; row < buffer.length; row++) {
      const line = buffer.getLine(row);
      if (!line) continue;
      const text = line.translateToString(false);
      const lowerText = text.toLocaleLowerCase();
      let start = 0;
      while (true) {
        const index = lowerText.indexOf(lowerQuery, start);
        if (index === -1) break;
        terminalFindMatches.push({ row, column: index, length: query.length });
        start = index + Math.max(1, query.length);
      }
    }
    return terminalFindMatches.length;
  }

  function activateTerminalFindMatch(index) {
    if (!terminalFindMatches.length) {
      terminalFindIndex = -1;
      return false;
    }
    const term = currentTerm();
    const buffer = term?.buffer?.active;
    if (!term || !buffer) return false;
    const nextIndex = ((index % terminalFindMatches.length) + terminalFindMatches.length) % terminalFindMatches.length;
    const match = terminalFindMatches[nextIndex];
    const targetTop = Math.max(0, match.row - Math.floor(term.rows / 2));
    term.scrollToLine(targetTop);
    term.clearSelection();
    term.select(match.column, match.row, match.length);
    terminalFindIndex = nextIndex;
    return true;
  }

  function buildFindMatches(query) {
    return selectOverlay.classList.contains("active")
      ? buildSelectModeFindHighlights(query)
      : buildTerminalFindMatches(query);
  }

  function activateFindMatch(index) {
    return selectOverlay.classList.contains("active")
      ? setActiveSelectModeFindMatch(index)
      : activateTerminalFindMatch(index);
  }

  function scheduleInitialTerminalFindActivation(index) {
    const delays = [0, 40, 120, 250];
    for (const delay of delays) {
      setTimeout(() => {
        activateTerminalFindMatch(index);
      }, delay);
    }
    return true;
  }

  function getCurrentFindIndex() {
    return selectOverlay.classList.contains("active") ? selectModeFindIndex : terminalFindIndex;
  }

  function performFindNavigation(direction) {
    if (!findQuery) return triggerFindPrompt(direction);
    const hasMatches = selectOverlay.classList.contains("active")
      ? selectModeFindMatches.length
      : terminalFindMatches.length;
    if (!hasMatches) {
      const rebuilt = buildFindMatches(findQuery);
      if (!rebuilt) {
        showToast(`No matches for "${findQuery}"`);
        return false;
      }
    }
    const currentIndex = getCurrentFindIndex();
    const startIndex = currentIndex === -1
      ? (direction > 0 ? -1 : 0)
      : currentIndex;
    return activateFindMatch(startIndex + direction);
  }

  function triggerFindPrompt(initialDirection = 1) {
    if (isMobileClient) {
      setTerminalInputActive(false);
      try { document.activeElement?.blur?.(); } catch {}
      updateMobileInputBar();
    }
    const query = window.prompt("Find", findQuery);
    if (query === null) return false;
    const normalizedQuery = query.trim();
    if (!normalizedQuery) {
      clearAllFindState();
      return false;
    }
    if (normalizedQuery !== findQuery) {
      clearAllFindState({ keepQuery: true });
      findQuery = normalizedQuery;
      const count = buildFindMatches(normalizedQuery);
      updateFindButtonState();
      if (!count) {
        showToast(`No matches for "${normalizedQuery}"`);
        return false;
      }
      showToast(`${count} match${count === 1 ? "" : "es"} for "${normalizedQuery}"`);
      const inSelectMode = selectOverlay.classList.contains("active");
      const firstIndex = initialDirection > 0 ? count - 1 : 0;
      if (inSelectMode) {
        return activateFindMatch(firstIndex);
      }
      if (!isMobileClient) {
        try { window.getSelection?.()?.removeAllRanges?.(); } catch {}
        focusCurrent();
      }
      return scheduleInitialTerminalFindActivation(firstIndex);
    }
    return performFindNavigation(initialDirection);
  }

  function exitSelectMode() {
    clearSelectModeFindHighlights();
    selectModeFindIndex = -1;
    selectOverlay.classList.remove("active");
    selectOverlay.innerHTML = "";
    selectOverlay.style.height = "";
    const xtermEl = currentXtermEl();
    if (xtermEl) xtermEl.classList.remove("select-mode");
    spSel.classList.remove("sp-active");
    currentTerm()?.scrollToBottom();
    focusCurrent();
    updateMobileInputBar();
    if (findQuery) {
      buildTerminalFindMatches(findQuery);
      updateFindButtonState();
    }
  }

  function triggerFind() {
    if (findQuery) {
      clearAllFindState();
      return false;
    }
    return triggerFindPrompt(1);
  }

  function triggerFindPrev() {
    return performFindNavigation(-1);
  }

  function triggerFindNext() {
    return performFindNavigation(1);
  }

  function eventHasFiles(e) {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    return Array.from(types).includes("Files");
  }

  let dragCount = 0;
  document.addEventListener("dragenter", e => {
    if (!eventHasFiles(e)) return;
    e.preventDefault();
    if (++dragCount === 1) overlay.classList.add("active");
  });
  document.addEventListener("dragleave", e => {
    if (!eventHasFiles(e)) return;
    e.preventDefault();
    dragCount = Math.max(0, dragCount - 1);
    if (dragCount === 0) overlay.classList.remove("active");
  });
  document.addEventListener("dragover", e => {
    if (!eventHasFiles(e)) return;
    e.preventDefault();
  });
  document.addEventListener("drop", e => {
    if (!eventHasFiles(e)) return;
    e.preventDefault();
    dragCount = 0;
    overlay.classList.remove("active");
    const tab = currentTab();
    if (!tab) return;
    if (baseTransport.toggleFullscreen) {
      const paths = Array.from(e.dataTransfer.files, f => f.path).filter(Boolean);
      if (paths.length) {
        tab.transport.write(paths.map(p => p.includes(" ") ? `'${p}'` : p).join(" ")).catch(err => tab.handleWriteError(err));
      }
    } else {
      for (const file of e.dataTransfer.files) {
        const reader = new FileReader();
        reader.onload = () => {
          const b64 = reader.result.split(",")[1];
          tab.transport.uploadFile(file.name, b64).catch(err => showToast(String(err)));
        };
        reader.readAsDataURL(file);
      }
    }
  });

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.style.display = "none";
  document.body.appendChild(fileInput);
  let uploadLongPress = null;
  let uploadLongPressFired = false;
  function openUploadLink() {
    if (!uploadLinkUrl) { showToast("No Upload Link URL configured"); return; }
    const tab = currentTab();
    if (!tab || !tab.transport.sessionId) { showToast("No active session"); return; }
    window.open(uploadLinkUrl + encodeURIComponent(tab.transport.sessionId), "_blank", "noopener");
  }
  spUpload.addEventListener("pointerdown", () => {
    uploadLongPressFired = false;
    uploadLongPress = setTimeout(() => {
      uploadLongPress = null;
      uploadLongPressFired = true;
      openUploadLink();
    }, 500);
  });
  spUpload.addEventListener("pointerup", () => {
    if (uploadLongPress !== null) { clearTimeout(uploadLongPress); uploadLongPress = null; }
  });
  spUpload.addEventListener("pointercancel", () => {
    if (uploadLongPress !== null) { clearTimeout(uploadLongPress); uploadLongPress = null; }
  });
  spUpload.addEventListener("pointermove", e => {
    if (uploadLongPress && (Math.abs(e.movementX) > 5 || Math.abs(e.movementY) > 5)) {
      clearTimeout(uploadLongPress); uploadLongPress = null;
    }
  });
  spUpload.addEventListener("contextmenu", e => {
    e.preventDefault();
    if (uploadLongPress !== null) { clearTimeout(uploadLongPress); uploadLongPress = null; }
    uploadLongPressFired = true;
    openUploadLink();
  });
  spUpload.addEventListener("click", () => {
    if (uploadLongPressFired) return;
    fileInput.value = ""; fileInput.click();
  });
  fileInput.addEventListener("change", () => {
    const tab = currentTab();
    if (!tab || !fileInput.files.length) return;
    const wait = tab.transport.waitForStream ? tab.transport.waitForStream() : Promise.resolve();
    for (const file of fileInput.files) {
      const reader = new FileReader();
      reader.onload = () => {
        const b64 = reader.result.split(",")[1];
        wait.then(() => tab.transport.uploadFile(file.name, b64)).catch(err => showToast(String(err)));
      };
      reader.readAsDataURL(file);
    }
  });

  spLog.addEventListener("click", () => {
    manager.renderAgentLog();
    agentLogModal.classList.add("active");
  });
  disconnectReconnect.addEventListener("click", () => {
    const tab = currentTab();
    if (!tab || !tab.canReconnect()) return;
    disconnectReconnect.disabled = true;
    disconnectClose.disabled = true;
    disconnectMessage.textContent = "Reconnecting...";
    tab.reconnect().catch(err => {
      showToast(String(err));
      manager.updateDisconnectOverlay();
    });
  });
  disconnectClose.addEventListener("click", () => {
    const tab = currentTab();
    if (!tab) return;
    manager.closeTab(tab.id).catch(err => showToast(String(err)));
  });
  agentLogModal.addEventListener("click", e => {
    if (e.target === agentLogModal) agentLogModal.classList.remove("active");
  });

  let voiceRecorder = null;
  let voiceStream = null;
  let voiceCancelled = false;
  let voiceAbort = null;
  let voiceMode = null;
  let voiceCancelPending = false;
  let voiceShouldRestoreTerminalFocus = false;

  function cancelVoiceAgent() {
    currentTab()?.transport.cancelAgent().catch(() => {});
  }

  function updateVoiceControls() {
    spMic.classList.toggle("cancelling", voiceCancelPending && voiceMode === "agent");
    spCancel.disabled = voiceCancelPending || (!voiceRecorder && !voiceAbort);
  }

  function voiceReset() {
    if (voiceStream) {
      voiceStream.getTracks().forEach(track => track.stop());
      voiceStream = null;
    }
    const restoreTerminalFocus = voiceShouldRestoreTerminalFocus;
    voiceRecorder = null;
    voiceCancelled = false;
    voiceAbort = null;
    voiceMode = null;
    voiceCancelPending = false;
    voiceShouldRestoreTerminalFocus = false;
    spMic.classList.remove("recording", "processing", "cancelling");
    spDict.classList.remove("recording", "processing");
    updateVoiceControls();
    if (restoreTerminalFocus) focusCurrent();
  }

  function startVoiceRecording(mode) {
    const tab = currentTab();
    if (!tab || voiceRecorder) return;
    voiceShouldRestoreTerminalFocus = keyboardVisible && terminalInputActive;
    if (!navigator.mediaDevices || !window.MediaRecorder) {
      showToast("Voice not supported");
      return;
    }
    if (!sidePanel.classList.contains("active")) toggleSidePanel();
    voiceCancelled = false;
    voiceMode = mode;
    const button = mode === "dict" ? spDict : spMic;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      voiceStream = stream;
      const chunks = [];
      const mimeOpts = ["audio/ogg;codecs=opus", "audio/ogg", "audio/webm;codecs=opus", "audio/webm", "audio/wav"];
      const mimeOpt = mimeOpts.find(m => MediaRecorder.isTypeSupported(m));
      const recorder = mimeOpt ? new MediaRecorder(stream, { mimeType: mimeOpt }) : new MediaRecorder(stream);
      voiceRecorder = recorder;
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
        if (voiceCancelled) {
          voiceReset();
          showToast("Cancelled");
          return;
        }
        button.classList.remove("recording");
        button.classList.add("processing");
        if (mode === "agent") showToast("Thinking...", true);
        const mime = recorder.mimeType.split(";")[0];
        const controller = new AbortController();
        voiceAbort = controller;
        const blob = new Blob(chunks, { type: mime });
        const request = mode === "dict"
          ? tab.transport.transcribeAudio(blob, mime)
          : tab.transport.sendVoiceMessage(blob, mime, getAgentSettings());
        request.then(data => {
          voiceReset();
          if (data.error) {
            showToast(data.error, false, !!data.turn_limit_reached);
            return;
          }
          if (mode === "dict") {
            if (data.text) {
              tab.transport.write(data.text).then(() => {
                if (manager.activeTab === tab) {
                  tab.term.scrollToBottom();
                  requestAnimationFrame(() => tab.term.scrollToBottom());
                  setTimeout(() => tab.term.scrollToBottom(), 50);
                }
              }).catch(() => tab.markDisconnected());
            }
            return;
          }
          tab.addAgentLog(data.response, data.commands);
          manager.renderAgentLog();
          if (data.audio) new Audio("data:audio/wav;base64," + data.audio).play().catch(() => {});
          const msg = data.speech || data.response;
          if (msg) showToast(msg, false, true);
          else dismissToast();
        }).catch(err => {
          if (controller.signal.aborted) {
            voiceReset();
            dismissToast();
            return;
          }
          voiceReset();
          showToast(String(err.message || err));
          console.error(err);
        });
      };
      recorder.start();
      button.classList.add("recording");
      updateVoiceControls();
    }).catch(err => {
      voiceReset();
      showToast("Mic: " + err.message);
    });
  }

  spMic.addEventListener("click", () => {
    if (micLongPressFired) return;
    if (voiceCancelPending) {
      return;
    }
    if (voiceAbort && voiceMode === "agent") {
      voiceCancelPending = true;
      cancelVoiceAgent();
      updateVoiceControls();
      showToast("Cancelling...", true);
    } else if (voiceRecorder && voiceRecorder.state === "recording" && voiceMode === "agent") {
      voiceRecorder.stop();
    } else if (!voiceRecorder && !voiceAbort) {
      startVoiceRecording("agent");
    }
  });

  function toggleDictation() {
    if (voiceAbort && voiceMode === "dict") {
      voiceAbort.abort();
      voiceReset();
      showToast("Cancelled");
    } else if (voiceRecorder && voiceRecorder.state === "recording" && voiceMode === "dict") {
      voiceRecorder.stop();
    } else if (!voiceRecorder && !voiceAbort) {
      startVoiceRecording("dict");
    }
  }

  spDict.addEventListener("click", () => {
    toggleDictation();
  });

  function requestVoiceCancel() {
    if (voiceCancelPending) {
      return false;
    }
    if (voiceRecorder && voiceRecorder.state === "recording") {
      voiceCancelled = true;
      voiceRecorder.stop();
      return true;
    }
    if (voiceAbort) {
      if (voiceMode === "agent") {
        voiceCancelPending = true;
        cancelVoiceAgent();
        updateVoiceControls();
        showToast("Cancelling...", true);
        return true;
      }
      voiceAbort.abort();
      voiceReset();
      showToast("Cancelled");
      return true;
    }
    return false;
  }

  spCancel.addEventListener("click", () => {
    requestVoiceCancel();
  });

  spHelp.addEventListener("click", () => helpModal.classList.add("active"));
  if (spFindPrev) spFindPrev.addEventListener("click", () => triggerFindPrev());
  if (spFind) spFind.addEventListener("click", () => triggerFind());
  if (spFindNext) spFindNext.addEventListener("click", () => triggerFindNext());

  const sessionsList = document.getElementById("sessions-list");
  const sessionsClose = document.getElementById("sessions-close");
  const sessionsTakeoverAll = document.getElementById("sessions-takeover-all");
  let currentSessionPickerSessions = [];
  async function openSessionPicker() {
    sessionsModal.classList.add("active");
    const tab = manager.activeTab;
    sessionsList.innerHTML = '<p class="sessions-empty">Loading...</p>';
    if (sessionsTakeoverAll) sessionsTakeoverAll.disabled = true;
    try {
      const basePath = baseTransport.basePath || "/envoy";
      const resp = await fetch(basePath + "/api/sessions");
      const sessions = await resp.json();
      currentSessionPickerSessions = sessions;
      const openSids = new Set(manager.tabs.map(t => t.transport.sessionId).filter(Boolean));
      const takeoverAllSessions = sessions.filter(s => !openSids.has(s.sid));
      if (sessionsTakeoverAll) sessionsTakeoverAll.disabled = !takeoverAllSessions.length;
      if (!sessions.length) {
        sessionsList.innerHTML = '<p class="sessions-empty">No active sessions</p>';
        return;
      }
      sessionsList.innerHTML = "";
      for (const s of sessions) {
        const item = document.createElement("div");
        item.className = "session-item";
        const isActive = tab && tab.transport.sessionId === s.sid;
        const isOpen = openSids.has(s.sid);
        if (isActive) {
          item.classList.add("session-item-active");
          item.style.opacity = "0.5";
        }
        const status = s.attached
          ? `attached (${s.clients || 1} client${(s.clients || 1) !== 1 ? "s" : ""})`
          : "detached";
        item.innerHTML =
          `<div class="session-item-id">${s.title || s.sid}</div>` +
          `<div class="session-item-cmd">${s.cmd.join(" ")}</div>` +
          `<div class="session-item-status ${s.attached ? "attached" : "detached"}">${status} &mdash; ${s.path}</div>`;
        if (!isActive && !isOpen) {
          const actions = document.createElement("div");
          actions.className = "session-item-actions";
          if (s.attached) {
            const takeover = document.createElement("button");
            takeover.type = "button";
            takeover.className = "session-action";
            takeover.textContent = "Takeover";
            takeover.addEventListener("click", () => attachSession(s.sid, "takeover"));
            const joinLead = document.createElement("button");
            joinLead.type = "button";
            joinLead.className = "session-action";
            joinLead.textContent = "Join as Lead";
            joinLead.addEventListener("click", () => attachSession(s.sid, "lead"));
            const joinFollow = document.createElement("button");
            joinFollow.type = "button";
            joinFollow.className = "session-action";
            joinFollow.textContent = "Follow";
            joinFollow.addEventListener("click", () => attachSession(s.sid, "follow"));
            actions.append(takeover, joinLead, joinFollow);
          } else {
            const attach = document.createElement("button");
            attach.type = "button";
            attach.className = "session-action";
            attach.textContent = "Attach";
            attach.addEventListener("click", () => attachSession(s.sid, "takeover"));
            actions.appendChild(attach);
          }
          item.appendChild(actions);
        }
        sessionsList.appendChild(item);
      }
      function attachSession(sid, mode) {
        const unused = tab && tab.isNew && !tab.hasInput ? tab : null;
        manager.createTab({ activate: true, sessionId: sid, mode }).then(() => {
          if (unused) manager.closeTab(unused.id).catch(() => {});
          const openSidsNow = new Set(manager.tabs.map(t => t.transport.sessionId).filter(Boolean));
          const hasUnopenedSessions = sessions.some(s => !openSidsNow.has(s.sid));
          if (hasUnopenedSessions) {
            openSessionPicker();
          } else {
            sessionsModal.classList.remove("active");
          }
        }).catch(err => {
          sessionsModal.classList.remove("active");
          showToast(String(err), true);
        });
      }
    } catch (err) {
      sessionsList.innerHTML = `<p class="sessions-empty">${err.message || err}</p>`;
    }
  }

  const sessionsNewTab = document.getElementById("sessions-new-tab");

  if (spSessions) {
    if (window.pywebview) {
      spSessions.style.display = "none";
    }
    let sessionsLongPress = null;
    let sessionsLongPressFired = false;
    function copySessionId() {
      const tab = currentTab();
      if (!tab || !tab.transport.sessionId) { showToast("No active session"); return; }
      navigator.clipboard.writeText(tab.transport.sessionId).then(() => showToast("Session ID copied")).catch(() => showToast("Failed to copy"));
    }
    spSessions.addEventListener("pointerdown", () => {
      sessionsLongPressFired = false;
      sessionsLongPress = setTimeout(() => {
        sessionsLongPress = null;
        sessionsLongPressFired = true;
        copySessionId();
      }, 500);
    });
    spSessions.addEventListener("pointerup", () => {
      if (sessionsLongPress !== null) { clearTimeout(sessionsLongPress); sessionsLongPress = null; }
    });
    spSessions.addEventListener("pointercancel", () => {
      if (sessionsLongPress !== null) { clearTimeout(sessionsLongPress); sessionsLongPress = null; }
    });
    spSessions.addEventListener("pointermove", e => {
      if (sessionsLongPress && (Math.abs(e.movementX) > 5 || Math.abs(e.movementY) > 5)) {
        clearTimeout(sessionsLongPress); sessionsLongPress = null;
      }
    });
    spSessions.addEventListener("contextmenu", e => {
      e.preventDefault();
      if (sessionsLongPress !== null) { clearTimeout(sessionsLongPress); sessionsLongPress = null; }
      sessionsLongPressFired = true;
      copySessionId();
    });
    spSessions.addEventListener("click", () => {
      if (sessionsLongPressFired) return;
      openSessionPicker();
    });
  }
  if (sessionsTakeoverAll) {
    sessionsTakeoverAll.addEventListener("click", async () => {
      const sessions = currentSessionPickerSessions;
      const openSids = new Set(manager.tabs.map(t => t.transport.sessionId).filter(Boolean));
      const sessionsToTakeOver = sessions.filter(s => !openSids.has(s.sid));
      if (!sessionsToTakeOver.length) return;
      sessionsTakeoverAll.disabled = true;
      try {
        const unused = manager.activeTab && manager.activeTab.isNew && !manager.activeTab.hasInput ? manager.activeTab : null;
        for (const s of sessionsToTakeOver) {
          await manager.createTab({ activate: true, sessionId: s.sid, mode: "takeover" });
        }
        if (unused) await manager.closeTab(unused.id).catch(() => {});
        sessionsModal.classList.remove("active");
      } catch (err) {
        sessionsModal.classList.remove("active");
        showToast(String(err), true);
      }
    });
  }
  sessionsNewTab.addEventListener("click", () => {
    sessionsModal.classList.remove("active");
    manager.createTab({ activate: true }).catch(err => showToast(String(err), true));
  });
  sessionsClose.addEventListener("click", () => sessionsModal.classList.remove("active"));

  manager.onLastTabClosed = () => openSessionPicker();
  sessionsModal.addEventListener("click", (e) => {
    if (e.target === sessionsModal) sessionsModal.classList.remove("active");
  });

  const textInputArea = document.getElementById("text-input-area");
  const textInputSend = document.getElementById("text-input-send");
  const textInputClose = document.getElementById("text-input-close");
  const textInputDict = document.getElementById("text-input-dict");
  let textAbort = null;
  let textDictRecorder = null;
  let textDictStream = null;

  function openTextInput() {
    textInputModal.classList.add("active");
    textInputArea.value = "";
    setTerminalInputActive(false);
    setTimeout(() => textInputArea.focus(), 50);
  }

  function closeTextInput() {
    textInputModal.classList.remove("active");
    focusCurrent();
    updateMobileInputBar();
  }

  function sendTextMessage() {
    const tab = currentTab();
    const text = textInputArea.value.trim();
    if (!tab || !text) return;
    closeTextInput();
    spText.classList.add("processing");
    showToast("Thinking...", true);
    const controller = new AbortController();
    textAbort = controller;
    tab.transport.sendTextMessage(text, getAgentSettings()).then(data => {
      spText.classList.remove("processing");
      textAbort = null;
      if (data.error) {
        showToast(data.error, false, !!data.turn_limit_reached);
        return;
      }
      tab.addAgentLog(data.response, data.commands, text);
      manager.renderAgentLog();
      if (data.audio) new Audio("data:audio/wav;base64," + data.audio).play().catch(() => {});
      const msg = data.speech || data.response;
      if (msg) showToast(msg, false, true);
      else dismissToast();
    }).catch(err => {
      spText.classList.remove("processing");
      textAbort = null;
      if (controller.signal.aborted) { dismissToast(); return; }
      showToast(String(err.message || err));
      console.error(err);
    });
  }

  spText.addEventListener("click", () => {
    if (textAbort) {
      cancelVoiceAgent();
      textAbort.abort();
      textAbort = null;
      spText.classList.remove("processing");
      showToast("Cancelled");
    } else {
      openTextInput();
    }
  });

  textInputSend.addEventListener("click", sendTextMessage);
  textInputClose.addEventListener("click", closeTextInput);
  textInputArea.addEventListener("keydown", e => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendTextMessage();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeTextInput();
    }
    e.stopPropagation();
  }, { capture: true });
  textInputArea.addEventListener("keypress", e => e.stopPropagation(), { capture: true });
  textInputModal.addEventListener("click", e => { if (e.target === textInputModal) closeTextInput(); });

  function stopTextDict() {
    if (textDictStream) {
      textDictStream.getTracks().forEach(t => t.stop());
      textDictStream = null;
    }
    textDictRecorder = null;
    textInputDict.classList.remove("recording", "processing");
    textInputDict.textContent = "Dictate";
    updateViewportState();
    updateMobileInputBar();
  }

  textInputDict.addEventListener("click", () => {
    const tab = currentTab();
    if (!tab) return;
    if (textDictRecorder && textDictRecorder.state === "recording") {
      textDictRecorder.stop();
      return;
    }
    if (textDictRecorder) return;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      textDictStream = stream;
      const chunks = [];
      const mimeOpts = ["audio/ogg;codecs=opus", "audio/ogg", "audio/webm;codecs=opus", "audio/webm", "audio/wav"];
      const mimeOpt = mimeOpts.find(m => MediaRecorder.isTypeSupported(m));
      const recorder = mimeOpt ? new MediaRecorder(stream, { mimeType: mimeOpt }) : new MediaRecorder(stream);
      textDictRecorder = recorder;
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        textInputDict.classList.remove("recording");
        textInputDict.classList.add("processing");
        textInputDict.textContent = "Transcribing...";
        const mime = recorder.mimeType.split(";")[0];
        const blob = new Blob(chunks, { type: mime });
        tab.transport.transcribeAudio(blob, mime).then(data => {
          stopTextDict();
          if (data.text) {
            const start = textInputArea.selectionStart;
            const end = textInputArea.selectionEnd;
            const before = textInputArea.value.substring(0, start);
            const after = textInputArea.value.substring(end);
            const prefix = before.length && !before.endsWith(" ") && !before.endsWith("\n") ? " " : "";
            textInputArea.value = before + prefix + data.text + after;
            const cursor = start + prefix.length + data.text.length;
            textInputArea.selectionStart = textInputArea.selectionEnd = cursor;
          }
          textInputArea.focus();
        }).catch(err => {
          stopTextDict();
          showToast("Dictation: " + (err.message || err));
          textInputArea.focus();
        });
      };
      recorder.start();
      textInputDict.classList.add("recording");
      textInputDict.textContent = "Stop";
    }).catch(err => {
      stopTextDict();
      showToast("Mic: " + err.message);
    });
  });

  const pasteEditorArea = document.getElementById("paste-editor-area");
  const pasteEditorCancel = document.getElementById("paste-editor-cancel");
  let pasteEditorOpen = false;

  function openPasteEditor() {
    pasteEditorOpen = true;
    pasteEditorModal.classList.add("active");
    spPaste.classList.add("sp-active");
    setTerminalInputActive(false);
    setTimeout(() => pasteEditorArea.focus(), 50);
  }

  function closePasteEditorWithPaste() {
    const text = pasteEditorArea.value;
    const tab = currentTab();
    pasteEditorOpen = false;
    pasteEditorModal.classList.remove("active");
    spPaste.classList.remove("sp-active");
    if (text && tab) tab.transport.write("\x1b[200~" + text + "\x1b[201~").catch(err => tab.handleWriteError(err));
    pasteEditorArea.value = "";
    focusCurrent();
    updateMobileInputBar();
  }

  function closePasteEditorCancel() {
    pasteEditorOpen = false;
    pasteEditorModal.classList.remove("active");
    spPaste.classList.remove("sp-active");
    focusCurrent();
    updateMobileInputBar();
  }

  async function pasteClipboardToTerminal() {
    const tab = currentTab();
    if (!tab) return;
    if (!navigator.clipboard?.readText || !window.isSecureContext) {
      showToast("Clipboard paste is not available here");
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        showToast("Clipboard is empty");
        return;
      }
      await tab.transport.write("\x1b[200~" + text + "\x1b[201~");
      showToast("Pasted");
      focusCurrent();
    } catch (err) {
      showToast("Paste failed");
    }
  }

  let pasteButtonLongPress = null;
  let pasteButtonLongPressFired = false;
  spPaste.addEventListener("pointerdown", () => {
    pasteButtonLongPressFired = false;
    pasteButtonLongPress = setTimeout(() => {
      pasteButtonLongPress = null;
      pasteButtonLongPressFired = true;
      pasteClipboardToTerminal();
    }, 500);
  });
  spPaste.addEventListener("pointerup", () => {
    if (pasteButtonLongPress !== null) {
      clearTimeout(pasteButtonLongPress);
      pasteButtonLongPress = null;
    }
  });
  spPaste.addEventListener("pointercancel", () => {
    if (pasteButtonLongPress !== null) {
      clearTimeout(pasteButtonLongPress);
      pasteButtonLongPress = null;
    }
  });
  spPaste.addEventListener("pointermove", e => {
    if (pasteButtonLongPress && (Math.abs(e.movementX) > 5 || Math.abs(e.movementY) > 5)) {
      clearTimeout(pasteButtonLongPress);
      pasteButtonLongPress = null;
    }
  });
  spPaste.addEventListener("contextmenu", e => {
    e.preventDefault();
    if (pasteButtonLongPress !== null) {
      clearTimeout(pasteButtonLongPress);
      pasteButtonLongPress = null;
    }
    pasteButtonLongPressFired = true;
    pasteClipboardToTerminal();
  });
  spPaste.addEventListener("click", () => {
    if (pasteButtonLongPressFired) {
      pasteButtonLongPressFired = false;
      return;
    }
    if (!pasteEditorOpen) openPasteEditor();
  });
  document.getElementById("paste-editor-submit").addEventListener("click", closePasteEditorWithPaste);
  pasteEditorCancel.addEventListener("click", closePasteEditorCancel);
  pasteEditorModal.addEventListener("click", e => { if (e.target === pasteEditorModal) closePasteEditorCancel(); });
  pasteEditorArea.addEventListener("keydown", e => {
    if (e.key === "Enter" && (e.ctrlKey || e.altKey)) {
      e.preventDefault();
      closePasteEditorWithPaste();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closePasteEditorCancel();
    }
    e.stopPropagation();
  }, { capture: true });
  pasteEditorArea.addEventListener("keypress", e => e.stopPropagation(), { capture: true });

  const pasteEditorDict = document.getElementById("paste-editor-dict");
  let pasteDictRecorder = null;
  let pasteDictStream = null;

  function stopPasteDict() {
    if (pasteDictStream) {
      pasteDictStream.getTracks().forEach(t => t.stop());
      pasteDictStream = null;
    }
    pasteDictRecorder = null;
    pasteEditorDict.classList.remove("recording", "processing");
    pasteEditorDict.textContent = "Dictate";
    updateViewportState();
    updateMobileInputBar();
  }

  pasteEditorDict.addEventListener("click", () => {
    const tab = currentTab();
    if (!tab) return;
    if (pasteDictRecorder && pasteDictRecorder.state === "recording") {
      pasteDictRecorder.stop();
      return;
    }
    if (pasteDictRecorder) return;
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      pasteDictStream = stream;
      const chunks = [];
      const mimeOpts = ["audio/ogg;codecs=opus", "audio/ogg", "audio/webm;codecs=opus", "audio/webm", "audio/wav"];
      const mimeOpt = mimeOpts.find(m => MediaRecorder.isTypeSupported(m));
      const recorder = mimeOpt ? new MediaRecorder(stream, { mimeType: mimeOpt }) : new MediaRecorder(stream);
      pasteDictRecorder = recorder;
      recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach(t => t.stop());
        pasteEditorDict.classList.remove("recording");
        pasteEditorDict.classList.add("processing");
        pasteEditorDict.textContent = "Transcribing...";
        const mime = recorder.mimeType.split(";")[0];
        const blob = new Blob(chunks, { type: mime });
        tab.transport.transcribeAudio(blob, mime).then(data => {
          stopPasteDict();
          if (data.text) {
            const start = pasteEditorArea.selectionStart;
            const end = pasteEditorArea.selectionEnd;
            const before = pasteEditorArea.value.substring(0, start);
            const after = pasteEditorArea.value.substring(end);
            const prefix = before.length && !before.endsWith(" ") && !before.endsWith("\n") ? " " : "";
            pasteEditorArea.value = before + prefix + data.text + after;
            const cursor = start + prefix.length + data.text.length;
            pasteEditorArea.selectionStart = pasteEditorArea.selectionEnd = cursor;
          }
          pasteEditorArea.focus();
        }).catch(err => {
          stopPasteDict();
          showToast("Dictation: " + (err.message || err));
          pasteEditorArea.focus();
        });
      };
      recorder.start();
      pasteEditorDict.classList.add("recording");
      pasteEditorDict.textContent = "Stop";
    }).catch(err => {
      stopPasteDict();
      showToast("Mic: " + err.message);
    });
  });

  const settingsGoogle = document.getElementById("settings-google");
  const settingsGroq = document.getElementById("settings-groq");
  const settingsInworld = document.getElementById("settings-inworld");
  const settingsUploadLink = document.getElementById("settings-upload-link");
  const settingsSave = document.getElementById("settings-save");
  const settingsClose = document.getElementById("settings-close");
  const settingsStatus = document.getElementById("settings-status");
  let uploadLinkUrl = "";

  function renderSettingsStatus(settings) {
    const missing = [];
    if (!settings.GOOGLE_API_KEY?.present) missing.push("Google");
    if (!settings.GROQ_API_KEY?.present) missing.push("Groq");
    if (!missing.length) {
      settingsStatus.textContent = "All configured.";
      settingsStatus.className = "success";
      return;
    }
    settingsStatus.textContent = "Missing: " + missing.join(", ");
    settingsStatus.className = "error";
  }

  async function loadSettingsIntoForm() {
    const settings = await baseTransport.getSettings();
    settingsGoogle.value = settings.GOOGLE_API_KEY?.value || "";
    settingsGroq.value = settings.GROQ_API_KEY?.value || "";
    settingsInworld.value = settings.INWORLD_API_KEY?.value || "";
    settingsUploadLink.value = settings.UPLOAD_LINK_URL?.value || "";
    uploadLinkUrl = settings.UPLOAD_LINK_URL?.value || "";
    renderSettingsStatus(settings);
  }

  function closeSettings() {
    settingsModal.classList.remove("active");
    focusCurrent();
    updateMobileInputBar();
  }

  async function openSettings() {
    settingsModal.classList.add("active");
    setTerminalInputActive(false);
    settingsStatus.textContent = "Loading...";
    settingsStatus.className = "";
    try {
      await loadSettingsIntoForm();
      setTimeout(() => settingsGoogle.focus(), 50);
    } catch (err) {
      settingsStatus.textContent = String(err);
      settingsStatus.className = "error";
    }
  }

  async function saveSettings() {
    settingsStatus.textContent = "Saving...";
    settingsStatus.className = "";
    try {
      const result = await baseTransport.saveSettings({
        GOOGLE_API_KEY: settingsGoogle.value,
        GROQ_API_KEY: settingsGroq.value,
        INWORLD_API_KEY: settingsInworld.value,
        UPLOAD_LINK_URL: settingsUploadLink.value,
      });
      uploadLinkUrl = settingsUploadLink.value;
      renderSettingsStatus(result.settings);
      showToast("Settings saved");
    } catch (err) {
      settingsStatus.textContent = String(err);
      settingsStatus.className = "error";
    }
  }

  baseTransport.getSettings().then(s => { uploadLinkUrl = s.UPLOAD_LINK_URL?.value || ""; }).catch(() => {});
  spSettings.addEventListener("click", () => openSettings());

  const fileViewerModal = document.getElementById("file-viewer-modal");
  const fileViewerClose = document.getElementById("file-viewer-close");
  const fileViewerDownload = document.getElementById("file-viewer-download");
  const fileViewerCopyPath = document.getElementById("file-viewer-copy-path");
  fileViewerClose.addEventListener("click", () => manager.closeFileViewer());
  fileViewerModal.addEventListener("click", e => {
    if (e.target === fileViewerModal) manager.closeFileViewer();
  });
  fileViewerCopyPath.addEventListener("click", () => {
    const info = manager._fileViewerInfo;
    if (info) manager.copyFilePath(info);
  });
  fileViewerDownload.addEventListener("click", () => {
    const info = manager._fileViewerInfo;
    const tab = manager._fileViewerTab;
    if (info && tab) tab.openResolvedFile(info, true);
  });
  document.addEventListener("keydown", e => {
    if (e.key === "Escape" && fileViewerModal.classList.contains("active")) {
      e.preventDefault();
      e.stopPropagation();
      manager.closeFileViewer();
    }
  }, { capture: true });

  settingsSave.addEventListener("click", () => saveSettings());
  settingsClose.addEventListener("click", () => closeSettings());
  settingsModal.addEventListener("click", e => { if (e.target === settingsModal) closeSettings(); });
  settingsModal.addEventListener("keydown", e => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeSettings();
    }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      saveSettings();
    }
    e.stopPropagation();
  }, { capture: true });

  // --- Agent settings modal (longpress on mic) ---
  const agentSettingsModal = document.getElementById("agent-settings-modal");
  const agentPersistence = document.getElementById("agent-persistence");
  const agentLookback = document.getElementById("agent-lookback");
  const agentLookbackVal = document.getElementById("agent-lookback-val");
  const agentTurnLimit = document.getElementById("agent-turn-limit");
  const agentSettingsReset = document.getElementById("agent-settings-reset");
  const agentSettingsClose = document.getElementById("agent-settings-close");

  const AGENT_DEFAULTS = { persistence: "persistent", lookback: 100, turnLimit: 20 };

  function loadAgentSettings() {
    try {
      const raw = localStorage.getItem("envoy_agent_settings");
      if (raw) return { ...AGENT_DEFAULTS, ...JSON.parse(raw) };
    } catch {}
    return { ...AGENT_DEFAULTS };
  }

  function saveAgentSettingsToStorage() {
    const settings = {
      persistence: agentPersistence.value,
      lookback: parseInt(agentLookback.value, 10),
      turnLimit: parseInt(agentTurnLimit.value, 10) || AGENT_DEFAULTS.turnLimit,
    };
    localStorage.setItem("envoy_agent_settings", JSON.stringify(settings));
  }

  function getAgentSettings() {
    const s = loadAgentSettings();
    return {
      agent_persistence: s.persistence,
      agent_lookback: s.lookback,
      agent_turn_limit: s.turnLimit,
    };
  }

  function openAgentSettings() {
    const s = loadAgentSettings();
    agentPersistence.value = s.persistence;
    agentLookback.value = s.lookback;
    agentLookbackVal.textContent = s.lookback;
    agentTurnLimit.value = s.turnLimit;
    agentSettingsModal.classList.add("active");
    setTerminalInputActive(false);
  }

  function closeAgentSettings() {
    saveAgentSettingsToStorage();
    agentSettingsModal.classList.remove("active");
    updateViewportState();
    focusCurrent();
    updateMobileInputBar();
  }

  function toggleTabBarVisibility() {
    tabBar.parentElement.classList.toggle("force-show");
    manager.updateTabBar();
  }

  agentLookback.addEventListener("input", () => {
    agentLookbackVal.textContent = agentLookback.value;
  });
  agentSettingsClose.addEventListener("click", closeAgentSettings);
  agentSettingsModal.addEventListener("click", e => { if (e.target === agentSettingsModal) closeAgentSettings(); });
  agentSettingsModal.addEventListener("keydown", e => {
    if (e.key === "Escape") { e.preventDefault(); closeAgentSettings(); }
    e.stopPropagation();
  }, { capture: true });

  agentSettingsReset.addEventListener("click", () => {
    const tab = currentTab();
    if (tab) {
      tab.transport.cancelAgent().catch(() => {});
      showToast("Agent reset");
    }
    closeAgentSettings();
  });

  // Longpress on mic button to open agent settings
  let micLongPressTimer = null;
  let micLongPressFired = false;
  spMic.addEventListener("pointerdown", e => {
    micLongPressFired = false;
    micLongPressTimer = setTimeout(() => {
      micLongPressFired = true;
      openAgentSettings();
    }, 500);
  });
  spMic.addEventListener("pointerup", () => { clearTimeout(micLongPressTimer); });
  spMic.addEventListener("pointercancel", () => { clearTimeout(micLongPressTimer); });
  spMic.addEventListener("pointermove", e => {
    if (micLongPressTimer && (Math.abs(e.movementX) > 5 || Math.abs(e.movementY) > 5)) {
      clearTimeout(micLongPressTimer);
    }
  });
  spMic.addEventListener("contextmenu", e => {
    e.preventDefault();
    if (micLongPressTimer) {
      clearTimeout(micLongPressTimer);
      micLongPressTimer = null;
    }
    micLongPressFired = true;
    openAgentSettings();
  });

  function scheduleFullscreenLayoutRefresh() {
    performLayoutRefresh();
    setTimeout(performLayoutRefresh, 100);
    setTimeout(performLayoutRefresh, 300);
  }

  spFs.addEventListener("click", () => {
    if (baseTransport.toggleFullscreen) {
      baseTransport.toggleFullscreen();
      scheduleFullscreenLayoutRefresh();
      return;
    }
    const el = document.documentElement;
    const fsElement = document.fullscreenElement || document.webkitFullscreenElement;
    if (fsElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else if (el.requestFullscreen) {
      el.requestFullscreen().catch(() => showToast("Fullscreen not supported"));
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
    }
  });
  document.addEventListener("fullscreenchange", () => {
    spFs.classList.toggle("sp-active", !!document.fullscreenElement);
    scheduleFullscreenLayoutRefresh();
  });

  spSel.addEventListener("click", () => {
    if (selectOverlay.classList.contains("active")) exitSelectMode();
    else enterSelectMode();
  });

  let tabAddLongPress = null;
  tabAdd.addEventListener("pointerdown", () => {
    tabAddLongPress = setTimeout(() => {
      tabAddLongPress = null;
      toggleTabBarVisibility();
    }, 500);
  });
  tabAdd.addEventListener("pointerup", () => {
    if (tabAddLongPress !== null) {
      clearTimeout(tabAddLongPress);
      tabAddLongPress = null;
      manager.createTab({ activate: true }).catch(err => showToast(String(err)));
    }
  });
  tabAdd.addEventListener("pointercancel", () => {
    if (tabAddLongPress !== null) {
      clearTimeout(tabAddLongPress);
      tabAddLongPress = null;
    }
  });
  tabAdd.addEventListener("contextmenu", e => {
    e.preventDefault();
    if (tabAddLongPress !== null) {
      clearTimeout(tabAddLongPress);
      tabAddLongPress = null;
    }
    toggleTabBarVisibility();
  });

  const focusTerminalFromTouch = e => {
    if (!isMobileClient) return;
    if (hasFindQuery()) {
      e.preventDefault?.();
      setTerminalInputActive(false);
      try { document.activeElement?.blur?.(); } catch {}
      updateMobileInputBar();
      return;
    }
    if (suppressNextTerminalFocus) {
      suppressNextTerminalFocus = false;
      return;
    }
    if (Date.now() < suppressTerminalFocusUntil) return;
    if (hasActiveModal()) return;
    if (e.target.closest("#side-panel, #mobile-input-bar, #help-modal, #voice-log-modal, #text-input-modal, #paste-editor-modal, #settings-modal, #sessions-modal")) return;
    requestAnimationFrame(() => focusCurrent());
  };

  terminalStack.addEventListener("touchend", focusTerminalFromTouch, { passive: true });
  terminalStack.addEventListener("mousedown", focusTerminalFromTouch);
  tabBar.addEventListener("touchend", focusTerminalFromTouch, { passive: true });
  tabBar.addEventListener("mousedown", focusTerminalFromTouch);

  document.addEventListener("keydown", e => {
    if (isMobileClient) setTerminalInputActive(true);
    if (e.key.toLowerCase() === "a" && e.ctrlKey && selectOverlay.classList.contains("active")) {
      e.preventDefault();
      manager.selectAllVisibleTerminal();
      return;
    }
    if (e.ctrlKey && e.key === "\\") {
      e.preventDefault();
      toggleSidePanel();
    }
    if (e.ctrlKey && e.key === ",") {
      e.preventDefault();
      openSettings();
    }
    if (e.ctrlKey && !e.shiftKey && (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "0")) {
      e.preventDefault();
      return;
    }
    if (e.ctrlKey && e.shiftKey && (e.key === "+" || e.key === "=")) {
      e.preventDefault();
      adjustFontSize(1);
      return;
    }
    if (e.ctrlKey && e.shiftKey && e.key === "_") {
      e.preventDefault();
      adjustFontSize(-1);
      return;
    }
    if (e.ctrlKey && e.shiftKey && e.key === ")") {
      e.preventDefault();
      resetFontSize();
      return;
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "n") {
      e.preventDefault();
      window.open(window.location.pathname, "_blank", `width=${window.outerWidth},height=${window.outerHeight}`);
    }
    if (e.ctrlKey && e.key.toLowerCase() === "t") {
      e.preventDefault();
      manager.createTab({ activate: true }).catch(err => showToast(String(err)));
    }
    if (e.ctrlKey && e.key.toLowerCase() === "w") {
      e.preventDefault();
      if (currentTab()) manager.closeTab(currentTab().id).catch(err => showToast(String(err)));
    }
    if (e.ctrlKey && e.key === "Tab") {
      e.preventDefault();
      if (manager.tabs.length > 1) {
        const idx = manager.tabs.indexOf(currentTab());
        const next = manager.tabs[(idx + 1) % manager.tabs.length];
        manager.activateTab(next.id);
      }
    }
    if (e.ctrlKey && e.shiftKey && e.code === "Space") {
      e.preventDefault();
      toggleDictation();
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "a") {
      e.preventDefault();
      startVoiceRecording("agent");
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      openPasteEditor();
    }
    if (e.ctrlKey && e.key.toLowerCase() === "d") {
      e.preventDefault();
    }
    if (e.key === "Escape" && sessionsModal.classList.contains("active")) {
      e.preventDefault();
      sessionsModal.classList.remove("active");
    }
    if (e.key === "Escape" && selectOverlay.classList.contains("active")) {
      e.preventDefault();
      exitSelectMode();
    }
    if (e.key === "Escape" && requestVoiceCancel()) {
      e.preventDefault();
    }
  }, { capture: true });

  if (mobileInputBar && isMobileClient) {
    const repeatableActions = new Set(["left", "right", "up", "down"]);
    const handleMobileInputPress = e => {
      const button = e.target.closest(".mobile-input-key");
      if (!button) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.type === "mousedown" && Date.now() - lastMobileTouchTime < 700) return;
      if (e.type === "touchstart") lastMobileTouchTime = Date.now();
      const modifier = button.dataset.key;
      if (modifier) {
        stopMobileInputRepeat();
        if (modifier === "Alt" && (e.type === "touchstart" || e.type === "mousedown")) {
          return;
        }
        clearMobileModifierLongPress();
        toggleMobileModifier(modifier);
        pulseMobileInputButton(button);
        focusCurrent();
        return;
      }
      const action = button.dataset.action || "";
      if ((action === "home" || action === "end") && (e.type === "touchstart" || e.type === "mousedown")) {
        clearMobileNavLongPress();
        mobileNavLongPressTriggered = false;
        mobileNavLongPressAction = action;
        mobileNavLongPressTimer = setTimeout(() => {
          if (mobileNavLongPressAction !== action) return;
          mobileNavLongPressTriggered = true;
          const longPressSequence = action === "home" ? mobileInputSequences.pageup : mobileInputSequences.pagedown;
          pulseMobileInputButton(button);
          writeSequenceToCurrentTab(longPressSequence).then(() => focusCurrent());
          resetMobileModifiers();
        }, MOBILE_NAV_LONG_PRESS_MS);
        return;
      }
      pulseMobileInputButton(button);
      const sequence = getMobileActionSequence(action);
      if (!sequence) return;
      if (sequence === MOBILE_ALT_LEFT_TOKEN) suppressNextMobileTerminalData(["\x1b[D", "\x1bOD", "b"]);
      if (sequence === MOBILE_ALT_RIGHT_TOKEN) suppressNextMobileTerminalData(["\x1b[C", "\x1bOC", "f"]);
      writeSequenceToCurrentTab(sequence).then(() => focusCurrent());
      if (sequence !== MOBILE_ALT_LEFT_TOKEN && sequence !== MOBILE_ALT_RIGHT_TOKEN) {
        resetMobileModifiers();
      }
      if (repeatableActions.has(action)) {
        startMobileInputRepeat(sequence);
      } else {
        stopMobileInputRepeat();
      }
    };
    const handleMobileInputRelease = e => {
      stopMobileInputRepeat();
      const button = e?.target?.closest?.(".mobile-input-key");
      const action = button?.dataset?.action || "";
      const wasNavLongPress = mobileNavLongPressTriggered;
      clearMobileNavLongPress();
      if (button && (action === "home" || action === "end") && !wasNavLongPress) {
        pulseMobileInputButton(button);
        const sequence = getMobileActionSequence(action);
        if (sequence) {
          writeSequenceToCurrentTab(sequence).then(() => focusCurrent());
          resetMobileModifiers();
        }
      }
      mobileNavLongPressTriggered = false;
    };
    mobileInputBar.addEventListener("touchstart", e => {
      const button = e.target.closest(".mobile-modifier-key[data-key='Alt']");
      clearMobileModifierLongPress();
      mobileModifierLongPressTriggered = false;
      if (!button) return;
      mobileModifierLongPressKey = "Alt";
      mobileModifierLongPressTimer = setTimeout(() => {
        if (mobileModifierLongPressKey !== "Alt") return;
        mobileModifierLongPressTriggered = true;
        const nextLocked = !mobileLockedModifiers.Alt;
        setMobileModifier("Alt", nextLocked, nextLocked);
        pulseMobileInputButton(button);
        focusCurrent();
      }, MOBILE_MODIFIER_LONG_PRESS_MS);
    }, { passive: true });
    mobileInputBar.addEventListener("touchend", e => {
      const button = e.target.closest(".mobile-modifier-key[data-key='Alt']");
      const wasLongPress = mobileModifierLongPressTriggered;
      clearMobileModifierLongPress();
      if (button && !wasLongPress) {
        toggleMobileModifier("Alt");
        pulseMobileInputButton(button);
        focusCurrent();
      }
      mobileModifierLongPressTriggered = false;
      handleMobileInputRelease(e);
    }, { passive: true });
    mobileInputBar.addEventListener("touchcancel", e => {
      clearMobileModifierLongPress();
      mobileModifierLongPressTriggered = false;
      clearMobileNavLongPress();
      mobileNavLongPressTriggered = false;
      handleMobileInputRelease(e);
    }, { passive: true });
    mobileInputBar.addEventListener("touchstart", handleMobileInputPress, { passive: false });
    mobileInputBar.addEventListener("mousedown", e => {
      const button = e.target.closest(".mobile-modifier-key[data-key='Alt']");
      clearMobileModifierLongPress();
      mobileModifierLongPressTriggered = false;
      if (!button) return;
      mobileModifierLongPressKey = "Alt";
      mobileModifierLongPressTimer = setTimeout(() => {
        if (mobileModifierLongPressKey !== "Alt") return;
        mobileModifierLongPressTriggered = true;
        const nextLocked = !mobileLockedModifiers.Alt;
        setMobileModifier("Alt", nextLocked, nextLocked);
        pulseMobileInputButton(button);
        focusCurrent();
      }, MOBILE_MODIFIER_LONG_PRESS_MS);
    });
    mobileInputBar.addEventListener("mousedown", handleMobileInputPress);
    mobileInputBar.addEventListener("mouseup", e => {
      const button = e.target.closest(".mobile-modifier-key[data-key='Alt']");
      const wasLongPress = mobileModifierLongPressTriggered;
      clearMobileModifierLongPress();
      if (button && !wasLongPress) {
        toggleMobileModifier("Alt");
        pulseMobileInputButton(button);
        focusCurrent();
      }
      mobileModifierLongPressTriggered = false;
      handleMobileInputRelease(e);
    });
    mobileInputBar.addEventListener("mouseleave", e => {
      clearMobileModifierLongPress();
      mobileModifierLongPressTriggered = false;
      clearMobileNavLongPress();
      mobileNavLongPressTriggered = false;
      handleMobileInputRelease(e);
    });
  }

  document.addEventListener("focusin", e => {
    if (!isMobileClient) return;
    if (e.target.closest("#text-input-modal, #paste-editor-modal, #settings-modal")) {
      setTerminalInputActive(false);
      performLayoutRefresh();
      return;
    }
    if (e.target.classList?.contains("xterm-helper-textarea")) {
      keyboardVisible = true;
      setTerminalInputActive(true);
      performLayoutRefresh();
    }
  });

  document.addEventListener("focusout", e => {
    if (!isMobileClient) return;
    if (e.target.classList?.contains("xterm-helper-textarea")) {
      setTimeout(() => {
        const active = document.activeElement;
        if (!active || !active.classList?.contains("xterm-helper-textarea")) {
          keyboardVisible = false;
          setTerminalInputActive(false);
          baselineViewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
          performLayoutRefresh();
        }
      }, 0);
    }
  });

  document.addEventListener("beforeinput", e => {
    if (!isMobileClient) return;
    if (!mobileModifiers.Control && !mobileModifiers.Alt) return;
    if (!e.target.classList?.contains("xterm-helper-textarea")) return;
    if (e.isComposing) return;

    if (e.inputType === "deleteContentBackward" || e.inputType === "deleteWordBackward") {
      e.preventDefault();
      e.stopImmediatePropagation();
      const sequence = getMobileModifiedKeySequence("Backspace");
      if (sequence === MOBILE_ALT_BACKSPACE_TOKEN) suppressNextMobileTerminalData(["\x7f", "\x08"]);
      if (sequence) writeSequenceToCurrentTab(sequence);
      const textarea = e.target;
      textarea.value = "";
      focusCurrent();
      return;
    }

    if (typeof e.data !== "string" || !e.data) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    writeSequenceToCurrentTab(encodeMobileInputSequence(e.data));
    const textarea = e.target;
    textarea.value = "";
    focusCurrent();
  }, true);

  document.addEventListener("input", e => {
    if (!isMobileClient) return;
    if (!mobileModifiers.Control && !mobileModifiers.Alt) return;
    if (!e.target.classList?.contains("xterm-helper-textarea")) return;
    if (e.inputType !== "deleteContentBackward" && e.inputType !== "deleteWordBackward") return;
    e.stopImmediatePropagation();
    const textarea = e.target;
    textarea.value = "";
  }, true);

  document.addEventListener("keydown", e => {
    if (!isMobileClient) return;
    if (!mobileModifiers.Control && !mobileModifiers.Alt) return;
    if (!e.target.classList?.contains("xterm-helper-textarea")) return;

    if (e.key === "Backspace" || e.key === "Enter" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      e.stopImmediatePropagation();
      const sequence = getMobileModifiedKeySequence(e.key);
      if (sequence === MOBILE_ALT_BACKSPACE_TOKEN) suppressNextMobileTerminalData(["\x7f", "\x08"]);
      if (sequence === MOBILE_ALT_LEFT_TOKEN) suppressNextMobileTerminalData(["\x1b[D", "\x1bOD", "b"]);
      if (sequence === MOBILE_ALT_RIGHT_TOKEN) suppressNextMobileTerminalData(["\x1b[C", "\x1bOC", "f"]);
      if (sequence) writeSequenceToCurrentTab(sequence);
      const textarea = e.target;
      textarea.value = "";
      focusCurrent();
    }
  }, true);

  document.body.addEventListener("keydown", e => {
    if (e.ctrlKey && e.shiftKey && e.key === "C") {
      document.execCommand("copy");
      e.stopPropagation();
      e.preventDefault();
    }
  }, false);
  document.body.addEventListener("keyup", e => {
    if (e.ctrlKey && e.shiftKey && e.key === "C") {
      e.stopPropagation();
      e.preventDefault();
    }
  }, false);

  window.addEventListener("beforeunload", () => {
    if (!(window.pywebview && window.pywebview.api)) {
      for (const tab of manager.tabs) {
        if (tab.transport?.sessionId) {
          const endpoint = (tab.isNew && !tab.hasInput) ? "/envoy/api/close_session" : "/envoy/api/detach";
          navigator.sendBeacon(
            endpoint,
            new Blob([JSON.stringify({
              session_id: tab.transport.sessionId,
              client_id: tab.transport.clientId,
            })], { type: "application/json" }),
          );
        }
      }
      return;
    }
    manager.closeAll().catch(() => {});
  });

  window.addEventListener("hashchange", () => {
    const sid = window.location.hash.slice(1);
    if (!sid) return;
    const tab = manager.activeTab;
    if (tab && tab.transport.sessionId === sid) return;
    openSessionPicker();
  });

  const recoverConnections = () => {
    manager.resumeActiveReads();
    manager.reconnectDisconnectedTabs();
    updateMobileInputBar();
    manager.activeTab?.fitTerminal();
  };

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      manager.pauseActiveReads();
    } else {
      recoverConnections();
    }
  });
  window.addEventListener("focus", recoverConnections);
  window.addEventListener("online", recoverConnections);
  window.addEventListener("pageshow", recoverConnections);

  const saved = window.matchMedia('(display-mode: standalone)').matches ? TabManager.loadTabState() : null;
  const hashSid = window.location.hash.slice(1);

  async function createFreshSessionAfterMissingHash(sid) {
    showToast(`Session not found: ${sid}`);
    history.replaceState(null, "", window.location.pathname + window.location.search);
    await manager.createTab({ activate: true });
  }

  async function createTabFromHashSid(sid, mode = "takeover") {
    try {
      return await manager.createTab({ activate: true, sessionId: sid, mode });
    } catch (err) {
      await createFreshSessionAfterMissingHash(sid);
      return null;
    }
  }

  (async () => {
    const claimed = await manager.getClaimedSids();
    if (saved) {
      for (const sid of saved.tabs) {
        if (claimed.has(sid)) continue;
        try {
          await manager.createTab({ activate: false, sessionId: sid });
        } catch {}
      }
      if (manager.tabs.length) {
        const active = manager.getTabById(saved.active) || manager.tabs[0];
        if (active) manager.activateTab(active.id);
      }
      manager.saveTabState();
    }
    if (!manager.tabs.length) {
      if (hashSid && claimed.has(hashSid)) {
        await createTabFromHashSid(hashSid, "follow");
      } else if (hashSid) {
        // Check if session is already attached before auto-connecting
        try {
          const basePath = baseTransport.basePath || "/envoy";
          const resp = await fetch(basePath + "/api/sessions");
          const sessions = await resp.json();
          const target = sessions.find(s => s.sid === hashSid);
          if (target && target.attached) {
            await createTabFromHashSid(hashSid, "lead");
          } else {
            await createTabFromHashSid(hashSid);
          }
        } catch {
          await createTabFromHashSid(hashSid);
        }
      } else {
        await manager.createTab({ activate: true });
      }
    }
    performLayoutRefresh();
  })().catch(err => {
    showToast(String(err), true);
    disconnectOverlay.classList.add("active");
  });
}
