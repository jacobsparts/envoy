"""Voice chat LLM integration using the local Gemini agent runtime.

Handles LLM-based voice conversations. Communicates with the terminal
and user through a *terminal* interface object that must provide:

  - get_terminal_context() -> str
  - get_terminal_state() -> dict
  - execute_action(type: str, input: str = "", wait_for_settle=None, expect_prompt: str = "", timeout=None) -> dict
  - send_message(text: str)   # text is spoken to the user as audio
"""

import os
import time
import logging
import subprocess
import tempfile
import threading
import requests
from agent import Agent
from env_config import load_app_env
from terminal_session import reset_context_lookback

logging.basicConfig(level=logging.INFO, format="%(name)s: %(message)s")
log = logging.getLogger("voice_chat")

load_app_env()

GEMINI_AUDIO_TYPES = {"audio/wav", "audio/mp3", "audio/aiff", "audio/aac",
                      "audio/ogg", "audio/flac"}


def convert_audio_to_ogg(audio_data, mime_type):
    """Convert audio to OGG/Opus via ffmpeg if not a Gemini-supported format."""
    if mime_type in GEMINI_AUDIO_TYPES:
        return audio_data, mime_type
    ext = mime_type.split("/")[-1].split(";")[0]
    with tempfile.NamedTemporaryFile(suffix=f".{ext}", delete=False) as inp:
        inp.write(audio_data)
        inp_path = inp.name
    out_path = inp_path + ".ogg"
    try:
        subprocess.run(["ffmpeg", "-y", "-i", inp_path, "-c:a", "libopus",
                        "-b:a", "32k", out_path],
                       capture_output=True, check=True)
        with open(out_path, "rb") as f:
            return f.read(), "audio/ogg"
    finally:
        os.unlink(inp_path)
        if os.path.exists(out_path):
            os.unlink(out_path)


GROQ_STT_URL = "https://api.groq.com/openai/v1/audio/transcriptions"

VOICE_SYSTEM_PROMPT = """\
You are a voice assistant helping a user with their terminal session.

The user's input is audio. Listen carefully and if you can't understand \
what was said, ask for clarification rather than guessing.

The terminal session is persistent across turns. Programs you start \
(python, vim, etc.) remain running between exchanges. Check the \
terminal_output attachment and tool results before taking another action.

Do not assume the terminal is a bash shell. The session may currently be \
at a shell prompt, in a Python REPL, inside a debugger, inside a custom CLI \
app, or in another interactive program. Treat the current mode as unknown \
until the terminal state or visible output gives clear evidence.

You must control the terminal through one structured action at a time \
using the execute_action tool. Set the type parameter to input or wait.

Use input actions to send terminal input in any mode: shell, Python REPL, \
debugger, pager, menu, or other interactive program. The input field is a \
string containing ordinary text plus backslash escapes decoded before being \
written to the terminal. Include \\r to press Enter. Use \\x03 for Ctrl-C, \
\\x04 for Ctrl-D, \\x15 for Ctrl-U, \\x7f for Backspace, \\t for Tab, and \
\\x1b[A / \\x1b[B / \\x1b[C / \\x1b[D for arrow keys.

Example bash command:
execute_action(type="input", input="ls -la\\r", expect_prompt="$", timeout=30)

Avoid fragile quoting. Prefer simple, inspectable steps over deeply nested \
one-liners. When writing literal multi-line text or scripts through a shell, \
use quoted heredoc delimiters such as <<'EOF' so variables and backslashes are \
not expanded by the wrong layer.

wait_for_settle is optional and defaults to 0.75 seconds for input actions. \
Set wait_for_settle to a number of seconds to override how long terminal \
output must be quiet before the action returns, or false to return without \
waiting for output to settle.

expect_prompt is optional. Only include it when you specifically need to \
wait for a known prompt after pressing Enter. Do not include expect_prompt \
for ordinary typing, for input inside an editor or REPL whose prompt is not \
certain, or when sending text without Enter. Use "$" or "#" for typical bash \
prompts, ">>>" for a Python prompt, "(Pdb)" for pdb, or omit it when no \
prompt is expected.

Use wait actions when you only want to wait for output settling or for a \
prompt to appear.

Always call get_terminal_state before deciding what input to send if the \
mode is not already obvious from the latest tool result.

Never claim a command succeeded unless you can verify it from the \
terminal output. If you cannot see the result, say so.

Keep responses brief and conversational -- they will be spoken aloud. \
Do not use markdown formatting.

Your final text response will be spoken aloud to the user.
"""


