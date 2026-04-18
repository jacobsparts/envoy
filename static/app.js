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
    this.pollInFlight = false;
    this.pollTimer = null;
    this.sessionId = "";
    this.clientId = "";
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
    return result;
  }

  startReading(onData, onDisconnect, onEvents) {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      if (this.pollInFlight || !this.sessionId) return;
      this.pollInFlight = true;
      try {
        const result = await this.api.read(this.sessionId, this.clientId);
        if (result.evicted) {
          onDisconnect({ kind: "evicted" });
          return;
        }
        const chunk = base64ToBytes(result.output);
        if (chunk.length) onData(chunk);
        if (result.events && result.events.length) onEvents(result.events);
        if (!result.alive) onDisconnect({ kind: "exit", exitCode: result.exit_code });
      } catch (err) {
        onDisconnect({ kind: "error", error: err });
      } finally {
        this.pollInFlight = false;
      }
    }, 33);
  }

  stopReading() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
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
    this._openStream();
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

  pauseStream() {
    if (this._paused) return;
    this._paused = true;
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
    const es = this.eventSource;
    if (es && es.readyState === EventSource.OPEN) return;
    if (es) {
      this.eventSource = null;
      try { es.close(); } catch {}
    }
    this._openStream();
  }

  stopReading() {
    this.closed = true;
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

  async uploadFile(name, b64data) {
    if (!this.sessionId) return;
    await this.requestJson("/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: this.sessionId, name, data: b64data }),
    });
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
      return true;
    });
    this.updateScrollbackClass();
    this.button = document.createElement("div");
    this.button.className = "tab-item";
    this.button.innerHTML = `<span class="tab-title"></span><input class="tab-title-input" type="text" spellcheck="false"><button class="tab-close" type="button" title="Close tab">&times;</button>`;
    this.button.querySelector(".tab-title").textContent = this.title;
    this.button.addEventListener("click", () => this.manager.activateTab(this.id));
    const titleSpan = this.button.querySelector(".tab-title");
    const titleInput = this.button.querySelector(".tab-title-input");
    titleSpan.addEventListener("click", e => {
      if (this.manager.activeTab !== this) return;
      const range = document.createRange();
      range.selectNodeContents(titleSpan);
      const textRect = range.getBoundingClientRect();
      if (e.clientX > textRect.right) return;
      e.stopPropagation();
      titleInput.value = this.title;
      this.button.classList.add("editing");
      titleInput.focus();
      titleInput.setSelectionRange(titleInput.value.length, titleInput.value.length);
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
    if (chunk.length) {
      this._suppressInput = true;
      this.term.write(chunk, () => { this._suppressInput = false; });
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
      data => this.term.write(data),
      info => this.handleDisconnect(info),
      events => this.handleAgentEvents(events),
      () => this.handlePromotion(),
    );
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
    this.fitTerminal();
    this.focus();
  }

  hide() {
    this.pane.classList.remove("active");
    this.button.classList.remove("active");
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
      || sessionsModal.classList.contains("active");
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
    const visible = keyboardVisible && terminalInputActive && !selectOverlay.classList.contains("active") && !hasActiveModal();
    mobileInputBar.classList.toggle("active", visible);
    workspace.classList.toggle("with-mobile-input-bar", visible);
    sidePanel.classList.toggle("with-mobile-input-bar", visible);
    applyMobileInputBarInset();
  }

  function setTerminalInputActive(active) {
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

  function exitSelectMode() {
    selectOverlay.classList.remove("active");
    selectOverlay.innerHTML = "";
    selectOverlay.style.height = "";
    const xtermEl = currentXtermEl();
    if (xtermEl) xtermEl.classList.remove("select-mode");
    spSel.classList.remove("sp-active");
    currentTerm()?.scrollToBottom();
    focusCurrent();
    updateMobileInputBar();
  }

  let dragCount = 0;
  document.addEventListener("dragenter", e => {
    e.preventDefault();
    if (++dragCount === 1) overlay.classList.add("active");
  });
  document.addEventListener("dragleave", e => {
    e.preventDefault();
    if (--dragCount === 0) overlay.classList.remove("active");
  });
  document.addEventListener("dragover", e => e.preventDefault());
  document.addEventListener("drop", e => {
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
  spUpload.addEventListener("click", () => { fileInput.value = ""; fileInput.click(); });
  fileInput.addEventListener("change", () => {
    const tab = currentTab();
    if (!tab || !fileInput.files.length) return;
    for (const file of fileInput.files) {
      const reader = new FileReader();
      reader.onload = () => {
        const b64 = reader.result.split(",")[1];
        tab.transport.uploadFile(file.name, b64).catch(err => showToast(String(err)));
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
            showToast(data.error);
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

  const sessionsList = document.getElementById("sessions-list");
  const sessionsClose = document.getElementById("sessions-close");
  async function openSessionPicker() {
    sessionsModal.classList.add("active");
    const tab = manager.activeTab;
    sessionsList.innerHTML = '<p class="sessions-empty">Loading...</p>';
    try {
      const basePath = baseTransport.basePath || "/envoy";
      const resp = await fetch(basePath + "/api/sessions");
      const sessions = await resp.json();
      const openSids = new Set(manager.tabs.map(t => t.transport.sessionId).filter(Boolean));
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
        sessionsModal.classList.remove("active");
        const unused = tab && tab.isNew && !tab.hasInput ? tab : null;
        manager.createTab({ activate: true, sessionId: sid, mode }).then(() => {
          if (unused) manager.closeTab(unused.id).catch(() => {});
        }).catch(err => showToast(String(err), true));
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
    spSessions.addEventListener("click", () => openSessionPicker());
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
        showToast(data.error);
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

  spPaste.addEventListener("click", () => { if (!pasteEditorOpen) openPasteEditor(); });
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
  const settingsSave = document.getElementById("settings-save");
  const settingsClose = document.getElementById("settings-close");
  const settingsStatus = document.getElementById("settings-status");

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
      });
      renderSettingsStatus(result.settings);
      showToast("Settings saved");
    } catch (err) {
      settingsStatus.textContent = String(err);
      settingsStatus.className = "error";
    }
  }

  spSettings.addEventListener("click", () => openSettings());
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
        await manager.createTab({ activate: true });
      } else if (hashSid) {
        // Check if session is already attached before auto-connecting
        try {
          const basePath = baseTransport.basePath || "/envoy";
          const resp = await fetch(basePath + "/api/sessions");
          const sessions = await resp.json();
          const target = sessions.find(s => s.sid === hashSid);
          if (target && target.attached) {
            await manager.createTab({ activate: true });
            openSessionPicker();
          } else {
            await manager.createTab({ activate: true, sessionId: hashSid });
          }
        } catch {
          await manager.createTab({ activate: true, sessionId: hashSid });
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
