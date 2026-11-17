"""Aura voice: Google adapters (fake Google server), validation, auth, rate limits, mock providers end to end."""
from __future__ import annotations

import base64
import json

import httpx
import pytest

from app.api.voice import stt_limiter, tts_limiter
from app.aura import voice as V

WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 20


@pytest.fixture
def mock_voice(monkeypatch):
    monkeypatch.setenv("VOICE_STT_PROVIDER", "mock")
    monkeypatch.setenv("VOICE_TTS_PROVIDER", "mock")
    stt_limiter.reset(); tts_limiter.reset()


async def test_google_stt_request_and_parse(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLOUD_API_KEY", "test-key")
    seen = {}

    def h(req: httpx.Request) -> httpx.Response:
        seen["url"], seen["key"], seen["body"] = str(req.url), req.headers.get("x-goog-api-key"), json.loads(req.content)
        return httpx.Response(200, json={"results": [{"alternatives": [{"transcript": "താപനില എത്ര", "confidence": 0.91}]}]})
    t = await V.GoogleSTT(httpx.MockTransport(h)).transcribe(WEBM + b"abc", "audio/webm", "ml")
    assert seen["url"] == "https://speech.googleapis.com/v1/speech:recognize" and seen["key"] == "test-key"
    assert seen["body"]["config"]["languageCode"] == "ml-IN" and seen["body"]["config"]["encoding"] == "WEBM_OPUS"
    assert base64.b64decode(seen["body"]["audio"]["content"]).startswith(b"\x1a\x45")
    assert t.text == "താപനില എത്ര" and t.confidence == 0.91


async def test_google_tts_request_and_errors(monkeypatch):
    monkeypatch.setenv("GOOGLE_CLOUD_API_KEY", "test-key")

    def ok(req):
        b = json.loads(req.content)
        assert b["voice"] == {"languageCode": "hi-IN", "name": "hi-IN-Neural2-A"} and b["audioConfig"]["speakingRate"] == 1.2
        return httpx.Response(200, json={"audioContent": base64.b64encode(b"ID3audio").decode()})
    audio, mime = await V.GoogleTTS(httpx.MockTransport(ok)).synthesize("नमस्ते", "hi", "hi-IN-Neural2-A", 1.2)
    assert audio == b"ID3audio" and mime == "audio/mpeg"
    with pytest.raises(V.VoiceError) as e:
        await V.GoogleTTS(httpx.MockTransport(lambda r: httpx.Response(403, json={"error": {"status": "PERMISSION_DENIED"}}))).synthesize("x", "en", "", 1)
    assert "PERMISSION_DENIED" in str(e.value)
    def boom(r):
        raise httpx.ConnectError("down")
    with pytest.raises(V.VoiceError) as e:
        await V.GoogleSTT(httpx.MockTransport(boom)).transcribe(WEBM, "audio/webm", "en")
    assert e.value.code == "connection"


def test_audio_validation():
    assert V.check_audio(WEBM, "audio/webm;codecs=opus") == "audio/webm"
    for body, mime, code in [(WEBM, "video/mp4", "bad_type"), (b"", "audio/webm", "empty"), (b"hello world", "audio/webm", "bad_audio"), (b"\x1a\x45\xdf\xa3" + b"0" * (V.MAX_AUDIO_BYTES + 1), "audio/webm", "too_large")]:
        with pytest.raises(V.VoiceError) as e:
            V.check_audio(body, mime)
        assert e.value.code == code


async def test_endpoints_need_auth_and_report_unconfigured(client, auth):
    assert (await client.get("/api/v1/aura/voice/config")).status_code == 401
    assert (await client.post("/api/v1/aura/voice/transcribe", content=WEBM, headers={"content-type": "audio/webm"})).status_code == 401
    c = (await client.get("/api/v1/aura/voice/config", headers=auth["viewer"])).json()
    assert c["stt"]["available"] is False and [l["code"] for l in c["languages"]] == ["en", "ml", "hi"]
    assert (await client.get("/api/v1/aura/voice/health", headers=auth["viewer"])).json() == {"stt": "not_configured", "tts": "not_configured"}
    r = await client.post("/api/v1/aura/voice/speak", json={"text": "hi"}, headers=auth["viewer"])
    assert r.status_code == 503 and r.json()["detail"]["code"] == "not_configured"


async def test_mock_voice_end_to_end_and_limits(client, auth, mock_voice):
    h = auth["viewer"] | {"content-type": "audio/webm"}
    r = await client.post("/api/v1/aura/voice/transcribe?language=hi", content=WEBM + "TEXT:तापमान क्या है".encode(), headers=h)
    assert r.status_code == 200 and r.json()["text"] == "तापमान क्या है" and r.json()["language"] == "hi"
    assert (await client.post("/api/v1/aura/voice/transcribe?language=fr", content=WEBM, headers=h)).status_code == 422
    assert (await client.post("/api/v1/aura/voice/transcribe", content=b"not audio", headers=h)).status_code == 400
    assert (await client.post("/api/v1/aura/voice/transcribe", content=WEBM, headers=h)).json()["detail"]["code"] == "no_speech"
    s = await client.post("/api/v1/aura/voice/speak", json={"text": "ലിവിംഗ് റൂം 29 °C", "language": "ml", "voice": "ml-IN-Wavenet-A", "rate": 1.1}, headers=auth["viewer"])
    assert s.status_code == 200 and s.headers["content-type"] == "audio/mpeg" and s.content.startswith(b"ID3")
    assert (await client.post("/api/v1/aura/voice/speak", json={"text": "x" * 1501}, headers=auth["viewer"])).status_code == 422
    assert (await client.post("/api/v1/aura/voice/speak", json={"text": "x", "voice": "a b<script>"}, headers=auth["viewer"])).status_code == 422
    codes = [(await client.post("/api/v1/aura/voice/transcribe", content=WEBM + b"TEXT:x", headers=h)).status_code for _ in range(32)]
    assert 429 in codes


async def test_google_vm_identity(monkeypatch):
    """On a Google Cloud VM: token from the metadata server, sent as a Bearer token; no key involved."""
    monkeypatch.delenv("GOOGLE_CLOUD_API_KEY", raising=False)
    monkeypatch.setenv("VOICE_GOOGLE_AUTH", "metadata")
    calls = []

    def h(req: httpx.Request) -> httpx.Response:
        calls.append(str(req.url))
        if req.url.host == "169.254.169.254":
            assert req.headers["metadata-flavor"] == "Google"
            return httpx.Response(200, json={"access_token": "vm-token", "expires_in": 3599})
        assert req.headers["authorization"] == "Bearer vm-token" and "x-goog-api-key" not in req.headers
        return httpx.Response(200, json={"audioContent": base64.b64encode(b"ID3x").decode()})
    tts = V.GoogleTTS(httpx.MockTransport(h))
    assert tts.auth.configured
    await tts.synthesize("hello", "en", "", 1.0)
    await tts.synthesize("again", "en", "", 1.0)
    assert sum("169.254.169.254" in c for c in calls) == 1  # token reused until it expires