class CancelledError(Exception):
    pass


def require_voice_agent_env():
    if not os.environ.get("GOOGLE_API_KEY"):
        raise RuntimeError("GOOGLE_API_KEY is required for voice/text agent features")


def require_stt_env():
    if not os.environ.get("INWORLD_API_KEY") and not os.environ.get("GROQ_API_KEY"):
        raise RuntimeError("INWORLD_API_KEY (or GROQ_API_KEY) is required for dictation")


def format_terminal_attachment(terminal_context: str) -> str:
    return f"[Attachment: terminal_output]\n{terminal_context or '(no new output)'}"


class VoiceChatAgent(Agent):
    model = "gemini-3.7-flash"
    system = VOICE_SYSTEM_PROMPT

    def _check_cancelled(self):
        if self._cancel.is_set():
            raise CancelledError()

    def run(self, audio_data, mime_type, terminal_context, cancel, max_turns=100):
        self._cancel = cancel
        self.usermsg(
            "(audio input)",
            attachment_text=format_terminal_attachment(terminal_context),
            audio=[audio_data],
            audio_mime_type=mime_type,
        )
        return self.run_loop(max_turns=max_turns)

    def run_text(self, text, terminal_context, cancel, max_turns=100):
        self._cancel = cancel
        self.usermsg(text, attachment_text=format_terminal_attachment(terminal_context))
        return self.run_loop(max_turns=max_turns)

    @Agent.tool
    def get_terminal_state(self):
        """Return the current structured terminal state."""
        self._check_cancelled()
        return self._terminal.get_terminal_state()

    @Agent.tool
    def execute_action(self,
                       type: str,
                       input: str = "",
                       wait_for_settle: float = None,
                       expect_prompt: str = "",
                       timeout: float = None):
        """Execute one terminal action and return a structured result.

        type: "input" or "wait".
        input: Text to send for input actions. Use \r for Enter, \x03 for Ctrl-C, \x04 for Ctrl-D, \x15 for Ctrl-U, \x7f for Backspace, \t for Tab, and \x1b[A/B/C/D for arrow keys.
        wait_for_settle: Optional seconds terminal output must be quiet before returning. Omit for default 0.75 seconds.
        expect_prompt: Optional prompt text to wait for only when you specifically need a known prompt after pressing Enter. Omit for ordinary typing or uncertain interactive states.
        timeout: Optional maximum seconds to wait.
        """
        self._check_cancelled()
        return self._terminal.execute_action(type, input, wait_for_settle, expect_prompt, timeout)



def transcribe_audio(audio_data, mime_type):
    """Transcribe audio bytes to text via Inworld STT (falling back to Groq if key is present)."""
    require_stt_env()
    inworld_key = os.environ.get("INWORLD_API_KEY")
    if inworld_key:
        return transcribe_audio_inworld(audio_data, mime_type)
    groq_api_key = os.environ["GROQ_API_KEY"]
    ext = {"audio/webm": "webm", "audio/mp4": "mp4",
           "audio/ogg": "ogg", "audio/wav": "wav"}.get(mime_type, "webm")
    resp = requests.post(
        GROQ_STT_URL,
        headers={"Authorization": f"Bearer {groq_api_key}"},
        files={"file": (f"audio.{ext}", audio_data, mime_type)},
        data={"model": "whisper-large-v3-turbo"},
    )
    resp.raise_for_status()
    return resp.json()["text"]

