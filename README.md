<p align="center">
  <picture>
    <img src="static/icon.svg" width="128" alt="envoy icon"/>
  </picture>
</p>

<h1 align="center">envoy</h1>

<p align="center">
  A terminal emulator with a built-in voice &amp; text AI agent.<br>
  Runs as a <strong>web app</strong> / PWA.
</p>

![envoy app](static/screenshot.png)

---

## Features

- **Full terminal emulation** &mdash; xterm.js with 256-color support, scrollback, and bracketed paste
- **Multi-tab sessions** &mdash; open, close, and switch between independent terminal tabs
- **Voice agent** &mdash; hold a button and talk; the agent sees your terminal, runs commands, and speaks back
- **Text agent** &mdash; type a message instead; same capabilities, no microphone needed
- **Dictation** &mdash; voice-to-text transcription pasted directly into the terminal
- **Drag-and-drop file upload** &mdash; drop a file onto the terminal and its path is inserted at the cursor
- **Aliases** &mdash; map URL paths to shell commands via `aliases.conf`
- **PWA support** &mdash; installable from the browser with offline caching
- **Dark theme** &mdash; designed for extended terminal use

## Architecture

```
Browser  ──────────────►  Python HTTP server (server.py)
   │                             │
   ▼                             ▼
BrowserTransport             EnvoyService / PtyWorker
                               (runs shell processes and coordinates AI agent)

Python backend
  ├── app_core.py       PTY session management, file uploads
  ├── voice_chat.py     Gemini agent with terminal tools
  ├── speech.py         TTS synthesis with Inworld-first, Google fallback
  ├── agent.py          Gemini tool-calling runtime
  └── env_config.py     API key management
```

The browser frontend (`app.js`) talks to the Python runtime (`app_core.py`) over HTTP via `BrowserTransport`.

## Quickstart

```bash
uv venv .venv
uv pip install --python .venv/bin/python -r requirements-web.txt
python server.py
```

Open `http://localhost:8080/envoy/`

## API Keys

Voice and agent features require API keys. Set them as environment variables, in a `.env` file, or through the in-app settings dialog.

| Key | Required for |
|-----|-------------|
| `GOOGLE_API_KEY` | Voice & text agent (Gemini) |
| `GROQ_API_KEY` | Dictation (Whisper) |
| `INWORLD_API_KEY` | Spoken agent responses (TTS, preferred when set) |

Spoken responses use Inworld TTS when `INWORLD_API_KEY` is set; otherwise they fall back to Google TTS via `GOOGLE_API_KEY`.

The terminal itself works without any keys configured.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+T` | New tab |
| `Ctrl+W` | Close tab |
| `Ctrl+Tab` | Next tab |
| `Ctrl+\` | Toggle toolbar |
| `Ctrl+Shift+Space` | Dictation |
| `Ctrl+Shift+A` | Voice agent |
| `Ctrl+Shift+E` | Text agent / paste editor |
| `Ctrl+Shift+0` / `+` / `-` | Reset / increase / decrease font size |

## License

MIT
