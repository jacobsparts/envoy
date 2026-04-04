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
    return result;
  }

  startReading(onData, onDisconnect, onEvents) {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      if (this.pollInFlight || !this.sessionId) return;
      this.pollInFlight = true;
      try {
        const result = await this.api.read(this.sessionId);
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
    await this.api.write(this.sessionId, stringToBase64(data));
  }

  async resize(cols, rows) {
    if (!this.sessionId) return;
    await this.api.resize(this.sessionId, cols, rows);
  }

  async uploadFile(name, b64data) {
    if (!this.sessionId) return;
    await this.api.upload_file(this.sessionId, name, b64data);
  }

  async sendTextMessage(text) {
    return this.api.send_text_message(this.sessionId, text);
  }

  async sendVoiceMessage(audioBlob, mime) {
    const bytes = new Uint8Array(await audioBlob.arrayBuffer());
    return this.api.send_voice_message(this.sessionId, bytesToBase64(bytes), mime);
  }

  async transcribeAudio(audioBlob, mime) {
    const bytes = new Uint8Array(await audioBlob.arrayBuffer());
    return this.api.transcribe_audio(bytesToBase64(bytes), mime);
  }

  async cancelAgent() {
    if (!this.sessionId) return;
    await this.api.cancel_agent(this.sessionId);
  }

  async close() {
    this.stopReading();
    if (!this.sessionId) return;
    const sid = this.sessionId;
    this.sessionId = "";
    await this.api.close_session(sid);
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
    this.pollInFlight = false;
    this.sessionId = "";
    this.clientId = "";
    this.readLoopId = 0;
    this.closed = false;
    this.readTimer = null;
    this.readRetryDelay = 250;
    this.onData = null;
    this.onDisconnect = null;
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

  async connect(existingSessionId) {
    const result = await this.requestJson("/api/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: this.targetPath, session_id: existingSessionId || "" }),
    });
    this.sessionId = result.sid;
    this.clientId = result.client_id || "";
    return result;
  }

  startReading(onData, onDisconnect, onEvents) {
    this.stopReading();
    this.closed = false;
    this.onData = onData;
    this.onDisconnect = onDisconnect;
    this.onEvents = onEvents;
    this.readRetryDelay = 250;
    const loopId = ++this.readLoopId;
    this.scheduleRead(loopId, 0);
  }

  scheduleRead(loopId, delay = 0) {
    if (this.readTimer) clearTimeout(this.readTimer);
    this.readTimer = setTimeout(() => {
      this.readTimer = null;
      this.runRead(loopId);
    }, delay);
  }

  nextReadRetryDelay() {
    const delay = this.readRetryDelay;
    this.readRetryDelay = Math.min(this.readRetryDelay * 2, 5000);
    return delay;
  }

  shouldRetryRead(err) {
    if (!err) return true;
    if (err.name === "TypeError") return true;
    if (typeof err.status === "number") {
      return err.status === 408 || err.status === 429 || err.status >= 500;
    }
    return true;
  }

  async runRead(loopId) {
    if (this.closed || !this.sessionId || this.readLoopId !== loopId || this.pollInFlight) return;
    this.pollInFlight = true;
    let retryDelay = null;
    try {
      const result = await this.requestJson("/api/read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: this.sessionId, client_id: this.clientId, wait_timeout: 20 }),
      });
      if (this.closed || this.readLoopId !== loopId) return;
      this.readRetryDelay = 250;
      if (result.evicted) {
        this.onDisconnect?.({ kind: "evicted" });
        return;
      }
      const chunk = base64ToBytes(result.output);
      if (chunk.length) this.onData?.(chunk);
      if (result.events && result.events.length) this.onEvents?.(result.events);
      if (!result.alive) {
        this.onDisconnect?.({ kind: "exit", exitCode: result.exit_code });
        return;
      }
    } catch (err) {
      if (this.closed || this.readLoopId !== loopId) return;
      if (this.shouldRetryRead(err)) {
        retryDelay = this.nextReadRetryDelay();
      } else {
        this.onDisconnect?.({ kind: "error", error: err });
        return;
      }
    } finally {
      this.pollInFlight = false;
    }
    if (this.closed || !this.sessionId || this.readLoopId !== loopId) return;
    this.scheduleRead(loopId, retryDelay ?? 0);
  }

  resumeReading() {
    if (this.closed || !this.sessionId || this.pollInFlight) return;
    this.readRetryDelay = 250;
    this.scheduleRead(this.readLoopId, 0);
  }

  stopReading() {
    this.closed = true;
    this.readLoopId += 1;
    if (this.readTimer) {
      clearTimeout(this.readTimer);
      this.readTimer = null;
    }
  }

  async write(data) {
    if (!this.sessionId) return;
    await this.requestJson("/api/write", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: this.sessionId, data: stringToBase64(data) }),
    });
  }

  async resize(cols, rows) {
    if (!this.sessionId) return;
    await this.requestJson("/api/resize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: this.sessionId, cols, rows }),
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

  async sendTextMessage(text) {
    return this.requestJson("/api/text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: this.sessionId, text }),
    });
  }

  async sendVoiceMessage(audioBlob, mime) {
    const response = await fetch(this.basePath + "/api/voice", {
      method: "POST",
      headers: {
        "Content-Type": mime,
        "X-Session-Id": this.sessionId,
      },
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

  async close() {
    this.stopReading();
    if (!this.sessionId) return;
    const sid = this.sessionId;
    this.sessionId = "";
    await this.requestJson("/api/close_session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sid }),
    });
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
    this.disconnected = false;
    this.disconnectInfo = null;
    this.closed = false;
    this.reconnecting = false;
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
    this.button.innerHTML = `<span class="tab-title"></span><button class="tab-close" type="button" title="Close tab">&times;</button>`;
    this.button.querySelector(".tab-title").textContent = this.title;
    this.button.addEventListener("click", () => this.manager.activateTab(this.id));
    this.button.querySelector(".tab-close").addEventListener("click", e => {
      e.stopPropagation();
      this.manager.closeTab(this.id);
    });

    this.term.onData(data => {
      if (!this.disconnected) {
        this.transport.write(data).catch(() => this.markDisconnected());
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

  async connect(existingSessionId = "") {
    const result = await this.transport.connect(existingSessionId);
    this.button.dataset.sid = result.sid;
    this.updateTitle(this.title);
    this.term.reset();
    const chunk = base64ToBytes(result.output);
    if (chunk.length) this.term.write(chunk);
    this.disconnected = false;
    this.disconnectInfo = null;
    this.reconnecting = false;
    this.button.classList.remove("exited");
    this.updateScrollbackClass();
    this.transport.startReading(
      data => this.term.write(data),
      info => this.handleDisconnect(info),
      events => this.handleAgentEvents(events),
    );
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
    try {
      this.term._core?._charSizeService?.measure();
    } catch {}
    this.fit.fit();
    try {
      this.term.resize(this.term.cols, this.term.rows);
    } catch {}
    try {
      this.term._core?._viewport?._refresh?.();
    } catch {}
    if (typeof this.term.refresh === "function") {
      this.term.refresh(0, Math.max(0, this.term.rows - 1));
      requestAnimationFrame(() => this.term.refresh(0, Math.max(0, this.term.rows - 1)));
    }
    this.updateScrollbackClass();
    if (!this.disconnected) {
      this.transport.resize(this.term.cols, this.term.rows).catch(() => this.markDisconnected());
    }
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
  }

  canReconnect() {
    if (this.closed || !this.disconnected || this.reconnecting) return false;
    if (!this.transport.sessionId) return false;
    return this.disconnectInfo?.kind !== "evicted" && this.disconnectInfo?.kind !== "exit";
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
    this.resizeObserver?.disconnect();
    this.pane.remove();
    this.button.remove();
    const transport = this.transport;
    setTimeout(() => {
      transport.close().catch(err => console.error(err));
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
  }

  updateTabBar() {
    this.elements.tabs.parentElement.classList.toggle("single", this.tabs.length <= 1);
  }

  syncHash() {
    const sid = this.activeTab?.transport.sessionId || "";
    const hash = sid ? "#" + sid : "";
    if (window.location.hash !== hash) {
      history.replaceState(null, "", hash || window.location.pathname + window.location.search);
    }
  }

  async createTab({ activate = true, sessionId = "" } = {}) {
    const tab = new TerminalTab(this, this.baseTransport.clone(), this.nextIndex++);
    this.tabs.push(tab);
    this.elements.stack.appendChild(tab.pane);
    this.elements.tabs.appendChild(tab.button);
    this.updateTabBar();
    await tab.connect(sessionId);
    if (activate || !this.activeTab) this.activateTab(tab.id);
    this.syncHash();
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
  }

  updateDisconnectOverlay() {
    this.elements.disconnect.classList.toggle("active", !!(this.activeTab && this.activeTab.disconnected));
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
    showToast(event.text.length > 80 ? event.text.substring(0, 77) + "..." : event.text, false, true);
  }

  async closeTab(id) {
    const tab = this.getTabById(id);
    if (!tab) return;
    const wasActive = this.activeTab === tab;
    const tabIndex = this.tabs.indexOf(tab);
    const remaining = this.tabs.filter(item => item !== tab);
    this.tabs = remaining;
    this.updateTabBar();
    if (wasActive) {
      this.activeTab = null;
    }
    if (!remaining.length) {
      await tab.close();
      if (window.pywebview) {
        await this.baseTransport.closeApp();
        return;
      }
      if (window.matchMedia('(display-mode: standalone)').matches && window.matchMedia('(pointer: fine)').matches) {
        window.close();
        return;
      }
      await this.createTab({ activate: true });
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

  reconnectDisconnectedTabs() {
    for (const tab of this.tabs) {
      if (tab.canReconnect()) {
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
  let mobileBarInset = 0;
  let resizeObserver = null;
  let mobileRepeatTimer = null;
  let mobileRepeatDelayTimer = null;
  let suppressNextTerminalFocus = false;
  let suppressTerminalFocusUntil = 0;
  let lastMobileTouchTime = 0;
  let baselineViewportHeight = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const mobileModifiers = { Control: false, Alt: false };
  const mobileInputSequences = {
    escape: "\x1b",
    tab: "\t",
    left: "\x1b[D",
    up: "\x1b[A",
    down: "\x1b[B",
    right: "\x1b[C",
    home: "\x1b[H",
    end: "\x1b[F",
  };

  function dismissToast() {
    if (toastLocked) return;
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
      toast.classList.add("active");
      toastLocked = true;
      toastTimer = setTimeout(() => { toastLocked = false; }, 3000);
    } else {
      toast.classList.add("active");
      toastTimer = setTimeout(() => toast.classList.remove("active"), 1500);
    }
  }

  function hasActiveModal() {
    return helpModal.classList.contains("active")
      || agentLogModal.classList.contains("active")
      || textInputModal.classList.contains("active")
      || pasteEditorModal.classList.contains("active")
      || settingsModal.classList.contains("active");
  }

  document.addEventListener("keydown", () => dismissToast(), { capture: true });
  document.addEventListener("click", () => dismissToast(), { capture: true });

  const manager = new TabManager(baseTransport, {
    stack: terminalStack,
    tabs: tabBar,
    disconnect: disconnectOverlay,
    agentLog: agentLogEntries,
    selectOverlay,
  });

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

  function sendResize() {
    if (manager.activeTab) manager.activeTab.fitTerminal();
    syncSelectOverlaySize();
  }

  function applyMobileInputBarInset() {
    if (!mobileInputBar || !isMobileClient) return;
    mobileInputBar.style.bottom = `${mobileBarInset}px`;
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

  function resetMobileModifiers() {
    mobileModifiers.Control = false;
    mobileModifiers.Alt = false;
    for (const button of mobileInputBar?.querySelectorAll(".mobile-modifier-key") || []) {
      const key = button.dataset.key;
      button.classList.toggle("active", !!mobileModifiers[key]);
    }
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

  function writeSequenceToCurrentTab(sequence) {
    const tab = currentTab();
    if (!tab || tab.disconnected) return Promise.resolve();
    return tab.transport.write(sequence).catch(() => tab.markDisconnected());
  }

  function sendMobileInput(sequence) {
    writeSequenceToCurrentTab(encodeMobileInputSequence(sequence));
    focusCurrent();
  }

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
        writeSequenceToCurrentTab(sequence);
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
    const offsetTop = vv ? vv.offsetTop : 0;

    if (!terminalInputActive && !hasActiveModal()) {
      baselineViewportHeight = Math.max(baselineViewportHeight, viewportHeight);
    }

    const keyboardDelta = Math.max(0, baselineViewportHeight - viewportHeight);
    keyboardVisible = isMobileClient && terminalInputActive && (window.visualViewport ? keyboardDelta > 100 : true);
    mobileBarInset = keyboardVisible ? Math.max(0, offsetTop) : 0;
  }

  function performLayoutRefresh() {
    updateViewportState();
    updateMobileInputBar();
    requestAnimationFrame(() => {
      sendResize();
      requestAnimationFrame(() => sendResize());
    });
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
  const spSettings = document.getElementById("sp-settings");
  const spLog = document.getElementById("sp-log");
  const spText = document.getElementById("sp-text");
  const spPaste = document.getElementById("sp-paste");
  const spSel = document.getElementById("sp-sel");
  const spFs = document.getElementById("sp-fs");

  let pendingSidebarTouchButton = null;

  function preserveTerminalFocusFromSidebarPress(e) {
    if (!isMobileClient) return;
    const button = e.target.closest("#side-panel .sp-btn");
    if (!button) return;
    if (!keyboardVisible) {
      pendingSidebarTouchButton = null;
      return;
    }
    e.preventDefault();
    pendingSidebarTouchButton = button;
  }

  function triggerSidebarButtonWithoutBlur(e) {
    if (!isMobileClient) return;
    const button = e.target.closest("#side-panel .sp-btn");
    if (!button || button !== pendingSidebarTouchButton) {
      pendingSidebarTouchButton = null;
      return;
    }
    e.preventDefault();
    pendingSidebarTouchButton = null;
    button.click();
  }

  function clearSidebarTouchButton() {
    pendingSidebarTouchButton = null;
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
  sidePanel.addEventListener("touchstart", preserveTerminalFocusFromSidebarPress, { passive: false, capture: true });
  sidePanel.addEventListener("touchend", triggerSidebarButtonWithoutBlur, { passive: false, capture: true });
  sidePanel.addEventListener("touchcancel", clearSidebarTouchButton, { capture: true });
  if (window.matchMedia("(pointer: fine)").matches) toggleSidePanel();
  installResizeObserver();

  let swipeStart = null;
  let twoFingerStart = null;
  let scrollLastY = null;
  let scrollAccum = 0;
  const SWIPE_MIN = 60;

  function getCellHeight() {
    try { return currentTerm()._core._renderService.dimensions.css.cell.height; }
    catch { return 20; }
  }

  document.addEventListener("touchstart", e => {
    if (e.touches.length === 2) {
      scrollLastY = null;
      swipeStart = null;
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      twoFingerStart = { time: Date.now(), dist: Math.hypot(dx, dy), pinched: false };
    } else if (e.touches.length === 1) {
      const touch = e.touches[0];
      swipeStart = { x: touch.clientX, y: touch.clientY };
      scrollLastY = touch.clientY;
      scrollAccum = 0;
    }
  }, { passive: true, capture: true });

  document.addEventListener("touchmove", e => {
    const term = currentTerm();
    const xtermEl = currentXtermEl();
    if (!term || !xtermEl) return;
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
      const y = e.touches[0].clientY;
      const delta = scrollLastY - y;
      scrollAccum += delta;
      const cellHeight = getCellHeight();
      const lines = Math.trunc(scrollAccum / cellHeight);
      if (lines !== 0) {
        term.scrollLines(lines);
        scrollAccum -= lines * cellHeight;
      }
      scrollLastY = y;
    }
  }, { passive: true, capture: true });

  document.addEventListener("touchend", e => {
    scrollLastY = null;
    scrollAccum = 0;
    if (swipeStart && e.touches.length === 0 && e.changedTouches.length === 1) {
      const touch = e.changedTouches[0];
      const dx = swipeStart.x - touch.clientX;
      const dy = swipeStart.y - touch.clientY;
      if (dx > SWIPE_MIN && Math.abs(dy) < dx) toggleSidePanel();
      swipeStart = null;
    }
    if (twoFingerStart && e.touches.length === 0) {
      if (Date.now() - twoFingerStart.time < 500 && !voiceRecorder && !twoFingerStart.pinched) {
        startVoiceRecording("agent");
      }
      twoFingerStart = null;
    }
  }, { passive: true, capture: true });

  helpModal.addEventListener("click", () => helpModal.classList.remove("active"));

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
        tab.transport.write(paths.map(p => p.includes(" ") ? `'${p}'` : p).join(" ")).catch(() => tab.markDisconnected());
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

  spLog.addEventListener("click", () => {
    manager.renderAgentLog();
    agentLogModal.classList.add("active");
  });
  agentLogModal.addEventListener("click", e => {
    if (e.target === agentLogModal) agentLogModal.classList.remove("active");
  });

  let voiceRecorder = null;
  let voiceStream = null;
  let voiceCancelled = false;
  let voiceAbort = null;
  let voiceMode = null;
  let voiceShouldRestoreTerminalFocus = false;

  function cancelVoiceAgent() {
    currentTab()?.transport.cancelAgent().catch(() => {});
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
    voiceShouldRestoreTerminalFocus = false;
    spMic.classList.remove("recording", "processing");
    spDict.classList.remove("recording", "processing");
    spCancel.disabled = true;
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
          : tab.transport.sendVoiceMessage(blob, mime);
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
          if (msg) showToast(msg.length > 80 ? msg.substring(0, 77) + "..." : msg, false, true);
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
      spCancel.disabled = false;
    }).catch(err => {
      voiceReset();
      showToast("Mic: " + err.message);
    });
  }

  spMic.addEventListener("click", () => {
    if (voiceAbort && voiceMode === "agent") {
      cancelVoiceAgent();
      voiceAbort.abort();
      voiceReset();
      showToast("Cancelled");
    } else if (voiceRecorder && voiceRecorder.state === "recording" && voiceMode === "agent") {
      voiceRecorder.stop();
    } else if (!voiceRecorder && !voiceAbort) {
      startVoiceRecording("agent");
    }
  });

  spDict.addEventListener("click", () => {
    if (voiceAbort && voiceMode === "dict") {
      voiceAbort.abort();
      voiceReset();
      showToast("Cancelled");
    } else if (voiceRecorder && voiceRecorder.state === "recording" && voiceMode === "dict") {
      voiceRecorder.stop();
    } else if (!voiceRecorder && !voiceAbort) {
      startVoiceRecording("dict");
    }
  });

  spCancel.addEventListener("click", () => {
    if (voiceRecorder && voiceRecorder.state === "recording") {
      voiceCancelled = true;
      voiceRecorder.stop();
    } else if (voiceAbort) {
      cancelVoiceAgent();
      voiceAbort.abort();
      voiceReset();
      showToast("Cancelled");
    }
  });

  spHelp.addEventListener("click", () => helpModal.classList.add("active"));

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
    tab.transport.sendTextMessage(text).then(data => {
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
      if (msg) showToast(msg.length > 80 ? msg.substring(0, 77) + "..." : msg, false, true);
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
    if (text && tab) tab.transport.write("\x1b[200~" + text + "\x1b[201~").catch(() => tab.markDisconnected());
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
    if (!settings.INWORLD_API_KEY?.present) missing.push("Inworld");
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

  spFs.addEventListener("click", () => {
    if (baseTransport.toggleFullscreen) {
      baseTransport.toggleFullscreen();
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
  document.addEventListener("fullscreenchange", () => spFs.classList.toggle("sp-active", !!document.fullscreenElement));

  spSel.addEventListener("click", () => {
    if (selectOverlay.classList.contains("active")) exitSelectMode();
    else enterSelectMode();
  });

  tabAdd.addEventListener("click", () => {
    manager.createTab({ activate: true }).catch(err => showToast(String(err)));
  });

  const focusTerminalFromTouch = e => {
    if (!isMobileClient) return;
    if (suppressNextTerminalFocus) {
      suppressNextTerminalFocus = false;
      return;
    }
    if (Date.now() < suppressTerminalFocusUntil) return;
    if (hasActiveModal()) return;
    if (e.target.closest("#side-panel, #mobile-input-bar, #help-modal, #voice-log-modal, #text-input-modal, #paste-editor-modal, #settings-modal")) return;
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
      startVoiceRecording("agent");
    }
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "e") {
      e.preventDefault();
      openPasteEditor();
    }
    if (e.key === "Escape" && selectOverlay.classList.contains("active")) {
      e.preventDefault();
      exitSelectMode();
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
        mobileModifiers[modifier] = !mobileModifiers[modifier];
        button.classList.toggle("active", mobileModifiers[modifier]);
        pulseMobileInputButton(button);
        focusCurrent();
        return;
      }
      pulseMobileInputButton(button);
      const sequence = mobileInputSequences[button.dataset.action] || "";
      if (!sequence) return;
      sendMobileInput(sequence);
      if (repeatableActions.has(button.dataset.action)) {
        startMobileInputRepeat(sequence);
      } else {
        stopMobileInputRepeat();
      }
    };
    const handleMobileInputRelease = () => {
      stopMobileInputRepeat();
    };
    mobileInputBar.addEventListener("touchstart", handleMobileInputPress, { passive: false });
    mobileInputBar.addEventListener("touchend", handleMobileInputRelease, { passive: true });
    mobileInputBar.addEventListener("touchcancel", handleMobileInputRelease, { passive: true });
    mobileInputBar.addEventListener("mousedown", handleMobileInputPress);
    mobileInputBar.addEventListener("mouseup", handleMobileInputRelease);
    mobileInputBar.addEventListener("mouseleave", handleMobileInputRelease);
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
    if (typeof e.data !== "string" || !e.data) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    writeSequenceToCurrentTab(encodeMobileInputSequence(e.data));
    const textarea = e.target;
    textarea.value = "";
    focusCurrent();
  }, true);

  document.addEventListener("keydown", e => {
    if (!isMobileClient) return;
    if (!mobileModifiers.Control && !mobileModifiers.Alt) return;
    if (!e.target.classList?.contains("xterm-helper-textarea")) return;

    if (e.key === "Backspace" || e.key === "Enter") {
      e.preventDefault();
      e.stopImmediatePropagation();
      const sequence = e.key === "Backspace" ? "\x7f" : "\r";
      writeSequenceToCurrentTab(encodeMobileInputSequence(sequence));
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
          navigator.sendBeacon(
            "/envoy/api/detach",
            new Blob([JSON.stringify({ session_id: tab.transport.sessionId })], { type: "application/json" }),
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
    if (tab) {
      tab.connect(sid).then(() => tab.fitTerminal()).catch(err => showToast(String(err), true));
    }
  });

  const recoverConnections = () => {
    manager.resumeActiveReads();
    manager.reconnectDisconnectedTabs();
    updateMobileInputBar();
  };

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) recoverConnections();
  });
  window.addEventListener("focus", recoverConnections);
  window.addEventListener("online", recoverConnections);
  window.addEventListener("pageshow", recoverConnections);

  const hashSid = window.location.hash.slice(1);
  manager.createTab({ activate: true, sessionId: hashSid }).then(() => {
    performLayoutRefresh();
  }).catch(err => {
    showToast(String(err), true);
    disconnectOverlay.classList.add("active");
  });
}
