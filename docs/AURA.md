# Aura — configuration, security and permissions (Phase 4)

Aura now runs **on the ORION server** (`backend/app/aura/`). The browser and Android app only stream its answers.
The AI provider's key never leaves the server.

## Turning the AI on

In the server's `.env`:

```
AURA_PROVIDER=anthropic
ANTHROPIC_API_KEY=<your key — never commit it>
AURA_MODEL=<Anthropic model ID of your choice>
AURA_EFFORT=            # optional: low | medium | high
AURA_REFUSAL_FALLBACK=default   # optional: let the API retry a declined request on a fallback model
```

Restart the backend. `GET /api/v1/aura/status` (or Aura's ⓘ panel in the app) shows whether it's available and why
not. Without a provider, Aura answers in **basic mode** (rule-based, English, from ORION data) — the emergency advice
still works.

`AURA_PROVIDER=mock` runs a **scripted test provider** (not an AI) that exercises the whole pipeline; the automated
tests use it.

**Status (2026-11-16):** the full pipeline is tested with the mock provider (10 backend tests + browser test).
**The Anthropic adapter has not been run against the real API** — no key was available in the build environment.

## How a question is answered

1. **Safety layer first (no AI involved).** If ORION has an active *real* critical incident, or the message contains
   fire/smoke/gas/help words (English, Malayalam, Hindi, Tamil, Bengali, Telugu, Kannada), the reply starts with:
   get everyone out, call 112 / 101. This is sent before the model is called and even if the AI is down.
2. The model gets a system prompt with the rules (only ORION data; stale/missing is never normal; label simulated
   data; no claims of "safe"; no actions), the user's language rule, and the last 10 turns of this conversation.
3. It may call tools. **Every call** is validated against a strict schema, checked against the user's role, executed
   by the server, and written to the audit log (`actor_type = aura`). At most 6 tool rounds per question.
4. The answer streams to the app (Server-Sent Events) and is stored in the conversation.

## Tools

| Tool | What it can do |
|---|---|
| get_system_status, get_sensor_readings, get_sensor_history, get_alerts, get_incident_history, get_device_status, get_gsm_status, get_controller_health | **read** ORION data (freshness, quality, simulated flags included) |
| open_dashboard_page | ask the app to show a page |
| propose_device_command | create a **proposal** for fan on / fan off / buzzer test |

There is **no tool** that changes settings, thresholds, safety rules, users, contacts or preferences, or that runs a
command. Door servo, SG90 and mist maker cannot even be proposed.

## Command proposals

A proposal is shown to the user as a confirmation dialog. Only `POST /api/v1/aura/proposals/{id}/confirm` by **the
same user**, with **member role or higher**, **within 2 minutes**, turns it into a normal command — which the
safety controller may still refuse. Viewers never get proposals.

## Memory

| Kind | Where | Who changes it |
|---|---|---|
| Conversation context | `aura_conversations` / `aura_messages`, per user, deleted after `AURA_RETENTION_DAYS` (30) | the conversation itself |
| User preferences (language, voice, push) | `user_preferences` via `/api/v1/aura/preferences` | the user only |
| Device configuration, incidents, logs | ORION tables | read-only to Aura |

Tool results are passed to the model as data; the prompt tells it to ignore instructions inside device names,
labels or fault texts, and in any case no tool exists that such an instruction could abuse.

## Voice and languages

Speech-to-text and text-to-speech run on the device (browser Web Speech API; Android native speech in Phase 5), so
audio never reaches the ORION server. 14 reply languages are kept (English, Malayalam, Hindi, Bengali, Tamil, Telugu,
Kannada, Marathi, Gujarati, Punjabi, Odia, Urdu, Assamese, Auto). Voice availability depends on the device's
installed voices.

## Limits

- Rate limit: 20 questions per minute per user.
- Answers are only as good as the provider; check important answers. Aura is not a safety system.
