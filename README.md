# envoy

This repo can run in two first-class modes:

- web server mode under `/envoy/`
- local desktop mode backed by `pywebview`

The terminal/session runtime is shared between both modes. `pywebview` is no longer required for the server install.

## Run

Create a local environment and install dependencies:

```bash
uv venv .venv
uv pip install --python .venv/bin/python -r requirements-web.txt
```

For desktop mode, install the desktop runtime instead:

```bash
uv pip install --python .venv/bin/python -r requirements-desktop.txt
```

Set the local API keys:

```bash
export GOOGLE_API_KEY=your_key_here
export GROQ_API_KEY=your_key_here
export INWORLD_API_KEY=your_key_here
```

Or put it in a local `.env` file:

```bash
GOOGLE_API_KEY=your_key_here
GROQ_API_KEY=your_key_here
INWORLD_API_KEY=your_key_here
```

Start the web app:

```bash
python server.py
```

Then open:

```text
http://localhost:8080/envoy/
```

Start the desktop app:

```bash
./envoy-desktop
```

Optional launch target:

```bash
./envoy-desktop /path-or-alias
```

`/` opens an interactive shell. Any non-root path is resolved through `aliases.conf` first, then as a file under `$HOME`.

## Notes

- The browser app is served from `/envoy/`, and all web routes are prefixed with `/envoy/`.
- The desktop host keeps the xterm.js frontend and uses a `pywebview` bridge.
- The web host serves the same frontend and talks to the shared runtime over HTTP.
- Drag-and-drop uploads still write into `.envoy_uploads` and paste the resulting path into the terminal.
- Voice/text agent calls require `GOOGLE_API_KEY`.
- Dictation requires `GROQ_API_KEY`.
- Spoken agent audio requires `INWORLD_API_KEY`.
- The desktop app exposes an API settings dialog and stores those values in a local `.env`.
