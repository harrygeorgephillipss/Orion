# Development handoff

Last updated: 2026-11-16 · branch `dev` · read this first in a new session, then [AUDIT_AND_PLAN.md](AUDIT_AND_PLAN.md).

## Decisions already made by the owner (don't re-ask)

- Repo: untouched prototype is the first commit (`8e4f04b`); all work on `dev`; `main` only via an approved PR.
  *The cloud session could not push `main` or tags (HTTP 403 from the session's git policy). The owner can create
  `main` from commit `8e4f04b` on GitHub.*
- Aura provider: **Anthropic Claude API** behind a provider interface, key server-side only (`AURA_MODEL`,
  set by the owner; `AURA_EFFORT`).
- Android: **Capacitor** wrapping the existing web UI + FCM + native speech.
- Mist maker: **disabled "not installed" placeholder**.
- Architecture approved: UNO = safety controller (all sensors/outputs), ESP32 = gateway (Wi-Fi/MQTT + SIM800C);
  FastAPI + PostgreSQL + Mosquitto + WebSocket.

## Done

| Phase | Evidence |
|---|---|
| 0 Bootstrap | baseline commit, `.gitignore`, `.env.example`, audit |
| 1 Frontend | fixes B1–B3, B5, B6 (see audit), registry-driven UI, Simulation labelling, error boundaries, lint, 27 unit + 12 e2e tests passing |
| 2 Backend | FastAPI/Postgres/MQTT/WS, auth + RBAC, ingest, incident engine, commands, audit, config, contacts, simulator, LiveSource, Docker/compose, broker ACL — 37 backend tests + 8-step full-stack system test passing; broker ACL verified; image boot verified |

Details and numbers: [TESTING.md](TESTING.md).

## Not done / open issues

- **Phase 3 (next):** firmware for UNO and ESP32 per [hardware-architecture.md](hardware-architecture.md) and
  [PROTOCOL.md](../hardware/communication/PROTOCOL.md). Plan: portable C++ safety core in `hardware/common/`
  unit-tested on the host with g++, then `hardware/arduino_uno/` and `hardware/esp32/` PlatformIO projects.
  **Blocked in the cloud sandbox:** toolchain downloads (`downloads.arduino.cc`, PlatformIO registry, GitHub release
  assets) are refused by the environment's network policy — request those hosts or compile locally. Needs the
  owner's module details (list at the end of hardware-architecture.md) and bench testing on real boards.
- Phase 4 Aura service, Phase 5 Android (`dl.google.com` also blocked here), Phase 6 validation.
- TLS (HTTPS / MQTTS) untested; telemetry retention not scheduled; no CI workflow yet; no `pip-audit`/`npm audit`.
- Remaining audit items: B4 (SMS/call toggles still placeholders — wire to contacts API + firmware config in
  Phase 3), B10 (bundle fonts — Phase 5), B11 (SG90/MG995 purposes — owner input).
- Registering a gateway returns its MQTT password, but adding it to the broker is a manual script step.

## How to resume

```bash
git clone https://github.com/harrygeorgephillipss/Orion.git && cd Orion && git checkout dev
```

Then follow [BACKEND.md](BACKEND.md) (Option B) to start PostgreSQL + Mosquitto + backend, and
[TESTING.md](TESTING.md) to run every suite. Expected: lint clean, 27 + 12 frontend, 37 backend, 8/8 system.

## Conventions

- Snapshot shape (consumed by `frontend/src/*`): produced by `DemoSource.snapshot()` and
  `backend/app/services/snapshot.py:overview()` — keep them in sync; `registry.js` documents the keys.
- Never present simulated data without the `simulated` flag; never mark an output "verified" without feedback.
- Commit messages end with the Co-Authored-By / Claude-Session lines; keep AI model IDs out of repo files (configure via `AURA_MODEL`).
