# ORION — Technical Audit & Implementation Plan

## Context

ORION is a smart-home safety prototype (Arduino UNO + ESP32, MQ-2, flame, water, DHT22, fan/relay, buzzer, 2 servos, LEDs, SIM800C) with **Aura**, an AI assistant. What exists today is a single-page web **demonstration**: every reading is simulated in the browser, Aura's AI only works inside the Claude artifact sandbox, and there is no backend, database, firmware, or Android app. The goal is to turn it into a working system across six phases (frontend → backend → hardware → independent Aura → Android → validation) **without throwing away the existing work**, keeping simulation as a clearly separate test mode.

Decisions already made by the owner (2026-11-16):
- **Repo:** GitHub `harrygeorgephillipss/orion` is empty. Commit the untouched prototype to `main` once as a baseline (tag `v0.1-prototype`); all work happens on `dev`. `main` is not edited again except by a PR you approve.
- **Aura AI provider:** Anthropic Claude API first, behind a provider interface (env-configured, key server-side only).
- **Android:** Capacitor wrapping the existing web UI + native FCM push + native speech.
- **Mist maker:** keep as a disabled "not installed" placeholder (never auto-activated, no driver).

---

## 1. Audit of the existing project

### 1.1 What was inspected
`ORION_source.zip` (17 files, ~510 KB) and the uploaded `index.html` (byte-identical to the zip's built file). The GitHub repo has **no commits**, so the zip is the only codebase.

| File | Size | Role |
|---|---|---|
| `src/core.js` | 7 KB | `ORION` namespace, utils (PRNG, `esc`, localStorage wrapper), default config, list of 18 owner "pending decisions", IST date formatting |
| `src/sources.js` | 41 KB | **Data adapter boundary.** `DemoSource` = deterministic 7-day history + 2 s tick simulation (sensors, simulated firmware rules, GSM state machine, command lifecycle, backend-style incident engine, 14 scenarios). `LiveSource` = stub returning `unconfigured` |
| `src/state.js` | 4 KB | Pure `evaluate(snapshot, cfg, now)` → NORMAL / ATTENTION / EMERGENCY / DEGRADED / OFFLINE with freshness & heartbeat rules |
| `src/charts.js` | 11 KB | Hand-written SVG time-series (gaps, thresholds, incident bands, hover, decimation) |
| `src/components.js` | 8 KB | Icons, plain-language state/severity text, chips, guards |
| `src/views.js` | 37 KB | Home, History (+CSV), Alerts, Devices, Settings (+diagnostics) |
| `src/aura.js` | 10 KB | Rule-based offline Aura (regex intents, refuses device control, emergency-first) |
| `src/aura-ai.js` | 28 KB | Claude-artifact Aura: languages (14), grounded context builder, system prompt, 5 tools, browser TTS fallback |
| `src/aura-view.js` | 54 KB | Chat + full voice mode (silence detection, streaming speech, hands-free) |
| `src/app.js` | 15 KB | Router, header, dialogs, command confirmations, scenario drawer, boot |
| `src/styles.css` | 38 KB | Calm dark/light design system |
| `build.py` | 0.5 KB | Concatenates `src/` into one `index.html` |

Stack: vanilla ES2017 JS, no framework, no npm, no bundler, no tests, no lint. Only external dependency: Google Fonts.

### 1.2 Verified behaviour (run in headless Chromium, this session)
- `build.py` output is **reproducible** (rebuilt in memory = shipped `index.html`).
- All 6 routes render at 1280 px and 390 px with **no JS errors and no horizontal overflow**.
- All scenarios drive the state machine (smoke → ATTENTION/EMERGENCY, flame → EMERGENCY, backend_error/no_data → OFFLINE, loading → LOADING, normal → NORMAL). Live mode correctly shows OFFLINE/unconfigured and never invents values.
- Outside Claude: `cap.sample`, `cap.dict`, `cap.tts` are all null → Aura falls back to rule-based English, no speech-to-text.

### 1.3 Strengths worth preserving (reuse, don't rewrite)
- The **adapter interface** in `sources.js` (`snapshot/history/acknowledge/command/start/stop`) is the right seam: the live backend plugs in behind it.
- **Honesty semantics** are already modelled and must survive: freshness/stale handling, "last known" display, commanded ≠ physically verified, SMS "modem accepted ≠ delivered", acknowledging ≠ clearing, stale hazard held open, gateway root-cause grouping, device-reported states authoritative.
- The incident engine (`DemoSource._incidentEngine`) and firmware rules (`_firmware`) are a good executable spec for the backend engine and firmware.
- `aura-ai.js` `context()` + system prompt rules + tool shapes map directly onto the backend Aura.
- Accessibility (aria-live, focus management, skip link) and design language.

### 1.4 Bugs and defects found
| # | Where | Problem |
|---|---|---|
| B1 | `aura.js` (basic mode) | Link `#incidents` targets a route that does not exist → silently lands on Home (route is `alerts`) |
| B2 | `app.js` `confirmCommand` | Always toasts "Command sent (simulated)" even if `source.command()` returns `null`/fails (`LiveSource.command` returns `null`) |
| B3 | `app.js` `loadConfig` | Any saved config with a different `version` is silently discarded (no migration) |
| B4 | `views.js` Settings | App thresholds only move chart lines; nothing else uses them — confusing until backend exists. SMS/call toggles are permanently disabled placeholders; recipients/users not editable |
| B5 | `state.js`, `views.js`, `aura-ai.js` | Sensor IDs (`mq2-hall` …) and controller keys (`esp32`/`uno`) are **hard-coded** everywhere; a real device registry needs these data-driven |
| B6 | `aura-ai.js` / `aura-view.js` | Hard dependency on `window.claude.use('sample'|'tts'|'dictation')`; hard-coded `claude.ai/artifact/...` URL; no Web Speech API recognition fallback, so voice input doesn't work outside Claude |
| B7 | `app.js` CSV export | Tries `window.claude.use('downloads')` first (artifact-only API) |
| B8 | everywhere | User is hard-coded `Demo Owner`/`owner`; no login, no roles; audit entries are in-memory only |
| B9 | `sources.js` | All state in memory: reload loses incidents, acknowledgements, commands, logs |
| B10 | template | Fonts only from Google Fonts → no offline/LAN-only or Android-offline rendering of Malayalam/Devanagari/Tamil fonts |
| B11 | inventory mismatch | Code models a mist maker (not in hardware list) and "model lighting" LEDs; SG90/MG995 purposes undecided |

### 1.5 Simulated / placeholder functionality (must be labelled or replaced)
Everything below is **simulated today**: all sensor values and history, controller heartbeats, firmware actions, GSM SMS/call lifecycle, command lifecycle, incident creation, "backend error" states, device firmware versions/RSSI, Aura AI (Claude sandbox only), voice (Claude sandbox only).

### 1.6 Missing entirely
Backend, database, auth/RBAC, MQTT/WebSocket, device registration, firmware (UNO + ESP32), wiring/power design, GSM driver, independent Aura service, Android app, push notifications, tests of any kind, lint, CI, docs beyond a 30-line README, `.env.example`, deployment.

---

## 2. Current vs required (roadmap gap matrix)

| Phase | Required | Today | Gap |
|---|---|---|---|
| 1 Frontend | Stable, responsive, consistent, simulated≠real, functional settings | Good demo, responsive, honest labels | B1–B11, registry-driven UI, login screen, live adapter, tests, lint |
| 2 Backend | REST, WS, DB, auth, RBAC, telemetry, history, incidents, commands, health, audit, config | `LiveSource` stub | **Everything** |
| 3 Hardware | UNO/ESP32 firmware, sensors, actuators w/ verification, GSM, local emergency, watchdogs, wiring | Rules exist only as JS simulation | **Everything** (and physical testing needs you) |
| 4 Aura | Independent provider, server-side keys, real data, permissioned tools, audit, voice, memory | Claude-sandbox only, client-side | Backend AI module, tool permissions, STT/TTS fallbacks |
| 5 Android | Login, dashboard, alerts, controls, Aura, push, offline | none | **Everything** |
| 6 Validation | Unit/API/DB/WS/AI/frontend/Android/HW tests, fault matrix, calibration, report | none | **Everything** |

---

## 3. Proposed final architecture

```
 ┌──────────── HOME (works with no internet) ─────────────┐        ┌──────── SERVER (LAN PC/Pi or VPS) ────────┐
 │ Arduino UNO = SAFETY CONTROLLER (5 V)                   │        │ Mosquitto (MQTT/TLS 8883, per-device auth)│
 │  MQ-2 A0, water A1, flame DO(+AO), DHT22                │  UART  │ FastAPI backend                           │
 │  relay→12V fan, buzzer, LEDs, MG995, SG90 (signals)     │◄──────►│  REST /api/v1 · WebSocket /ws             │
 │  local rules + hysteresis + debounce + AVR watchdog     │ level  │  ingest worker · incident engine          │
 │ ESP32 = COMMS GATEWAY (3.3 V)                           │ shifter│  command manager · health monitor         │
 │  UART link to UNO, Wi-Fi + MQTT, SIM800C (UART2),       │        │  audit log · config · FCM push            │
 │  offline event buffer, GSM retry, task watchdog         │──MQTT─►│  Aura module (Anthropic, tools, RBAC)     │
 └─────────────────────────────────────────────────────────┘        │ PostgreSQL 16                              │
                                                                     └──────────────┬────────────────────────────┘
                                         Web app (existing UI, LiveSource) ◄─HTTPS/WSS─┤
                                         Android (Capacitor + FCM)        ◄──────────────┘
```

### 3.1 Board responsibilities (recommended; documented in `docs/hardware-architecture.md`)
- **UNO = safety controller.** Reads all hazard sensors and drives all actuators. Rationale: MQ-2 and water modules output 0–5 V analog (native to UNO's 5 V ADC; ESP32 ADC is 3.3 V, non-linear and ADC2 is unusable with Wi-Fi); keeps the life-safety loop on the simplest, most deterministic MCU with no network stack. Runs fully standalone: smoke → buzzer + fan + red LED + door servo; flame → red LED + lights off + GSM request; all with hysteresis, N-of-M debounce, warm-up lockout, sensor-fault detection, AVR watchdog (2 s), safe boot defaults (fan off unless hazard, buzzer off, servo to defined rest).
- **ESP32 = communications gateway.** UART link to UNO, Wi-Fi/MQTT to backend, **owns the SIM800C** (UNO has one hardware UART and 2 KB RAM; SoftwareSerial conflicts with Servo timing). GSM alerts are triggered by UNO hazard events **locally**, so SMS/call work with no internet. Buffers events in a ring buffer while offline (with sequence numbers), forwards commands to UNO, reports heartbeats/RSSI/boot reason.
- **Link protocol (UNO↔ESP32):** framed ASCII `$TYPE,seq,fields…*CRC8\n` over hardware UART @ 38400, ACK/NACK + retransmit, heartbeat every 2 s both ways. UNO detects ESP32 loss (local indicator) and keeps protecting; ESP32 detects UNO loss and reports `controller_offline`.
- **Command safety:** the UNO is the final authority — remote commands are allow-listed, expire, and are rejected by local interlocks (e.g. fan cannot be switched off during smoke/cooldown; door commands disabled pending your safety review). Neither backend nor Aura can disable local protection.
- **Actuator verification:** no feedback sensors exist in the inventory, so actuators report `commanded` + `verification: unavailable`. Proposed optional add-ons (not silently added): ACS712/INA219 on the fan line, relay contact sense, servo end-stop switch → enables `verified` state.

### 3.2 Electrical/power design (to be drawn in `hardware/wiring/`)
12 V ≥3 A supply with inline fuse → (a) relay contacts → fan (+ flyback diode); (b) buck 12→5 V 3 A for UNO, sensors, relay coil, ESP32 VIN; (c) dedicated buck 12→6 V ≥3 A + 1000 µF for MG995 (stall ~2.5 A) and SG90; (d) dedicated buck to 4.0 V ≥2 A + ≥1000 µF low-ESR for SIM800C bursts. Star common ground. BSS138 bi-directional level shifter (or 1k/2k divider) on UNO TX→ESP32 RX; SIM800C logic levels verified against your breakout before wiring. No servo/GSM power from GPIO or the UNO 5 V pin. Timer notes: Servo lib takes Timer1 (PWM on D9/D10 lost) — buzzer driven as active buzzer via transistor, not `tone()`.

### 3.3 Software stack (and why)
| Concern | Choice | Why / alternatives |
|---|---|---|
| Frontend | **Keep vanilla JS + `build.py`** | Preserves all work; no framework migration. Add `LiveSource` over REST+WS, login, registry-driven sensors |
| Backend | **Python 3.12 + FastAPI**, SQLAlchemy 2 (async) + Alembic, Pydantic v2 | Typed validation, OpenAPI docs free, same language as Aura SDK. Node/Express considered: no advantage here |
| DB | **PostgreSQL 16** (plain, BRIN index on time, downsampling + retention job) | TimescaleDB adds an extension dependency not needed at this data rate |
| Device link | **MQTT (Mosquitto) over TLS**, QoS 1, retained `status` + **Last Will** = instant disconnect detection | HTTP polling from ESP32 can't signal disconnects and costs more power |
| Realtime to apps | **WebSocket** (`/ws`, JWT-authenticated, topic subscribe) | Bidirectional; works in Capacitor WebView. SSE considered: one-way |
| Auth | Argon2id password hashing, short-lived JWT access + rotating refresh tokens (httpOnly cookie on web, secure storage on Android); RBAC roles `owner/admin/member/viewer`; per-device MQTT credentials issued at registration | |
| Push | Firebase Cloud Messaging HTTP v1 (server-side service account) | Delivers when app is closed |
| Aura | Python package `ai/aura`, mounted by backend at `/api/v1/aura`; Anthropic SDK, model from `AURA_MODEL` (Anthropic model ID set by the owner), adaptive thinking, effort from `AURA_EFFORT`; streaming manual tool loop (so every tool call is permission-checked and audited); `refusal` stop reason handled; server-side refusal fallback enabled; mock provider for tests | |
| Firmware | Arduino framework (UNO: AVR core; ESP32: arduino-esp32) via PlatformIO; **safety logic in portable C++ (`hardware/common/`) unit-tested on the host with g++** | Lets the decision logic be tested here without boards |
| Android | Capacitor 7 (minSdk ≥ 28 target Android 9+), plugins: push-notifications, preferences/secure storage, network, local-notifications, native speech recognition | Reuses the web UI |
| Tests | pytest + httpx (API/DB/WS), Postgres in Docker; `node:test` for pure frontend modules (no new deps); Playwright (preinstalled) for UI e2e; host-compiled firmware logic tests; Python MQTT device simulator for integration | |

### 3.4 Simulation vs real data (hard separation)
- Browser `DemoSource` stays, renamed **Simulation mode**: persistent banner, every value tagged "simulated", cannot be active while logged into a live backend unless explicitly chosen.
- Backend devices have `kind: physical | simulated`. The Python device simulator registers as `simulated`; its readings are stored with `simulated=true`, labelled in UI/API/Aura, excluded from push notifications to real contacts and from "real" statistics.

### 3.5 Repository layout (adapting your suggested structure)
```
orion/
  frontend/        (git mv of src/, build.py, index.html — history preserved)
  backend/         app/ (api, core, models, services, mqtt, ws), alembic/, tests/
  ai/aura/         provider interface, anthropic adapter, mock, tools, policy, prompts, tests
  hardware/        common/ (portable safety core + host tests), arduino_uno/, esp32/,
                   communication/ (protocol spec, MQTT topics, Python device simulator), wiring/
  android/         Capacitor project
  database/        ERD, seed scripts, retention policy
  tests/           cross-component e2e + hardware-in-the-loop scripts
  docs/            the 20 required documents + HANDOFF.md + audit (this document)
  scripts/  deployment/ (docker-compose, mosquitto, Caddy TLS)  .env.example  README.md
```

---

## 4. Phase-by-phase plan (each phase: implement → test → document → checkpoint commit/tag)

### Phase 0 — Repository bootstrap (first action after approval)
1. Commit the untouched zip contents to `main`, tag `v0.1-prototype`, push.
2. Create and push `dev`. All later commits go to `dev`.
3. Add `.gitignore`, `.env.example` (placeholders only), `docs/AUDIT.md` (this audit), `docs/HANDOFF.md`.

### Phase 1 — Stable frontend (fully doable in this environment)
- `git mv src build.py index.html → frontend/`; keep `build.py` single-file output.
- Fix B1, B2, B3 (config migration), B7 (plain Blob download), B6 partial (remove hard-coded artifact URL; capability detection that works outside Claude; Web Speech API `SpeechRecognition` fallback for voice input where the browser supports it).
- Data-driven registry: replace hard-coded sensor/controller IDs with a `devices` list in the snapshot (DemoSource emits the same shape the backend will) — touches `state.js`, `views.js`, `aura-ai.js`, `aura.js`.
- Rename Demo → "Simulation mode" with unmistakable labelling (banner, tags, CSV `source` column, Aura context).
- Settings: separate "this browser" vs "server" settings; validation kept; recipients/contacts UI (disabled until backend).
- Error boundaries in `onData`/view updates; toast on failures.
- Self-host fonts fallback (system fonts if Google Fonts unreachable).
- Tooling: `frontend/package.json` (devDeps only: eslint), `node:test` unit tests for `state.evaluate`, `fmt`, `esc`, incident engine; Playwright e2e (routes × viewports × scenarios, no console errors, no overflow, stale never shows NORMAL).
- **Exit gate:** build reproducible, lint clean, unit + e2e pass at 390/768/1280 px.

### Phase 2 — Backend + realtime (doable here; Postgres via Docker)
- Schema (Alembic): users, roles, refresh_tokens, homes, devices (kind, controller, credentials hash, firmware), sensors, telemetry (time, value, quality, seq, simulated), controller_heartbeats, incidents + incident_events + incident_actions, acknowledgements, commands + command_history, gsm_attempts, notification_contacts (encrypted/masked numbers), config_versions, audit_log, aura_conversations/messages, user_preferences.
- Services: MQTT ingest (validation, seq-gap detection, clock-skew check), freshness/health monitor (stale sensors and missing heartbeats raise incidents — a disconnected sensor is never "healthy"), incident engine ported from `DemoSource._incidentEngine` with shared JSON test vectors to keep parity with `state.js`, command manager (allow-list, expiry, interlock awareness, lifecycle requested→queued→sent→accepted/rejected→executed_unverified/verified/expired), GSM status tracking, config management with versioning, audit log on every mutation.
- API `/api/v1`: auth (login/refresh/logout, users CRUD by owner), devices (register → one-time MQTT credentials, status), sensors/latest, telemetry history (downsampled), incidents (active/history/ack), commands, controllers/health, gsm, config, audit, system health; OpenAPI docs. Rate limiting, CORS allow-list, input validation, security headers.
- WebSocket `/ws`: authenticated; events for sensor update, incident opened/escalated/cleared, device online/offline, actuator state change, command step, GSM attempt update.
- Python MQTT **device simulator** (flagged `simulated`) for integration tests and demos.
- Frontend `LiveSource` implemented on REST+WS with reconnect/backoff and OFFLINE handling.
- `deployment/docker-compose.yml`: postgres, mosquitto (TLS + ACL), backend, Caddy (HTTPS).
- **Exit gate:** pytest (unit/API/DB/auth/RBAC/WS) green; e2e: simulator → MQTT → DB → WS → web UI shows `simulated` data; kill simulator → UI goes stale/DEGRADED/OFFLINE within configured times.

### Phase 3 — Hardware integration (code here; physical verification needs you)
- `hardware/common/`: portable C++ safety core (sensor validation, warm-up lockout, hysteresis, N-of-M flame debounce, rail-stuck/disconnect heuristics, DHT22 retry/freshness, actuator state machine, protocol codec + CRC) with host unit tests.
- `arduino_uno/`: drivers + safety loop + watchdog + link protocol. `esp32/`: Wi-Fi/MQTT TLS client with LWT, offline buffer, SIM800C driver (AT state machine: power/SIM/`CREG`/`CSQ` diagnostics, SMS with `+CMGS` = "accepted", optional delivery reports via `AT+CNMI`/status report when network supports, calls with timeout, retry/backoff, contacts from config), OTA-safe config, task watchdog.
- Wiring diagrams, BOM, calibration procedure, bench test scripts (serial log capture → test report).
- **Exit gate (here):** firmware compiles for both boards (needs toolchain hosts allowlisted — see §6), host tests pass, simulator-in-the-loop passes. **Physical exit gate (you):** bench procedure run on real boards, results recorded; nothing claimed as physically verified until then.

### Phase 4 — Independent Aura
- Provider interface + Anthropic adapter + mock; streamed responses to frontend; server-built context from DB (never client-supplied readings).
- Tools: `get_system_status, get_sensor_readings, get_device_status, get_alerts, get_incident_history, get_gsm_status, get_controller_health, open_dashboard_page` (returned as a UI action), `propose_device_command` (creates a pending proposal; execution requires a separate authenticated user confirmation; role-checked; audited).
- Deterministic safety layer outside the model: active critical incident → emergency guidance (112 / 101) is prepended server-side even if the AI call fails; Aura cannot change config, thresholds, policies or disable protection; missing/stale data always stated.
- Memory separation: conversation history (per user, retention limit), user preferences (set by the user via UI, not by the model), read-only access to config/incidents/logs.
- Voice: browser/Android native STT + TTS, language selection (14 languages kept), voice settings; offline rule-based fallback (`aura.js`) when provider unavailable.
- **Exit gate:** tool permission tests, prompt-injection tests (e.g. telemetry strings can't trigger commands), mock-provider conversation tests; live API smoke test only once you supply a key.

### Phase 5 — Android (Capacitor)
- Wrap `frontend/` build; native secure token storage; FCM push for smoke/flame/water/critical temp/sensor & controller disconnect/GSM failure (with timestamp, type, device); notification channels with high importance for emergencies; network-change reconnect; offline state; native speech.
- **Exit gate:** debug APK builds; unit + instrumentation tests where SDK/emulator available; push verified end-to-end once Firebase project exists.

### Phase 6 — Testing & safety validation
- Consolidated automated suite + CI workflow; fault-injection matrix (your 16 scenarios) — software-side via simulator, physical via documented bench procedures you run; false-positive/negative evaluation method; calibration & maintenance docs; validation report containing **only actual results**, with "prototype, not certified" stated throughout.

### Documentation deliverables
The 20 documents you listed, written incrementally per phase under `docs/`, plus `docs/HANDOFF.md` updated at the end of every work session (progress, decisions, open issues, next steps).

---

## 5. Hardware & dependency requirements

**From you (cannot be done from this cloud session):**
- Physical wiring and bench testing; reporting serial logs/results back.
- Module details: flame sensor (3-pin DO or 4-pin DO+AO), water sensor type, relay module channel count & active level, SIM800C breakout model (logic level, power pins), DHT22 bare or module, buzzer active/passive, servo purposes (MG995 door, SG90 = ?).
- Power supplies on hand (12 V rating), buck converters, BSS138 level shifter, capacitors, fuses (BOM will list what is missing).
- A **2G-capable SIM** (SIM800C is 2G-only; Jio won't register) and emergency contact numbers — entered in the app, never committed.
- Anthropic API key (Phase 4) — provided through the environment's secret store, never in chat or git.
- Firebase project + `google-services.json` + FCM service account (Phase 5).
- Where the backend will run (LAN PC/Raspberry Pi vs VPS) — compose file supports both; decide before Phase 2 deployment docs are finalised.

**Software:** Python 3.12 (available), Node 22 (available), Docker (client present; daemon to be confirmed at Phase 2 start — fallback: Postgres from pip/apt), Java + Gradle (present), Playwright/Chromium (present).

## 6. Environment limitations found (honest)
- This session's network policy **blocks** `downloads.arduino.cc`, PlatformIO registries, GitHub release assets and `dl.google.com` (Android SDK). Firmware compilation (Phase 3) and APK builds (Phase 5) need those hosts allow-listed; I will request that via an environment-change prompt when those phases start. Until then, firmware logic is tested via host-compiled C++.
- No physical hardware is attached; Phase 3/6 physical results can only come from your bench tests.

## 7. Verification approach (every phase)
- Phase report listing: files created/modified, features, decisions, commands, tests run with real output, failures, remaining issues, next steps.
- Commands (established in Phase 1/2): `python3 frontend/build.py`, `node --test frontend/tests`, `npx playwright test` (with `--trace off`), `docker compose -f deployment/docker-compose.yml up`, `pytest backend ai`, `g++ … && ./hardware/common/tests`.
- Three explicit evidence levels in every report: **code complete**, **simulated/automated-test verified**, **physically verified** (only with your bench data).

## 8. Realistic scope per session
This session: Phase 0, Phase 1 complete, and Phase 2 as far as possible (schema, auth, ingest, incidents, WS, simulator, LiveSource), with `HANDOFF.md` kept current. Phases 3–6 continue in later sessions with the gates above.
