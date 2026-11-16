"""Deterministic safety layer. Runs before (and independently of) the AI, so emergency advice never waits for a model."""
from __future__ import annotations

import re

# English + common words in Malayalam, Hindi, Tamil, Bengali, Telugu, Kannada for fire / smoke / gas / help.
EMERGENCY = re.compile(
    r"\b(fire|smoke|burning|gas leak|leaking gas|explosion|help me|emergency|evacuat\w*|can'?t breathe)\b"
    r"|തീ|പുക|ഗ്യാസ്|ആഗ|आग|धुआं|धुआँ|गैस|बचाओ|தீ|புகை|ஆபத்து|আগুন|ধোঁয়া|నిప్పు|పొగ|ಬೆಂಕಿ|ಹೊಗೆ",
    re.IGNORECASE,
)

EMERGENCY_TEXT = (
    "If there is a real fire, smoke or gas leak: get everyone out now and call 112 (emergency) or 101 (fire) in India. "
    "Don't wait for ORION or for me — ORION is a prototype, not a certified alarm."
)


def preamble(user_text: str, active_critical: list[dict]) -> str | None:
    """Emergency guidance to show first, or None. Never depends on the model."""
    real = [i for i in active_critical if not i.get("simulated")]
    if real:
        what = "; ".join(i["what"] for i in real[:3])
        return f"ORION reports an active emergency: {what}. " + EMERGENCY_TEXT
    if EMERGENCY.search(user_text or ""):
        return EMERGENCY_TEXT
    return None
