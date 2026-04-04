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

function getWebtermPath() {
  const prefix = "/webterm";
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

  startReading(onData, onDisconnect) {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      if (this.pollInFlight || !this.sessionId) return;
      this.pollInFlight = true;
      try {
        const result = await this.api.read(this.sessionId);
        const chunk = base64ToBytes(result.output);
        if (chunk.length) onData(chunk);
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
  constructor(basePath = "/webterm", targetPath = getWebtermPath()) {
    this.basePath = basePath;
    this.targetPath = targetPath;
    this.pollInFlight = false;
    this.sessionId = "";
    this.clientId = "";
    this.readLoopId = 0;
    this.closed = false;
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
      throw new Error(data.error || `${response.status} ${response.statusText}`);
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

  startReading(onData, onDisconnect) {
    this.stopReading();
    this.closed = false;
    const loopId = ++this.readLoopId;
    const run = async () => {
      while (!this.closed && this.sessionId && this.readLoopId === loopId) {
        if (this.pollInFlight) return;
        this.pollInFlight = true;
        try {
          const result = await this.requestJson("/api/read", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ session_id: this.sessionId, client_id: this.clientId, wait_timeout: 20 }),
          });
          if (this.closed || this.readLoopId !== loopId) return;
          if (result.evicted) {
            onDisconnect({ kind: "evicted" });
            return;
          }
          const chunk = base64ToBytes(result.output);
          if (chunk.length) onData(chunk);
          if (!result.alive) {
            onDisconnect({ kind: "exit", exitCode: result.exit_code });
            return;
          }
        } catch (err) {
          if (this.closed || this.readLoopId !== loopId) return;
          onDisconnect({ kind: "error", error: err });
          return;
        } finally {
          this.pollInFlight = false;
        }
      }
    };
    run();
  }

  stopReading() {
    this.closed = true;
    this.readLoopId += 1;
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
    this.closed = false;
    this.agentLog = [];

    this.pane = document.createElement("div");
    this.pane.className = "terminal-pane";
    this.host = document.createElement("div");
    this.host.className = "terminal-host";
    this.pane.appendChild(this.host);

    this.term = new Terminal({
      cursorBlink: true,
      fontSize: parseInt(localStorage.getItem("webterm-font-size")) || 17,
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
    this.button.classList.remove("exited");
    this.updateScrollbackClass();
    this.transport.startReading(
      data => this.term.write(data),
      info => this.handleDisconnect(info),
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
    this.fit.fit();
    this.updateScrollbackClass();
    if (!this.disconnected) {
      this.transport.resize(this.term.cols, this.term.rows).catch(() => this.markDisconnected());
    }
  }

  focus() {
    const textarea = this.host.querySelector(".xterm-helper-textarea");
    if (textarea) textarea.focus();
  }

  markDisconnected() {
    if (this.disconnected) return;
    this.disconnected = true;
    this.button.classList.add("exited");
    if (this.manager.activeTab === this) {
      this.manager.updateDisconnectOverlay();
    }
  }

  handleDisconnect(info) {
    if (this.closed) return;
    if (info?.kind === "evicted") {
      this.markDisconnected();
      return;
    }
    if (info?.kind === "exit" && info.exitCode === 0) {
      this.manager.closeTab(this.id).catch(err => console.error(err));
      return;
    }
    this.markDisconnected();
  }

  updateTitle(title) {
    this.title = title;
    this.button.querySelector(".tab-title").textContent = title;
  }

  addAgentLog(response, commands, userMessage) {
    const time = new Date().toLocaleTimeString();
    this.agentLog.push({ time, response, commands, userMessage });
  }

  updateScrollbackClass() {
    const buffer = this.term?.buffer?.active;
    const hasScrollback = !!buffer && buffer.baseY > 0;
    this.host.classList.toggle("has-scrollback", hasScrollback);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
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
    if (!entries.length) {
      this.elements.agentLog.innerHTML = '<p class="voice-log-empty">No entries yet.</p>';
      return;
    }
    this.elements.agentLog.innerHTML = entries.map(entry => {
      let html = '<div class="voice-log-entry">';
      html += `<div class="voice-log-time">${entry.time}</div>`;
      if (entry.userMessage) html += `<div class="voice-log-you">${entry.userMessage}</div>`;
      if (entry.commands && entry.commands.length) {
        html += entry.commands.map(command => `<div class="voice-log-cmd">$ ${command}</div>`).join("");
      }
      if (entry.response) html += `<div class="voice-log-agent">${entry.response}</div>`;
      return html + "</div>";
    }).join("");
    this.elements.agentLog.scrollTop = this.elements.agentLog.scrollHeight;
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
  document.title = config.title || "webterm";

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

  let toastTimer = null;
  let toastLocked = false;

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

  function focusCurrent() {
    currentTab()?.focus();
  }

  function sendResize() {
    if (manager.activeTab) manager.activeTab.fitTerminal();
  }

  function adjustFontSize(delta) {
    const term = currentTerm();
    if (!term) return;
    const next = Math.max(8, Math.min(40, term.options.fontSize + delta));
    if (next === term.options.fontSize) return;
    term.options.fontSize = next;
    localStorage.setItem("webterm-font-size", next);
    sendResize();
    showToast(`Font size ${next}`);
  }

  function resetFontSize() {
    const term = currentTerm();
    if (!term) return;
    if (term.options.fontSize === 17) return;
    term.options.fontSize = 17;
    localStorage.setItem("webterm-font-size", "17");
    sendResize();
    showToast("Font size 17");
  }

  function updateViewportHeight() {
    const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    workspace.style.height = `${h}px`;
  }

  updateViewportHeight();

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", () => {
      updateViewportHeight();
      sendResize();
    });
    window.visualViewport.addEventListener("scroll", () => {
      updateViewportHeight();
      window.scrollTo(0, 0);
    });
  }

  window.onresize = () => {
    updateViewportHeight();
    sendResize();
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

  function syncPanelWidth() {
    workspace.classList.toggle("with-panel", sidePanel.classList.contains("active"));
    sendResize();
    setTimeout(sendResize, 220);
  }

  function toggleSidePanel() {
    sidePanel.classList.toggle("active");
    syncPanelWidth();
  }

  sidePanel.addEventListener("transitionend", syncPanelWidth);
  if (window.matchMedia("(pointer: fine)").matches) toggleSidePanel();

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
          localStorage.setItem("webterm-font-size", newSize);
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
    const screen = tab.host.querySelector(".xterm-screen");
    if (screen) selectOverlay.style.height = screen.style.height;
    selectOverlay.classList.add("active");
    const xtermEl = currentXtermEl();
    if (xtermEl) xtermEl.classList.add("select-mode");
    selectOverlay.scrollTop = selectOverlay.scrollHeight;
    spSel.classList.add("sp-active");
  }

  function exitSelectMode() {
    selectOverlay.classList.remove("active");
    selectOverlay.innerHTML = "";
    const xtermEl = currentXtermEl();
    if (xtermEl) xtermEl.classList.remove("select-mode");
    spSel.classList.remove("sp-active");
    currentTerm()?.scrollToBottom();
    focusCurrent();
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

  function cancelVoiceAgent() {
    currentTab()?.transport.cancelAgent().catch(() => {});
  }

  function voiceReset() {
    if (voiceStream) {
      voiceStream.getTracks().forEach(track => track.stop());
      voiceStream = null;
    }
    voiceRecorder = null;
    voiceCancelled = false;
    voiceAbort = null;
    voiceMode = null;
    spMic.classList.remove("recording", "processing");
    spDict.classList.remove("recording", "processing");
    spCancel.disabled = true;
    focusCurrent();
  }

  function startVoiceRecording(mode) {
    const tab = currentTab();
    if (!tab || voiceRecorder) return;
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
            if (data.text) tab.transport.write(data.text).catch(() => tab.markDisconnected());
            return;
          }
          tab.addAgentLog(data.response, data.commands);
          manager.renderAgentLog();
          if (data.audio) new Audio("data:audio/wav;base64," + data.audio).play().catch(() => {});
          if (data.speech) showToast(data.speech.length > 80 ? data.speech.substring(0, 77) + "..." : data.speech, false, true);
        }).catch(err => {
          if (controller.signal.aborted) {
            voiceReset();
            return;
          }
          voiceReset();
          showToast(mode === "dict" ? "Dictation failed" : "Voice failed");
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

  const textInputModal = document.getElementById("text-input-modal");
  const textInputArea = document.getElementById("text-input-area");
  const textInputSend = document.getElementById("text-input-send");
  const textInputClose = document.getElementById("text-input-close");
  let textAbort = null;

  function openTextInput() {
    textInputModal.classList.add("active");
    textInputArea.value = "";
    setTimeout(() => textInputArea.focus(), 50);
  }

  function closeTextInput() {
    textInputModal.classList.remove("active");
    focusCurrent();
  }

  function sendTextMessage() {
    const tab = currentTab();
    const text = textInputArea.value.trim();
    if (!tab || !text) return;
    closeTextInput();
    spText.classList.add("processing");
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
      if (data.speech) showToast(data.speech.length > 80 ? data.speech.substring(0, 77) + "..." : data.speech, false, true);
    }).catch(err => {
      spText.classList.remove("processing");
      textAbort = null;
      if (controller.signal.aborted) return;
      showToast("Text agent failed");
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

  const pasteEditorModal = document.getElementById("paste-editor-modal");
  const pasteEditorArea = document.getElementById("paste-editor-area");
  const pasteEditorCancel = document.getElementById("paste-editor-cancel");
  let pasteEditorOpen = false;

  function openPasteEditor() {
    pasteEditorOpen = true;
    pasteEditorModal.classList.add("active");
    spPaste.classList.add("sp-active");
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
  }

  function closePasteEditorCancel() {
    pasteEditorOpen = false;
    pasteEditorModal.classList.remove("active");
    spPaste.classList.remove("sp-active");
    focusCurrent();
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

  const settingsModal = document.getElementById("settings-modal");
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
  }

  async function openSettings() {
    settingsModal.classList.add("active");
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

  document.addEventListener("keydown", e => {
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

  window.addEventListener("beforeunload", () => {
    if (!(window.pywebview && window.pywebview.api)) {
      for (const tab of manager.tabs) {
        if (tab.transport?.sessionId) {
          navigator.sendBeacon(
            "/webterm/api/detach",
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

  const hashSid = window.location.hash.slice(1);
  manager.createTab({ activate: true, sessionId: hashSid }).then(() => sendResize()).catch(err => {
    showToast(String(err), true);
    disconnectOverlay.classList.add("active");
  });
}
