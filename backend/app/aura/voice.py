"""Aura voice providers (speech-to-text, text-to-speech), independent of the AI provider.

Configured by environment (no keys in the frontend):
  VOICE_STT_PROVIDER = google | mock | ""      VOICE_TTS_PROVIDER = google | mock | ""
  GOOGLE_CLOUD_API_KEY = …  (or VOICE_GOOGLE_SERVICE_ACCOUNT_FILE = path to a service-account JSON)
Audio is processed in memory and never logged or stored.
"""
from __future__ import annotations

import base64
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import httpx
import jwt

LANGS = {"en": ("en-IN", "English"), "ml": ("ml-IN", "മലയാളം Malayalam"), "hi": ("hi-IN", "हिन्दी Hindi")}
# Voice names change over time — confirm in Google's voice list for your project. "" lets Google choose.
VOICES = {
    "en": [("", "Default"), ("en-IN-Neural2-A", "Neural2 A (female)"), ("en-IN-Neural2-B", "Neural2 B (male)")],
    "ml": [("", "Default"), ("ml-IN-Wavenet-A", "Wavenet A (female)"), ("ml-IN-Wavenet-B", "Wavenet B (male)")],
    "hi": [("", "Default"), ("hi-IN-Neural2-A", "Neural2 A (female)"), ("hi-IN-Neural2-B", "Neural2 B (male)")],
}
MAX_AUDIO_BYTES = int(os.environ.get("VOICE_MAX_AUDIO_BYTES", "1000000"))
MAX_TEXT = 1500
# accepted uploads: mime → (Google encoding, magic-bytes check)
AUDIO_TYPES = {
    "audio/webm": ("WEBM_OPUS", lambda b: b[:4] == b"\x1a\x45\xdf\xa3"),
    "audio/ogg": ("OGG_OPUS", lambda b: b[:4] == b"OggS"),
    "audio/wav": ("LINEAR16", lambda b: b[:4] == b"RIFF" and b[8:12] == b"WAVE"),
}


