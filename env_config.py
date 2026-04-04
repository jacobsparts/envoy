"""Shared environment configuration helpers for local webterm."""

from __future__ import annotations

import os
from pathlib import Path

try:
    from dotenv import dotenv_values, load_dotenv, set_key, unset_key
except ImportError:
    def dotenv_values(path: Path) -> dict[str, str]:
        values: dict[str, str] = {}
        if not Path(path).exists():
            return values
        with open(path, encoding="utf-8") as handle:
            for raw_line in handle:
                line = raw_line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, value = line.split("=", 1)
                values[key.strip()] = value.strip().strip("\"'")
        return values

    def load_dotenv(path: Path) -> None:
        for key, value in dotenv_values(path).items():
            os.environ.setdefault(key, value)

    def _write_env_value(path: str, key: str, value: str | None) -> None:
        env_path = Path(path)
        lines: list[str] = []
        found = False
        if env_path.exists():
            with open(env_path, encoding="utf-8") as handle:
                for raw_line in handle:
                    stripped = raw_line.strip()
                    if stripped and not stripped.startswith("#") and "=" in raw_line:
                        current_key = raw_line.split("=", 1)[0].strip()
                        if current_key == key:
                            found = True
                            if value is not None:
                                lines.append(f"{key}={value}\n")
                            continue
                    lines.append(raw_line)
        if value is not None and not found:
            lines.append(f"{key}={value}\n")
        with open(env_path, "w", encoding="utf-8") as handle:
            handle.writelines(lines)

    def set_key(path: str, key: str, value: str) -> None:
        _write_env_value(path, key, value)

    def unset_key(path: str, key: str) -> None:
        _write_env_value(path, key, None)


APP_DIR = Path(__file__).resolve().parent
ENV_FILE = APP_DIR / ".env"

CONFIG_KEYS = {
    "GOOGLE_API_KEY": {
        "label": "Google API Key",
        "required_for": ["text_agent", "voice_agent"],
    },
    "GROQ_API_KEY": {
        "label": "Groq API Key",
        "required_for": ["dictation"],
    },
    "INWORLD_API_KEY": {
        "label": "Inworld API Key",
        "required_for": ["speech"],
    },
}


def load_app_env() -> None:
    load_dotenv(ENV_FILE)


def get_env_settings() -> dict[str, dict[str, object]]:
    load_app_env()
    file_values = dotenv_values(ENV_FILE) if ENV_FILE.exists() else {}
    result: dict[str, dict[str, object]] = {}
    for key, meta in CONFIG_KEYS.items():
        raw = os.environ.get(key, file_values.get(key, ""))
        value = "" if raw is None else str(raw)
        result[key] = {
            "label": meta["label"],
            "value": value,
            "present": bool(value),
            "required_for": list(meta["required_for"]),
        }
    return result


def save_env_settings(values: dict[str, str]) -> None:
    ENV_FILE.touch(exist_ok=True)
    for key in CONFIG_KEYS:
        value = (values.get(key) or "").strip()
        if value:
            set_key(str(ENV_FILE), key, value)
            os.environ[key] = value
        else:
            unset_key(str(ENV_FILE), key)
            os.environ.pop(key, None)
