"""AI providers behind one small interface.

A provider runs ONE model turn: given system prompt, history and tool specs it streams text (via on_text) and returns
the assistant content to append to the history plus any tool calls. The tool loop, permission checks and audit live
in service.py, so a provider can never run a tool by itself.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol

from ..config import get_settings

OnText = Callable[[str], Awaitable[None]]


@dataclass
class ToolCall:
    id: str
    name: str
    input: Any


@dataclass
class Turn:
    assistant_content: Any  # appended verbatim to the history for the next round
    text: str
    tool_calls: list[ToolCall] = field(default_factory=list)
    stop_reason: str = "end_turn"


class ProviderError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class Provider(Protocol):
    name: str

    async def turn(self, system: str, messages: list[dict], tools: list[dict], on_text: OnText) -> Turn: ...


class AnthropicProvider:
    """Anthropic Messages API (official SDK), streamed. Model and effort come from the environment."""

    name = "anthropic"

    def __init__(self) -> None:
        import anthropic

        self._anthropic = anthropic
        self.client = anthropic.AsyncAnthropic(max_retries=2, timeout=60.0)
        st = get_settings()
        self.model = st.aura_model
        self.effort = st.aura_effort
        self.fallback = st.aura_refusal_fallback

    async def turn(self, system: str, messages: list[dict], tools: list[dict], on_text: OnText) -> Turn:
        a = self._anthropic
        kw: dict[str, Any] = {"model": self.model, "max_tokens": 8000, "system": system, "messages": messages, "tools": tools}
        if self.effort:
            kw["output_config"] = {"effort": self.effort}
        try:
            if self.fallback:
                ctx = self.client.beta.messages.stream(betas=["server-side-fallback-2026-07-01"], fallbacks=self.fallback, **kw)
            else:
                ctx = self.client.messages.stream(**kw)
            async with ctx as stream:
                async for event in stream:
                    if event.type == "text":
                        await on_text(event.text)
                final = await stream.get_final_message()
        except ValueError as e:  # tool input JSON the SDK could not parse
            raise ProviderError("bad_tool_input", str(e)[:200]) from e
        except a.AuthenticationError as e:
            raise ProviderError("auth", "The AI provider rejected the server's API key.") from e
        except a.RateLimitError as e:
            raise ProviderError("rate_limited", "The AI provider is rate-limiting requests.") from e
        except a.BadRequestError as e:
            raise ProviderError("bad_request", f"The AI provider rejected the request: {e.message}"[:300]) from e
        except a.APIStatusError as e:
            raise ProviderError("upstream_error", f"AI provider error ({e.status_code}).") from e
        except a.APIConnectionError as e:
            raise ProviderError("connection", "Cannot reach the AI provider.") from e
        text = "".join(b.text for b in final.content if b.type == "text")
        calls = [ToolCall(b.id, b.name, b.input) for b in final.content if b.type == "tool_use"]
        return Turn(assistant_content=final.content, text=text, tool_calls=calls, stop_reason=final.stop_reason or "end_turn")


class MockProvider:
    """Deterministic stand-in used by tests and for demos without an API key. Not an AI: it follows a script.

    - On the first round it calls tools picked by keywords in the last user message.
    - After tool results arrive it answers with a summary built only from those results.
    """

    name = "mock"
    RULES = [
        (r"show|open|chart|history", [("open_dashboard_page", {"page": "history", "sensor": "temperature", "range": "24h"})]),
        (r"temp|hot|humid", [("get_sensor_readings", {"sensor": "temperature"})]),
        (r"smoke|gas|mq", [("get_sensor_readings", {"sensor": "smoke"})]),
        (r"alert|incident|why|happen", [("get_alerts", {"filter": "active"})]),
        (r"gsm|sms|text|call", [("get_gsm_status", {})]),
        (r"board|esp32|uno|controller|offline", [("get_controller_health", {})]),
        (r"fan on|turn on the fan|switch on the fan", [("propose_device_command", {"actuator": "fan", "action": "on", "reason": "You asked to turn the fan on."})]),
        (r"door|unlock|disable", [("propose_device_command", {"actuator": "door", "action": "open", "reason": "test of a forbidden command"})]),
    ]

    async def turn(self, system: str, messages: list[dict], tools: list[dict], on_text: OnText) -> Turn:
        last = messages[-1]
        if last["role"] == "user" and isinstance(last["content"], list) and last["content"] and last["content"][0].get("type") == "tool_result":
            results = [b for b in last["content"] if b.get("type") == "tool_result"]
            parts = []
            for r in results:
                body = r["content"] if isinstance(r["content"], str) else json.dumps(r["content"])
                parts.append(("Tool error: " if r.get("is_error") else "") + body[:400])
            text = "Based on ORION data: " + " | ".join(parts)
            await on_text(text)
            return Turn([{"type": "text", "text": text}], text)
        q = ""
        for b in (last["content"] if isinstance(last["content"], list) else [{"type": "text", "text": last["content"]}]):
            if b.get("type") == "text":
                q += b["text"].lower()
        names = {t["name"] for t in tools}
        calls: list[ToolCall] = []
        for pat, cs in self.RULES:
            if re.search(pat, q):
                for n, inp in cs:
                    if n in names:
                        calls.append(ToolCall(f"tu_{len(calls) + 1}", n, inp))
                break
        if not calls:
            calls = [ToolCall("tu_1", "get_system_status", {})] if "get_system_status" in names else []
        if not calls:
            text = "I can only answer from ORION data."
            await on_text(text)
            return Turn([{"type": "text", "text": text}], text)
        content = [{"type": "tool_use", "id": c.id, "name": c.name, "input": c.input} for c in calls]
        return Turn(content, "", calls, "tool_use")


def get_provider() -> Provider | None:
    st = get_settings()
    if st.aura_provider == "mock":
        return MockProvider()
    if st.aura_provider == "anthropic" and st.aura_model:
        return AnthropicProvider()
    return None


def status() -> dict:
    st = get_settings()
    if st.aura_provider == "mock":
        return {"available": True, "provider": "mock", "note": "Scripted test provider — not an AI."}
    if st.aura_provider == "anthropic":
        if not st.aura_model:
            return {"available": False, "provider": "anthropic", "reason": "AURA_MODEL is not set on the server."}
        import os

        if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
            return {"available": False, "provider": "anthropic", "reason": "ANTHROPIC_API_KEY is not set on the server."}
        return {"available": True, "provider": "anthropic"}
    return {"available": False, "provider": None, "reason": "No AI provider is configured (AURA_PROVIDER). Aura uses basic mode."}