class VoiceError(Exception):
    def __init__(self, code: str, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.code, self.status = code, status


@dataclass
class Transcript:
    text: str
    confidence: float | None
    language: str


class STT(Protocol):
    name: str
    async def transcribe(self, audio: bytes, mime: str, lang: str) -> Transcript: ...


class TTS(Protocol):
    name: str
    async def synthesize(self, text: str, lang: str, voice: str, rate: float) -> tuple[bytes, str]: ...


class _GoogleAuth:
    """Google credentials, in order: API key; service-account JSON file; or (VOICE_GOOGLE_AUTH=metadata) the identity
    of the Google Cloud VM the server runs on - no key stored anywhere. Tokens are refreshed automatically."""

    META = "http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/token"

    def __init__(self, http: httpx.AsyncClient) -> None:
        self.http = http
        self.key = os.environ.get("GOOGLE_CLOUD_API_KEY", "")
        f = os.environ.get("VOICE_GOOGLE_SERVICE_ACCOUNT_FILE", "")
        self.sa = json.loads(Path(f).read_text()) if f and Path(f).is_file() else None
        self.meta = os.environ.get("VOICE_GOOGLE_AUTH", "").lower() == "metadata"
        self._tok, self._exp = None, 0.0

    @property
    def configured(self) -> bool:
        return bool(self.key or self.sa or self.meta)

    async def headers(self) -> dict:
        if self.key:
            return {"X-Goog-Api-Key": self.key}
        if self.meta and not self.sa:
            if not self._tok or time.time() > self._exp - 60:
                try:
                    r = await self.http.get(self.META, headers={"Metadata-Flavor": "Google"})
                except httpx.HTTPError as e:
                    raise VoiceError("auth", "This server is not on a Google Cloud VM (no metadata server)", 502) from e
                if r.status_code != 200:
                    raise VoiceError("auth", f"Google Cloud VM identity unavailable ({r.status_code})", 502)
                j = r.json()
                self._tok, self._exp = j["access_token"], time.time() + int(j.get("expires_in", 300))
            return {"Authorization": f"Bearer {self._tok}"}
        if not self.sa:
            raise VoiceError("not_configured", "No Google credentials on the server", 503)
        if not self._tok or time.time() > self._exp - 60:
            now = int(time.time())
            uri = self.sa.get("token_uri", "https://oauth2.googleapis.com/token")
            a = jwt.encode({"iss": self.sa["client_email"], "scope": "https://www.googleapis.com/auth/cloud-platform", "aud": uri, "iat": now, "exp": now + 3600}, self.sa["private_key"], algorithm="RS256")
            r = await self.http.post(uri, data={"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": a})
            if r.status_code != 200:
                raise VoiceError("auth", "Google rejected the service account", 502)
            self._tok, self._exp = r.json()["access_token"], time.time() + 3600
        return {"Authorization": f"Bearer {self._tok}"}


async def _post(http: httpx.AsyncClient, auth: _GoogleAuth, url: str, body: dict, what: str) -> dict:
    try:
        r = await http.post(url, headers=await auth.headers(), json=body)
    except httpx.HTTPError as e:
        raise VoiceError("connection", f"Cannot reach Google {what} ({type(e).__name__})") from e
    if r.status_code != 200:
        status = ""
        try:
            status = r.json().get("error", {}).get("status", "")
        except ValueError:
            pass
        raise VoiceError("upstream_error", f"Google {what} error {r.status_code} {status}".strip())
    return r.json()


class GoogleSTT:
    name = "google"

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.http = httpx.AsyncClient(timeout=30, transport=transport)
        self.auth = _GoogleAuth(self.http)

    async def transcribe(self, audio: bytes, mime: str, lang: str) -> Transcript:
        enc = AUDIO_TYPES[mime][0]
        cfg = {"encoding": enc, "languageCode": LANGS[lang][0], "enableAutomaticPunctuation": True, "maxAlternatives": 1}
        if enc != "LINEAR16":
            cfg["sampleRateHertz"] = 48000
        j = await _post(self.http, self.auth, "https://speech.googleapis.com/v1/speech:recognize", {"config": cfg, "audio": {"content": base64.b64encode(audio).decode()}}, "Speech-to-Text")
        alts = [r["alternatives"][0] for r in j.get("results", []) if r.get("alternatives")]
        text = " ".join(a.get("transcript", "").strip() for a in alts).strip()
        conf = alts[0].get("confidence") if alts else None
        return Transcript(text, conf, lang)


class GoogleTTS:
    name = "google"

    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self.http = httpx.AsyncClient(timeout=30, transport=transport)
        self.auth = _GoogleAuth(self.http)

    async def synthesize(self, text: str, lang: str, voice: str, rate: float) -> tuple[bytes, str]:
        v = {"languageCode": LANGS[lang][0]}
        if voice:
            v["name"] = voice
        j = await _post(self.http, self.auth, "https://texttospeech.googleapis.com/v1/text:synthesize",
                        {"input": {"text": text}, "voice": v, "audioConfig": {"audioEncoding": "MP3", "speakingRate": rate}}, "Text-to-Speech")
        return base64.b64decode(j["audioContent"]), "audio/mpeg"


class MockSTT:
    """Test provider: treats audio whose payload (after the container magic) contains `TEXT:<words>` as those words."""

    name = "mock"

    async def transcribe(self, audio: bytes, mime: str, lang: str) -> Transcript:
        i = audio.find(b"TEXT:")
        if i < 0:
            raise VoiceError("no_speech", "No speech recognised", 422)
        return Transcript(audio[i + 5:].decode("utf-8", "replace").strip(), 0.99, lang)


class MockTTS:
    name = "mock"

    async def synthesize(self, text: str, lang: str, voice: str, rate: float) -> tuple[bytes, str]:
        return b"ID3MOCK" + f"{lang}|{voice}|{rate}|{text}".encode(), "audio/mpeg"


def stt() -> STT | None:
    p = os.environ.get("VOICE_STT_PROVIDER", "")
    if p == "mock":
        return MockSTT()
    if p == "google":
        g = GoogleSTT()
        return g if g.auth.configured else None
    return None


def tts() -> TTS | None:
    p = os.environ.get("VOICE_TTS_PROVIDER", "")
    if p == "mock":
        return MockTTS()
    if p == "google":
        g = GoogleTTS()
        return g if g.auth.configured else None
    return None


def check_audio(body: bytes, mime: str) -> str:
    base = (mime or "").split(";")[0].strip().lower()
    if base == "audio/x-wav":
        base = "audio/wav"
    if base not in AUDIO_TYPES:
        raise VoiceError("bad_type", f"Unsupported audio type {base!r} (use webm/opus, ogg/opus or wav)", 415)
    if not body:
        raise VoiceError("empty", "No audio received", 400)
    if len(body) > MAX_AUDIO_BYTES:
        raise VoiceError("too_large", f"Audio is larger than {MAX_AUDIO_BYTES // 1000} kB (about a minute)", 413)
    if not AUDIO_TYPES[base][1](body):
        raise VoiceError("bad_audio", "The file does not look like the declared audio type", 400)
    return base
