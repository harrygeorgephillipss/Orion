# ORION architecture

```
 HOME (no internet needed for local protection)                 SERVER (LAN PC / Raspberry Pi / VPS)
 ┌──────────────────────────────┐   UART + level shifter   ┌──────────────────────────────────────────────┐
 │ Arduino UNO — safety         │◄────────────────────────►│ Mosquitto (per-gateway accounts + ACL)       │
 │ controller: sensors, outputs,│                          │      ▲ MQTT (QoS 1, last-will)               │
 │ local rules, watchdog        │       ESP32 — gateway ───┼──────┘                                       │
 └──────────────────────────────┘       Wi-Fi/MQTT, SIM800C│ FastAPI backend                              │
                                                           │  ingest → incident engine → PostgreSQL       │
                                                           │  REST /api/v1 · WebSocket /api/v1/ws         │
                                                           │  auth/RBAC · commands · audit · config       │
                                                           │  (Phase 4) Aura service · (Phase 5) FCM push │
                                                           └──────────────┬───────────────────────────────┘
                                          web app (same origin, HTTPS) ◄──┤
                                          Android app (Capacitor)      ◄──┘
```

## Principles

1. **Local first.** Hazard detection and the immediate response run on the UNO. The server, apps and AI observe,
   record, notify and allow limited allow-listed commands — they cannot override or disable local protection.
2. **No invented data.** Stale or missing data is never shown as normal; simulated data is labelled at every layer
   (`simulated` flag from registration → database rows → API → UI tags/banner → Aura context).
3. **Commanded ≠ verified.** Outputs and commands carry what was commanded; "verified" requires feedback hardware.
4. **The device's state is authoritative for hazards.** The server doesn't re-threshold smoke/flame/water.

## Frontend (`frontend/`)

Vanilla JavaScript modules concatenated into one `index.html` by `build.py` (kept from the prototype — no
framework, no bundler). Data reaches the UI only through the **source adapter** interface
(`snapshot / history / acknowledge / command / start / stop`):

- `sources.js` — `DemoSource`: the in-browser **simulation** (unchanged behaviour, now registry-shaped, follows the
  UNO/ESP32 split).
- `live.js` — `LiveSource`: REST + WebSocket client for the ORION server.
- `registry.js` — derives tiles, chart series, settings rows and Aura's sensor context from the snapshot, so no
  sensor or controller IDs are hard-coded.
- `state.js` — pure evaluation of overall state (OFFLINE > EMERGENCY > ATTENTION > DEGRADED > NORMAL).
- `views.js`, `charts.js`, `components.js`, `app.js`, `aura*.js`, `styles.css` — pages, SVG charts, design.

## Backend (`backend/app/`)

| Module | Responsibility |
|---|---|
| `mqtt.py` | broker connection with back-off, subscribe `orion/+/+/+`, publish commands |
| `services/ingest.py` | validate device messages (Pydantic), reject unknown devices/sensors, store readings |
| `services/engine.py` | incident engine + health rules (run after each message and every 2 s) |
| `services/commands.py` | allow-list, lifecycle, expiry |
| `services/snapshot.py` | overview + history in the frontend's snapshot shape |
| `api/*` | REST routers + WebSocket |
| `security.py`, `deps.py`, `ratelimit.py`, `audit.py` | auth, roles, limits, audit trail |
| `bus.py` | in-process pub/sub feeding WebSocket clients |

## Key decisions and alternatives considered

| Decision | Why | Alternatives |
|---|---|---|
| Keep vanilla JS + single-file build | preserves the working UI and design; small | React/Vue rewrite — rejected (rebuild for no user benefit) |
| FastAPI + SQLAlchemy async + Alembic | typed validation, OpenAPI, same language as the Aura SDK | Node/Express — no advantage here |
| PostgreSQL (plain) | reliable, BRIN index adequate for one home's telemetry | TimescaleDB — extra extension not needed yet |
| MQTT (Mosquitto) for devices | last-will gives instant disconnect detection; QoS; tiny on ESP32 | HTTP polling — can't detect disconnects promptly |
| WebSocket for apps, overview re-fetch on events | simple and always consistent | granular client-side patching — more code and drift risk |
| UNO = safety controller, ESP32 = gateway + GSM | 5 V analog sensors, no network in the safety loop, UART limits | everything on ESP32 — ADC limits and network coupling |
| Capacitor for Android (Phase 5) | reuses the web UI | native Kotlin / Flutter — full UI rewrite |
