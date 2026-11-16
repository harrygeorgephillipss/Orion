# ORION — Smart Home Safety & Automation (prototype)

ORION watches a home with an **MQ-2 smoke/gas sensor, flame sensor, water sensor and DHT22**, reacts locally with an
**exhaust fan, buzzer, LEDs and servos**, and can send **SMS/calls through a SIM800C**. **Aura** is its assistant.

> **ORION is a prototype.** It is not a certified fire alarm, gas detector or safety system and must not be relied
> on as one. Nothing in this repository has been tested on the physical hardware yet.

## Status (2026-11-16)

| Phase | What | Status |
|---|---|---|
| 0 | Repository, audit, plan | ✅ done — [docs/AUDIT_AND_PLAN.md](docs/AUDIT_AND_PLAN.md) |
| 1 | Stable web app (existing design kept) | ✅ code + automated tests |
| 2 | Backend, database, real-time, auth | ✅ code + automated tests + full-stack test **with the device simulator** |
| 3 | ESP32 + UNO firmware, wiring, GSM | ⏳ next — design in [docs/hardware-architecture.md](docs/hardware-architecture.md), protocol in [hardware/communication/PROTOCOL.md](hardware/communication/PROTOCOL.md) |
| 4 | Independent Aura AI (server-side, Anthropic API) | ⏳ not started — Aura still uses the Claude artifact host or basic offline mode |
| 5 | Android app (Capacitor) | ⏳ not started |
| 6 | Testing & safety validation | ⏳ not started (software tests exist; no hardware validation) |

Evidence levels used everywhere in the docs: **code complete** → **automated / simulated test passed** →
**physically verified** (only with bench data from real hardware — none yet).

## Repository layout

```
frontend/   web app (vanilla JS, single index.html built by build.py), unit + e2e + system tests
backend/    FastAPI server: REST, WebSocket, MQTT ingest, incident engine, auth — with tests
hardware/   communication/ (MQTT protocol, device simulator) — firmware + wiring arrive in Phase 3
deployment/ docker-compose (PostgreSQL, Mosquitto, backend, Caddy), broker config + ACL
scripts/    helper scripts (Mosquitto password file)
docs/       audit & plan, architecture, API, security, testing, deployment, limitations, handoff
```

## Quick start

**1. Just look around (no server, no hardware):** open `frontend/index.html` in Chrome. It starts in
**Simulation mode** — a yellow banner and a "simulated" tag on every value make clear nothing is real.

**2. Full stack on one machine (with the device simulator):** see [docs/BACKEND.md](docs/BACKEND.md). In short:

```bash
cp .env.example .env    # then edit every value
```

```bash
python3 scripts/mqtt_passwd.py deployment/mosquitto/passwd orion-backend --from-env ORION_MQTT_PASSWORD
```

```bash
docker compose -f deployment/docker-compose.yml --env-file .env up -d --build
```

Open `http://localhost:8000`, sign in with the bootstrap owner from `.env`, register a gateway (or the simulator,
[docs/BACKEND.md](docs/BACKEND.md#device-simulator)), and the existing dashboard shows its data live.

## Tests

```bash
cd frontend && npm ci && npm run check          # lint + 27 unit + 12 browser e2e tests
```

```bash
cd backend && pip install -r requirements-dev.txt && pytest   # 37 tests, needs PostgreSQL (and Mosquitto for 1 test)
```

Results and how the full-stack system test is run: [docs/TESTING.md](docs/TESTING.md).

## Aura today

Aura's AI currently only works when ORION is opened inside the Claude artifact viewer; elsewhere it answers in
basic English from ORION data (rule-based), and voice input uses the browser's speech recognition where
available. Phase 4 moves Aura to the ORION server with a configurable provider and permission-checked tools.

## Safety

Local protection (buzzer, fan, door servo, SMS/call on flame) is designed to run on the microcontrollers without
Wi-Fi, the server, the app or the AI. That design is documented but **not yet built or tested** — see
[docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md). In a real fire or gas leak: get everyone out and call
**112** (or **101** for fire in India).
