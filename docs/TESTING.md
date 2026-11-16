# Testing

## Commands

| Suite | Command | Needs |
|---|---|---|
| Frontend lint | `cd frontend && npm ci && npm run lint` | Node 20+ |
| Frontend unit (27) | `cd frontend && npm test` | Node 20+ |
| Frontend browser e2e (18, incl. Android bridge) | `cd frontend && npm run test:e2e` | Playwright + Chromium |
| Firmware logic (20 / 101 checks) | `make -C hardware/lib/OrionCore/test` | g++ |
| Firmware builds | `cd hardware/arduino_uno && pio run`, `cd hardware/esp32 && pio run` | PlatformIO |
| Android build | `cd android && npm ci && npm run build:debug` | JDK 21, Android SDK 35 |
| Settings system test (contacts → gateway → SMS, people, devices, audit) | `node --test tests/system/settings.system.test.js` (same env as below, owner account) | server + simulator |
| Aura system test | `node --test tests/system/aura.system.test.js` (same env as below, server with `AURA_PROVIDER=mock`) | server |
| Backend (57) | `cd backend && pytest` | PostgreSQL with an `orion_test` database (`ORION_DATABASE_URL` to override); the MQTT test also needs an anonymous dev broker on localhost:1883 (skipped otherwise) |
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
| Frontend e2e (390 / 768 / 1280 px + Android bridge) | **18 / 18 passed** |
| Settings system test | **6 / 6** — a contact added in the app reached the (simulated) gateway and the flame SMS went to it |
| Backend pytest | **57 tests: 57 passed** (MQTT round-trip needs an anonymous dev broker) (incl. real-broker round trip, Aura, push) |
| Firmware host tests (ASan + UBSan) | **20 tests / 101 checks passed** |
| Firmware builds | UNO and ESP32 compile with 0 warnings |
| Android | debug APK builds (4.9 MB) |
| Aura system test (scripted provider) | **3 / 3** |
| Dependency audits | 0 known vulnerabilities |
| Full-stack system test | **8 / 8 steps passed** — sign-in; live tiles labelled simulated; flame → EMERGENCY with firmware actions and SMS "sent" (not "delivered"); acknowledge keeps alert active; clear only after clear-hold; fan command ends "done · unconfirmed"; fan-off rejected by interlock during smoke; UNO link loss → one controller incident, no per-sensor noise |
| Gateway power loss (simulator killed) | UI → **OFFLINE in 0.3–0.4 s** via broker last-will, reason "gateway disconnected (last heard 0 s ago)" |
| Broker auth/ACL (Mosquitto 2.1.2) | wrong password ✗, anonymous ✗, cross-gateway publish dropped, gateway cannot publish commands, gateway receives only its own commands |
| Production Docker Compose stack (`ORION_ENV=production`, broker passwords + ACL on) | full-stack system test **8 / 8** again; simulator logged in with its own broker credentials; backend reconnected by itself after a broker restart |
| Docker image | builds (verified with the sandbox CA added in a throwaway Dockerfile, because this sandbox intercepts TLS); boots on Python 3.12, migrates, serves `/`, HSTS in production |

### What these results do NOT show

- **No physical hardware was involved.** All device behaviour came from the simulator, which mirrors the planned
  firmware rules but is not the firmware.
- No TLS (HTTPS/MQTTS) test, no load or soak test, no test on a phone, no test against the real AI API.
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

## Phase 6

The 16 fault scenarios, what is covered automatically and the bench procedures still to run are in
[VALIDATION.md](VALIDATION.md). CI (`.github/workflows/ci.yml`) runs every suite above on each push; it has not run
yet (the session cannot trigger GitHub Actions).
