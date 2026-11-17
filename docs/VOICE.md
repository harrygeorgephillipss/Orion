# Aura voice engine

Aura talks and listens through **the ORION server**. The server holds every key; the web page and the Android app
never see one.

| Step | Primary | Fallback |
|---|---|---|
| Speech → text | Google Cloud Speech-to-Text (`speech:recognize`, v1) | Phone/browser speech recognition |
| Reasoning | Claude API (Anthropic) with live ORION data (docs/AURA.md) | Rule-based offline Aura |
| Text → speech | Google Cloud Text-to-Speech (MP3), one sentence at a time while the answer streams | Phone/browser voice |
| Anything fails | — | Text chat keeps working |

Claude's own voice (the Voice Mode inside Claude's apps) is **not** an API and is not used. The Claude API returns
text only; Google turns it into speech.

## How it works

1. The mic records with `MediaRecorder` (Opus in WebM/Ogg). Recording stops after about 1.2 s of quiet, when you
   tap the orb, or after 15 s.
2. The app uploads the recording to `POST /api/v1/aura/voice/transcribe?language=en|ml|hi`. The server checks
   sign-in, the rate limit (30 a minute per user), the content type, the file header and the size, then sends it
   to Google. Recordings are **not stored or logged**.
3. The text goes to Aura (`POST /api/v1/aura/chat`, streamed).
4. As each sentence arrives, the app requests `POST /api/v1/aura/voice/speak` (90 a minute per user) and plays the
   MP3 replies in order. Requests start straight away, so the next sentence is usually ready when the previous one
   ends.
5. Tapping stop or asking a new question pauses the audio and drops the queue.

Other endpoints: `GET /api/v1/aura/voice/config` (providers, languages, voices, limits) and
`GET /api/v1/aura/voice/health` (configuration check only; makes no paid call). All require sign-in. Errors come back
as `{"detail": {"code", "message"}}`; `503 not_configured` means the provider is off.

Languages: English (`en-IN`), Malayalam (`ml-IN`), Hindi (`hi-IN`). Aura's other languages keep using the device's
own voice. Voice choice (per language) and speaking speed (0.5–2×) are in Aura → language settings.

## Setup

1. In Google Cloud: create a project, **enable billing**, enable *Cloud Speech-to-Text API* and
   *Cloud Text-to-Speech API*.
2. Credentials, one of:
   - **On a Google Cloud VM (recommended, no key):** give the VM *Allow full access to all Cloud APIs*
     (VM → Stop → Edit → Access scopes → Save → Start), then run
     `sudo bash /opt/orion/scripts/cloud/enable-google-voice.sh` — it sets `VOICE_GOOGLE_AUTH=metadata`, restarts
     the backend and tests both services. Google's Speech-to-Text documentation describes account credentials
     (not API keys) for this API, so this is the most reliable option there.
   - an API key restricted to those two APIs → `GOOGLE_CLOUD_API_KEY`, or
   - a service account with access to them → save its JSON **outside the repository** and set
     `VOICE_GOOGLE_SERVICE_ACCOUNT_FILE` (with Docker, mount it read-only into the backend container).
3. In `.env`: `VOICE_STT_PROVIDER=google`, `VOICE_TTS_PROVIDER=google`. Restart the backend.
4. Check: `GET /api/v1/aura/voice/health` should report both as configured. Then speak to Aura in the app.

Android: the app asks for microphone permission the first time (`RECORD_AUDIO`).

## Billing (check Google's current price list)

Speech-to-Text bills per second of audio; Text-to-Speech bills per character, with Neural2/WaveNet voices costing
more than Standard. Both have a monthly free tier. Set a **budget alert** in Google Cloud. To limit cost: keep the
rate limits, keep `VOICE_MAX_AUDIO_BYTES` low, and pick "Default" voices.

## Tested / not tested

Automated (passing): server adapters against a fake Google endpoint, audio validation, sign-in, rate limits,
not-configured responses (`backend/tests/test_voice.py`); in the app with a fake microphone, speaker and server —
record → transcribe → spoken answer, stop interrupts playback, speech-service failure → device voice,
transcription failure → message and typing still works, mic permission denied
(`frontend/tests/e2e/server-voice.e2e.test.js`).

**Not tested yet:** real Google calls (no credentials in this environment), real recordings, recognition quality,
and Malayalam/Hindi with native speakers. **Multilingual voice support is not complete until this is done.**
Also untested: the Android WebView recording on real phones, Bluetooth headsets, noisy rooms.

Voice is never needed for safety: alarms, the buzzer, fan and SMS/calls run on the UNO and ESP32 with no server.
