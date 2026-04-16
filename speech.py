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

GEMINI_TTS_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-tts-preview:generateContent"
INWORLD_TTS_URL = "https://api.inworld.ai/tts/v1/voice:stream"
GOOGLE_TTS_SAMPLE_RATE = 24000
INWORLD_TTS_SAMPLE_RATE = 48000
DEFAULT_TTS_VOICE = "Sulafat"
DEFAULT_INWORLD_VOICE = "Ashley"
DEFAULT_TTS_DIRECTOR_NOTES = (
    "Style: Deadpan. Dry, restrained, matter-of-fact delivery. "
    "Avoid upbeat or overly expressive reads.\n"
    "Pacing: Rapid-fire. Fast, efficient delivery with minimal pauses, "
    "but still clear and intelligible.\n"
    "Accent: General American."
)


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


def chunk_text(text: str, limit: int = 800) -> list[str]:
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


def build_tts_prompt(transcript: str, director_notes: str = DEFAULT_TTS_DIRECTOR_NOTES) -> str:
    return (
        "Generate speech audio for the transcript below. "
        "Follow the director notes, but speak only the transcript content.\n\n"
        "### DIRECTOR'S NOTES\n"
        f"{director_notes.strip()}\n\n"
        "### TRANSCRIPT\n"
        f"{transcript.strip()}"
    )


def _pcm_to_wav_base64(pcm_data: bytes, sample_rate: int) -> str | None:
    if not pcm_data:
        return None
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sample_rate)
        wf.writeframes(pcm_data)
    return base64.b64encode(buf.getvalue()).decode()


def _synthesize_google_speech(text: str, voice: str = DEFAULT_TTS_VOICE) -> str | None:
    google_api_key = os.environ.get("GOOGLE_API_KEY", "").strip()
    if not text or not google_api_key:
        return None

    pcm_data = bytearray()
    for chunk in chunk_text(text):
        prompt = build_tts_prompt(chunk)
        resp = requests.post(
            GEMINI_TTS_URL,
            headers={
                "Content-Type": "application/json",
                "x-goog-api-key": google_api_key,
            },
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {
                    "responseModalities": ["AUDIO"],
                    "speechConfig": {
                        "voiceConfig": {
                            "prebuiltVoiceConfig": {
                                "voiceName": voice,
                            }
                        }
                    },
                },
                "model": "gemini-3.1-flash-tts-preview",
            },
            timeout=120,
        )
        if not resp.ok:
            continue
        try:
            data = resp.json()
            audio_b64 = data["candidates"][0]["content"]["parts"][0]["inlineData"]["data"]
            pcm_data.extend(base64.b64decode(audio_b64))
        except (ValueError, KeyError, IndexError, TypeError):
            continue

    return _pcm_to_wav_base64(bytes(pcm_data), GOOGLE_TTS_SAMPLE_RATE)


def _synthesize_inworld_speech(text: str, voice: str = DEFAULT_INWORLD_VOICE) -> str | None:
    inworld_api_key = os.environ.get("INWORLD_API_KEY", "").strip()
    if not text or not inworld_api_key:
        return None

    pcm_data = bytearray()
    for chunk in chunk_text(text, limit=200):
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
                    "sample_rate_hertz": INWORLD_TTS_SAMPLE_RATE,
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

    return _pcm_to_wav_base64(bytes(pcm_data), INWORLD_TTS_SAMPLE_RATE)


def synthesize_speech(text: str, voice: str = DEFAULT_TTS_VOICE) -> str | None:
    text = strip_markdown(text)
    if not text:
        return None
    if os.environ.get("INWORLD_API_KEY", "").strip():
        return _synthesize_inworld_speech(text)
    return _synthesize_google_speech(text, voice=voice)
