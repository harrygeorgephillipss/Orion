# ORION — Smart Home Safety & Automation (prototype)

ORION watches a home with an **MQ-2 smoke/gas sensor, flame sensor, water sensor and DHT22**, reacts locally with an
**exhaust fan, buzzer, LEDs and servos**, and can send **SMS/calls through a SIM800C**. **Aura** is its assistant.

> **ORION is a prototype.** It is not a certified fire alarm, gas detector or safety system and must not be relied
> on as one. Nothing in this repository has been tested on the physical hardware yet.

## Status (2026-11-16)

| Phase | What | Status |
|---|---|---|
| 0 | Repository, audit, plan | ✅ [docs/AUDIT_AND_PLAN.md](docs/AUDIT_AND_PLAN.md) |
| 1 | Stable web app (existing design kept) | ✅ code + automated tests |
| 2 | Backend, database, real-time, auth | ✅ code + automated tests + full-stack test with the device simulator (also on the production Docker stack) |
| 3 | UNO + ESP32 firmware, wiring, GSM | 🟡 code + host tests + **compiles for both chips** — not yet run on physical boards |
| 4 | Aura on the server (Anthropic API, permissioned tools) | 🟡 code + tests with a scripted provider — not yet run against the real API (needs your key) |
| 5 | Android app (Capacitor) + push | 🟡 debug APK builds + bridge tests — not yet run on a phone; push needs your Firebase project |
| 6 | Testing & safety validation | 🟡 CI pipeline + automated coverage map — **no physical bench results yet** ([docs/VALIDATION.md](docs/VALIDATION.md)) |

Evidence levels used everywhere in the docs: **code complete** → **automated / simulated test passed** →
**built for the real target** → **physically verified** (only with bench data from real hardware — none yet).

## Repository layout

```
frontend/   web app (vanilla JS, single index.html built by build.py), unit + e2e + system tests
backend/    FastAPI server: REST, WebSocket, MQTT ingest, incident engine, auth — with tests
hardware/   lib/OrionCore (portable safety logic + tests), arduino_uno/, esp32/, communication/ (protocol, simulator)
android/    Capacitor Android app (wraps frontend/)
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
cd frontend && npm ci && npm run check          # lint + 27 unit + 18 browser e2e tests
```

```bash
cd backend && pip install -r requirements-dev.txt && pytest   # 55 tests, needs PostgreSQL (and Mosquitto for 1 test)
```

```bash
make -C hardware/lib/OrionCore/test             # firmware logic: 20 tests / 101 checks
```

Results and how the full-stack system tests are run: [docs/TESTING.md](docs/TESTING.md). CI: `.github/workflows/ci.yml`.

## Aura

Aura runs on the ORION server ([docs/AURA.md](docs/AURA.md)): set `AURA_PROVIDER=anthropic`, `AURA_MODEL` and
`ANTHROPIC_API_KEY` on the server. Without them Aura answers in basic mode from ORION data. Emergency advice
(112 / 101) is given first by a deterministic safety layer whether or not the AI is available.

## Safety

Local protection (buzzer, fan, door servo, SMS/call on flame) runs on the microcontrollers without Wi-Fi, the
server, the app or the AI. The firmware is written, unit-tested and compiles, but **has not been tested on real
hardware** — see
[docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md). In a real fire or gas leak: get everyone out and call
**112** (or **101** for fire in India).