INWORLD_STT_URL = "wss://api.inworld.ai/stt/v1/transcribe:streamBidirectional"

def transcribe_audio_inworld(audio_data, mime_type):
    """Transcribe recorded audio file to text using Inworld STT streaming endpoint."""
    import asyncio
    import base64
    import json
    import websockets

    # Convert audio_data to 16kHz 16-bit mono PCM via ffmpeg
    with tempfile.NamedTemporaryFile(suffix=".audio", delete=False) as inp:
        inp.write(audio_data)
        inp_path = inp.name
    try:
        proc = subprocess.run(
            ["ffmpeg", "-y", "-i", inp_path, "-f", "s16le", "-ac", "1", "-ar", "16000", "-"],
            capture_output=True, check=True
        )
        pcm_data = proc.stdout
    finally:
        if os.path.exists(inp_path):
            os.unlink(inp_path)

    key = os.environ["INWORLD_API_KEY"]
    auth = key if key.startswith("Basic ") else f"Basic {key}"

    async def _stream():
        final_transcripts = []
        async with websockets.connect(INWORLD_STT_URL, additional_headers={"Authorization": auth}) as ws:
            config = {
                "transcribeConfig": {
                    "modelId": "inworld/inworld-stt-1",
                    "audioEncoding": "LINEAR16",
                    "sampleRateHertz": 16000,
                    "language": "en",
                }
            }
            await ws.send(json.dumps(config))
            chunk_size = 3200  # 100ms chunks
            for i in range(0, len(pcm_data), chunk_size):
                chunk = pcm_data[i:i + chunk_size]
                b64 = base64.b64encode(chunk).decode("ascii")
                await ws.send(json.dumps({"audioChunk": {"content": b64}}))
                await asyncio.sleep(0.001)
            await ws.send(json.dumps({"closeStream": {}}))

            try:
                while True:
                    msg = await asyncio.wait_for(ws.recv(), timeout=3.0)
                    try:
                        data = json.loads(msg)
                    except Exception:
                        continue
                    result = data.get("result", {})
                    transcription = result.get("transcription", {})
                    if transcription.get("isFinal"):
                        text = transcription.get("transcript", "")
                        if text:
                            final_transcripts.append(text)
            except (asyncio.TimeoutError, websockets.exceptions.ConnectionClosed):
                pass
        return " ".join(final_transcripts).strip()

    return asyncio.run(_stream())

