# Testing

## Commands

| Suite | Command | Needs |
|---|---|---|
| Frontend lint | `cd frontend && npm ci && npm run lint` | Node 20+ |
| Frontend unit (27) | `cd frontend && npm test` | Node 20+ |
| Frontend browser e2e (12) | `cd frontend && npm run test:e2e` | Playwright + Chromium |
| Backend (37) | `cd backend && pytest` | PostgreSQL with an `orion_test` database (`ORION_DATABASE_URL` to override); the MQTT test also needs a broker on localhost:1883 (skipped otherwise) |
| Full-stack system test | see below | server + broker + simulator |

### Full-stack system test

Real processes: browser → backend → Mosquitto → device simulator.

```bash
mkfifo /tmp/simctl
```

```bash
tail -f /tmp/simctl | backend/.venv/bin/python hardware/communication/sim_device.py --username esp32-sim --password '<from registration>'
```

```bash
cd frontend && ORION_URL=http://localhost:8000/ ORION_EMAIL=<member+ account> ORION_PASSWORD=<password> ORION_SIM_CTL=/tmp/simctl node --test tests/system/live.system.test.js
```

(The simulator must be registered as `hardware/communication/sim_gateway.json` — see [BACKEND.md](BACKEND.md#device-simulator).)

## Results — 2026-11-16 (this session)

Environment: Linux container, Python 3.13 (backend tests), Python 3.12 (Docker image boot), Node 22,
PostgreSQL 16, Mosquitto 2.1.2, headless Chromium (Playwright).

| Suite | Result |
|---|---|
| ESLint (src + tests) | clean |
| Frontend unit | **27 / 27 passed** |
| Frontend e2e (390 / 768 / 1280 px) | **12 / 12 passed** |
| Backend pytest | **37 / 37 passed** (incl. real-broker round trip) |
| Full-stack system test | **8 / 8 steps passed** — sign-in; live tiles labelled simulated; flame → EMERGENCY with firmware actions and SMS "sent" (not "delivered"); acknowledge keeps alert active; clear only after clear-hold; fan command ends "done · unconfirmed"; fan-off rejected by interlock during smoke; UNO link loss → one controller incident, no per-sensor noise |
| Gateway power loss (simulator killed) | UI → **OFFLINE in 0.3–0.4 s** via broker last-will, reason "gateway disconnected (last heard 0 s ago)" |
| Broker auth/ACL (Mosquitto 2.1.2) | wrong password ✗, anonymous ✗, cross-gateway publish dropped, gateway cannot publish commands, gateway receives only its own commands |
| Docker image | builds (verified with the sandbox CA added in a throwaway Dockerfile, because this sandbox intercepts TLS); boots on Python 3.12, migrates, serves `/`, HSTS in production |

### What these results do NOT show

- **No physical hardware was involved.** All device behaviour came from the simulator, which mirrors the planned
  firmware rules but is not the firmware.
- No TLS (HTTPS/MQTTS) test, no load test, no long-running soak test, no Android test, no AI test.
- Bugs the tests caught during development (fixed): command toast claimed success when nothing was sent; live
  source threw instead of reporting "not sent" when the server was unreachable; never-reported sensors raised
  false "stopped reporting" alerts during start-up; the last-will handler faked the last-seen time; two backend
  instances shared an MQTT client id and disconnected each other.

## Phase 6 (planned)

Fault-injection matrix for the 16 hardware scenarios in the brief, Android tests, AI tool-permission tests,
calibration procedures and a validation report with bench data — none of which exist yet.
