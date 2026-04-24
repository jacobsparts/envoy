"""Minimal local agent runtime for Gemini tool-calling."""

from __future__ import annotations

import base64
import inspect
import logging
import os
from typing import Any

import requests

log = logging.getLogger("agent")


GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


class Agent:
    model = "gemini-2.5-flash"
    system = ""

    def __init__(self) -> None:
        self._contents: list[dict[str, Any]] = []
        self._response_text: str | None = None

    @classmethod
    def tool(cls, func):
        func._agent_tool = True
        return func

    def usermsg(
        self,
        text: str,
        *,
        attachment_text: str | None = None,
        audio: list[bytes] | None = None,
        audio_mime_type: str | None = None,
    ) -> None:
        self._response_text = None
        parts: list[dict[str, Any]] = []
        if attachment_text:
            parts.append({"text": attachment_text})
        if text:
            parts.append({"text": text})
        if audio:
            mime_type = audio_mime_type or "audio/ogg"
            for payload in audio:
                parts.append(
                    {
                        "inlineData": {
                            "mimeType": mime_type,
                            "data": base64.b64encode(payload).decode("ascii"),
                        }
                    }
                )
        self._contents.append({"role": "user", "parts": parts})

    def respond(self, text: str) -> None:
        self._response_text = text

    def run_loop(self, *, max_turns: int = 100) -> str:
        for _ in range(max_turns):
            response = self._generate()
            candidate = (response.get("candidates") or [{}])[0]
            content = candidate.get("content") or {"role": "model", "parts": []}
            parts = content.get("parts") or []
            self._contents.append(content)

            function_calls = [part["functionCall"] for part in parts if "functionCall" in part]
            if function_calls:
                call = function_calls[0]
                result = self._dispatch_tool(call)
                response_parts: list[dict[str, Any]] = [
                    {
                        "functionResponse": {
                            "name": call["name"],
                            "response": {"result": result},
                        }
                    }
                ]
                if len(function_calls) > 1:
                    response_parts.append(
                        {
                            "text": "Only the first tool call in a model turn was executed. Re-evaluate terminal state before issuing another action."
                        }
                    )
                self._contents.append({"role": "user", "parts": response_parts})
                continue

            text = "".join(part.get("text", "") for part in parts).strip()
            if self._response_text is not None:
                return self._response_text
            return text
        raise RuntimeError("Agent exceeded max turns")

    def _generate(self) -> dict[str, Any]:
        api_key = os.environ["GOOGLE_API_KEY"]
        response = requests.post(
            GEMINI_API_URL.format(model=self.model),
            params={"key": api_key},
            headers={"Content-Type": "application/json"},
            json={
                "systemInstruction": {"parts": [{"text": self.system}]},
                "contents": self._contents,
                "tools": [{"functionDeclarations": self._tool_declarations()}],
            },
            timeout=120,
        )
        if not response.ok:
            body = response.text
            log.error("Gemini API %s: %s", response.status_code, body)
            raise RuntimeError(f"Gemini API {response.status_code}: {body}")
        return response.json()

    def _dispatch_tool(self, call: dict[str, Any]) -> Any:
        tool = getattr(self, call["name"])
        args = call.get("args") or {}
        return tool(**args)

    def _tool_declarations(self) -> list[dict[str, Any]]:
        declarations = []
        for name, method in inspect.getmembers(self, predicate=callable):
            if getattr(method, "_agent_tool", False):
                declarations.append(
                    {
                        "name": name,
                        "description": inspect.getdoc(method) or "",
                        "parameters": self._tool_parameters(method),
                    }
                )
        return declarations

    def _tool_parameters(self, method) -> dict[str, Any]:
        signature = inspect.signature(method)
        properties: dict[str, Any] = {}
        required: list[str] = []
        for param in signature.parameters.values():
            if param.name == "self":
                continue
            annotation = param.annotation
            json_type = "string"
            if annotation is float:
                json_type = "number"
            elif annotation is int:
                json_type = "integer"
            elif annotation is bool:
                json_type = "boolean"
            entry: dict[str, Any] = {"type": json_type}
            if isinstance(param.default, str):
                entry["description"] = param.default
            if param.default is inspect._empty:
                required.append(param.name)
            properties[param.name] = entry
        schema: dict[str, Any] = {"type": "object", "properties": properties}
        if required:
            schema["required"] = required
        return schema
