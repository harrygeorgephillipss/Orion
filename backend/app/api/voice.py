"""Aura voice endpoints (/api/v1/aura/voice/*). Audio is handled in memory only and never logged."""
from __future__ import annotations

import os

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field

from ..aura import voice as V
from ..deps import current_user
from ..models import User
from ..ratelimit import RateLimiter

router = APIRouter(prefix="/aura/voice", tags=["aura-voice"])
stt_limiter = RateLimiter(limit=30, window_s=60)
tts_limiter = RateLimiter(limit=90, window_s=60)


def _err(e: V.VoiceError) -> HTTPException:
    return HTTPException(e.status, {"code": e.code, "message": str(e)})


@router.get("/config")
async def config(_: User = Depends(current_user)) -> dict:
    s, t = V.stt(), V.tts()
    return {
        "stt": {"available": s is not None, "provider": s.name if s else None},
        "tts": {"available": t is not None, "provider": t.name if t else None},
        "languages": [{"code": k, "bcp47": v[0], "name": v[1]} for k, v in V.LANGS.items()],
        "voices": {k: [{"name": n, "label": l} for n, l in vs] for k, vs in V.VOICES.items()},
        "max_audio_bytes": V.MAX_AUDIO_BYTES, "max_text_chars": V.MAX_TEXT,
        "audio_types": list(V.AUDIO_TYPES),
    }


@router.get("/health")
async def health(_: User = Depends(current_user)) -> dict:
    """Configuration check only (no billable call)."""
    def state(env: str, prov) -> str:
        p = os.environ.get(env, "")
        return "not_configured" if not p else ("ok" if prov is not None else "missing_credentials")
    return {"stt": state("VOICE_STT_PROVIDER", V.stt()), "tts": state("VOICE_TTS_PROVIDER", V.tts())}


@router.post("/transcribe")
async def transcribe(request: Request, language: str = Query("en", pattern="^(en|ml|hi)$"), user: User = Depends(current_user)) -> dict:
    stt_limiter.check(f"stt:{user.id}")
    p = V.stt()
    if p is None:
        raise HTTPException(503, {"code": "not_configured", "message": "Speech-to-text is not configured on the server"})
    n = int(request.headers.get("content-length") or 0)
    if n > V.MAX_AUDIO_BYTES:
        raise _err(V.VoiceError("too_large", "Audio is too large", 413))
    body = await request.body()
    try:
        mime = V.check_audio(body, request.headers.get("content-type", ""))
        t = await p.transcribe(body, mime, language)
    except V.VoiceError as e:
        raise _err(e)
    return {"text": t.text, "confidence": t.confidence, "language": t.language, "provider": p.name}


class SpeakIn(BaseModel):
    text: str = Field(min_length=1, max_length=V.MAX_TEXT)
    language: str = Field(default="en", pattern="^(en|ml|hi)$")
    voice: str = Field(default="", max_length=60, pattern=r"^[A-Za-z0-9-]*$")
    rate: float = Field(default=1.0, ge=0.5, le=2.0)


@router.post("/speak")
async def speak(body: SpeakIn, user: User = Depends(current_user)) -> Response:
    tts_limiter.check(f"tts:{user.id}")
    p = V.tts()
    if p is None:
        raise HTTPException(503, {"code": "not_configured", "message": "Text-to-speech is not configured on the server"})
    try:
        audio, mime = await p.synthesize(body.text, body.language, body.voice, body.rate)
    except V.VoiceError as e:
        raise _err(e)
    return Response(audio, media_type=mime, headers={"Cache-Control": "no-store"})
