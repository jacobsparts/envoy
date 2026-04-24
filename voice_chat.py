"""Voice chat LLM integration using the local Gemini agent runtime.

Handles LLM-based voice conversations. Communicates with the terminal
and user through a *terminal* interface object that must provide:

  - get_terminal_context() -> str
  - get_terminal_state() -> dict
  - execute_action(action_json: str) -> dict
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

Never claim a command succeeded unless you can verify it from the \
terminal output. If you cannot see the result, say so.

Keep responses brief and conversational -- they will be spoken aloud. \
Do not use markdown formatting.

You must control the terminal through one structured action at a time \
using the execute_action tool. The action JSON must contain exactly one \
object with a type of command, wait, or keypress.

Always call get_terminal_state before deciding whether to send input if the \
mode is not already obvious from the latest tool result.

Use command actions only when the terminal state indicates an actual shell \
prompt, not merely any prompt-looking line.
Use wait actions to wait for prompt return or output settling.
Use keypress actions for interactive programs, REPLs, debuggers, menus, \
pagers, or interrupts like CTRL-C.

Prefer wait_for_settle=true and expect_prompt=true for ordinary shell commands.
Set expect_prompt=false when intentionally entering an interactive program.

If the terminal state says input_mode is not shell, do not send shell \
commands. Either use keypress, wait, or explain that the session is not \
currently at a shell prompt.

Your final text response will be spoken aloud to the user."""


class CancelledError(Exception):
    pass


def require_voice_agent_env():
    if not os.environ.get("GOOGLE_API_KEY"):
        raise RuntimeError("GOOGLE_API_KEY is required for voice/text agent features")


def require_stt_env():
    if not os.environ.get("GROQ_API_KEY"):
        raise RuntimeError("GROQ_API_KEY is required for dictation")


def format_terminal_attachment(terminal_context: str) -> str:
    return f"[Attachment: terminal_output]\n{terminal_context or '(no new output)'}"


class VoiceChatAgent(Agent):
    model = "gemini-3-flash-preview"
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
    def execute_action(self, action_json: str = "JSON object with exactly one action: command, wait, or keypress"):
        """Execute one structured terminal action and return a structured result."""
        self._check_cancelled()
        return self._terminal.execute_action(action_json)



def transcribe_audio(audio_data, mime_type):
    """Transcribe audio bytes to text via Groq Whisper."""
    require_stt_env()
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


def _prepare_agent(session, agent_settings):
    """Return (agent, is_new) based on persistence setting."""
    persistence = agent_settings.get("agent_persistence", "persistent")
    lookback = int(agent_settings.get("agent_lookback", 100))
    is_new = False
    if persistence == "per_invocation" or not hasattr(session, "voice_agent"):
        session.voice_agent = VoiceChatAgent()
        is_new = True
    if is_new:
        session.reset_context_lookback(lookback)
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