def stream_transcribe_inworld(client_conn, key):
    """Stream bidirectional audio/text transcription between client WebSocket and Inworld STT."""
    import asyncio
    import base64
    import json
    import websockets

    auth = key if key.startswith("Basic ") else f"Basic {key}"

    async def bridge():
        async with websockets.connect(INWORLD_STT_URL, additional_headers={"Authorization": auth}) as inworld_ws:
            config = {
                "transcribeConfig": {
                    "modelId": "inworld/inworld-stt-1",
                    "audioEncoding": "LINEAR16",
                    "sampleRateHertz": 16000,
                    "language": "en",
                }
            }
            await inworld_ws.send(json.dumps(config))

            loop = asyncio.get_running_loop()
            inworld_done = asyncio.Event()

            async def read_inworld():
                try:
                    async for message in inworld_ws:
                        try:
                            data = json.loads(message)
                        except Exception:
                            continue
                        result = data.get("result", {})
                        transcription = result.get("transcription", {})
                        if transcription.get("isFinal"):
                            text = transcription.get("transcript", "")
                            if text:
                                out_msg = json.dumps({"text": text, "is_final": True})
                                await loop.run_in_executor(None, client_conn.send, out_msg)
                except Exception:
                    pass
                finally:
                    inworld_done.set()

            inworld_task = asyncio.create_task(read_inworld())

            def read_client_blocking():
                try:
                    for msg in client_conn:
                        if isinstance(msg, bytes):
                            b64 = base64.b64encode(msg).decode("ascii")
                            asyncio.run_coroutine_threadsafe(
                                inworld_ws.send(json.dumps({"audioChunk": {"content": b64}})),
                                loop
                            ).result()
                        elif isinstance(msg, str):
                            try:
                                d = json.loads(msg)
                                action = d.get("action")
                                if action == "stop":
                                    # Graceful stop: tell Inworld stream is closed, wait for remaining results
                                    asyncio.run_coroutine_threadsafe(
                                        inworld_ws.send(json.dumps({"closeStream": {}})),
                                        loop
                                    ).result(timeout=2.0)
                                    break
                                elif action == "close":
                                    # Immediate abort
                                    break
                            except Exception:
                                pass
                except Exception:
                    pass
                finally:
                    try:
                        asyncio.run_coroutine_threadsafe(
                            inworld_ws.send(json.dumps({"closeStream": {}})),
                            loop
                        ).result(timeout=2.0)
                    except Exception:
                        pass

            await loop.run_in_executor(None, read_client_blocking)
            try:
                await asyncio.wait_for(inworld_done.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                pass
            try:
                client_conn.send(json.dumps({"done": True}))
            except Exception:
                pass
            inworld_task.cancel()

    try:
        asyncio.run(bridge())
    except Exception as exc:
        log.warning("stream_transcribe_inworld bridge error: %s", exc)


def _prepare_agent(session, agent_settings):
    """Return (agent, is_new) based on persistence setting."""
    persistence = agent_settings.get("agent_persistence", "persistent")
    lookback = int(agent_settings.get("agent_lookback", 100))
    is_new = persistence == "per_invocation" or not hasattr(session, "voice_agent")
    if is_new:
        agent = VoiceChatAgent()
        reset_context_lookback(session, lookback)
        session.voice_agent = agent
    return session.voice_agent, is_new


def process_voice_message(audio_data, mime_type, terminal, cancel,
                          agent_settings=None):
    """Process voice audio through the LLM (audio sent directly to model).

    Returns reply text.
    Side-effects: may call terminal.get_terminal_state(),
    terminal.execute_action(), and terminal.send_message().
    cancel: threading.Event — set to abort the agent between tool calls.
    """
    require_voice_agent_env()
    if agent_settings is None:
        agent_settings = {}
    session = terminal._session
    agent, _ = _prepare_agent(session, agent_settings)
    agent._terminal = terminal
    turn_limit = int(agent_settings.get("agent_turn_limit", 100))

    context = terminal.get_terminal_context().strip()
    audio_data, mime_type = convert_audio_to_ogg(audio_data, mime_type)
    log.info("audio_len=%d mime=%s context_len=%d", len(audio_data), mime_type, len(context))
    t0 = time.time()
    reply = agent.run(audio_data, mime_type, context, cancel, max_turns=turn_limit)
    log.info("reply=%r elapsed=%.1fs", reply, time.time() - t0)
    return reply


def process_text_message(text, terminal, cancel, agent_settings=None):
    """Process a text message through the LLM agent.

    Returns reply text.
    Side-effects: may call terminal.get_terminal_state(),
    terminal.execute_action(), and terminal.send_message().
    cancel: threading.Event — set to abort the agent between tool calls.
    """
    require_voice_agent_env()
    if agent_settings is None:
        agent_settings = {}
    session = terminal._session
    agent, _ = _prepare_agent(session, agent_settings)
    agent._terminal = terminal
    turn_limit = int(agent_settings.get("agent_turn_limit", 100))

    context = terminal.get_terminal_context().strip()
    log.info("text=%r context_len=%d", text, len(context))
    t0 = time.time()
    reply = agent.run_text(text, context, cancel, max_turns=turn_limit)
    log.info("reply=%r elapsed=%.1fs", reply, time.time() - t0)
    return reply
