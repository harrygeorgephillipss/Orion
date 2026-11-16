# Testing

## Commands

| Suite | Command | Needs |
|---|---|---|
| Frontend lint | `cd frontend && npm ci && npm run lint` | Node 20+ |
| Frontend unit (27) | `cd frontend && npm test` | Node 20+ |
| Frontend browser e2e (16) | `cd frontend && npm run test:e2e` | Playwright + Chromium |
| Backend (42) | `cd backend && pytest` | PostgreSQL with an `orion_test` database (`ORION_DATABASE_URL` to override); the MQTT test also needs an anonymous dev broker on localhost:1883 (skipped otherwise) |
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
| Frontend e2e (390 / 768 / 1280 px) | **16 / 16 passed** |
| Backend pytest | **42 / 42 passed** (incl. real-broker round trip) |
| Full-stack system test | **8 / 8 steps passed** — sign-in; live tiles labelled simulated; flame → EMERGENCY with firmware actions and SMS "sent" (not "delivered"); acknowledge keeps alert active; clear only after clear-hold; fan command ends "done · unconfirmed"; fan-off rejected by interlock during smoke; UNO link loss → one controller incident, no per-sensor noise |
| Gateway power loss (simulator killed) | UI → **OFFLINE in 0.3–0.4 s** via broker last-will, reason "gateway disconnected (last heard 0 s ago)" |
| Broker auth/ACL (Mosquitto 2.1.2) | wrong password ✗, anonymous ✗, cross-gateway publish dropped, gateway cannot publish commands, gateway receives only its own commands |
| Production Docker Compose stack (`ORION_ENV=production`, broker passwords + ACL on) | full-stack system test **8 / 8** again; simulator logged in with its own broker credentials; backend reconnected by itself after a broker restart |
| Docker image | builds (verified with the sandbox CA added in a throwaway Dockerfile, because this sandbox intercepts TLS); boots on Python 3.12, migrates, serves `/`, HSTS in production |

### What these results do NOT show

- **No physical hardware was involved.** All device behaviour came from the simulator, which mirrors the planned
  firmware rules but is not the firmware.
- No TLS (HTTPS/MQTTS) test, no load test, no long-running soak test, no Android test, no AI test.
- Bugs the tests caught during development (fixed): command toast claimed success when nothing was sent; live
  source threw instead of reporting "not sent" when the server was unreachable; never-reported sensors raised
  false "stopped reporting" alerts during start-up; the last-will handler faked the last-seen time; two backend
  instances shared an MQTT client id and disconnected each other.
- Found and fixed in the re-check pass (each now has a regression test): a disconnected or faulty flame/water
  sensor was shown as a green "None"/"Dry"; water/flame tiles ignored the controller's alarm state when a raw field
  was missing; on a live server running the simulator, Aura called the data "live hardware telemetry" and CSV
  export labelled it "hardware"; Live mode gave up if the server was down when the page opened; an admin could
  promote users to admin or disable other admins; password changes and disabling a user didn't end other
  sessions; a retained "online" message made a dead gateway look online after a server restart; devices could
  store arbitrary extra fields; invalid time zones were accepted; **the compose broker could not read its 0600
  password file and crashed on start** (now copied in with the right owner; packet size capped at 64 KB).

## Phase 6 (planned)

Fault-injection matrix for the 16 hardware scenarios in the brief, Android tests, AI tool-permission tests,
calibration procedures and a validation report with bench data — none of which exist yet.
