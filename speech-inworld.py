"""Speech synthesis helpers."""

from __future__ import annotations

import base64
import io
import json
import os
import re
import wave

import requests

from env_config import load_app_env


load_app_env()

INWORLD_TTS_URL = "https://api.inworld.ai/tts/v1/voice:stream"
TTS_SAMPLE_RATE = 48000


def strip_markdown(text: str) -> str:
    text = re.sub(r"```[\s\S]*?```", "", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.M)
    text = re.sub(r"(\*\*|__)(.*?)\1", r"\2", text)
    text = re.sub(r"(\*|_)(.*?)\1", r"\2", text)
    text = re.sub(r"~~(.*?)~~", r"\1", text)
    text = re.sub(r"^>\s?", "", text, flags=re.M)
    text = re.sub(r"^[-*+]\s+", "", text, flags=re.M)
    text = re.sub(r"^\d+\.\s+", "", text, flags=re.M)
    return text.strip()


def chunk_text(text: str, limit: int = 200) -> list[str]:
    chunks = []
    while len(text) > limit:
        cut = -1
        for end in ". ! ? .\n !\n ?\n".split():
            i = text.rfind(end, 0, limit)
            if i > cut:
                cut = i + len(end)
        if cut <= 0:
            cut = text.rfind(" ", 0, limit)
            if cut <= 0:
                cut = limit
        chunks.append(text[:cut].strip())
        text = text[cut:].strip()
    if text:
        chunks.append(text)
    return chunks


def synthesize_speech(text: str, voice: str = "Ashley") -> str | None:
    inworld_api_key = os.environ.get("INWORLD_API_KEY", "").strip()
    text = strip_markdown(text)
    if not text or not inworld_api_key:
        return None

    pcm_data = bytearray()
    for chunk in chunk_text(text):
        resp = requests.post(
            INWORLD_TTS_URL,
            headers={
                "Authorization": f"Basic {inworld_api_key}",
                "Content-Type": "application/json",
            },
            json={
                "text": chunk,
                "voice_id": voice,
                "model_id": "inworld-tts-1.5-mini",
                "audio_config": {
                    "audio_encoding": "LINEAR16",
                    "sample_rate_hertz": TTS_SAMPLE_RATE,
                    "speaking_rate": 1.2,
                },
            },
            stream=True,
        )
        if not resp.ok:
            continue
        for line in resp.iter_lines(decode_unicode=True):
            if not line or not line.strip():
                continue
            try:
                result = json.loads(line).get("result", {})
                if "audioContent" in result:
                    audio_bytes = base64.b64decode(result["audioContent"])
                    if len(audio_bytes) > 44 and audio_bytes[:4] == b"RIFF":
                        audio_bytes = audio_bytes[44:]
                    pcm_data.extend(audio_bytes)
            except (json.JSONDecodeError, KeyError):
                continue

    if not pcm_data:
        return None

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(TTS_SAMPLE_RATE)
        wf.writeframes(bytes(pcm_data))
    return base64.b64encode(buf.getvalue()).decode()
