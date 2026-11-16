# Validation report (Phase 6)

Date: 2026-11-16 · branch `dev`. **ORION is a prototype. It is not certified and must not be relied on as a fire,
gas or flood alarm.** Certification and physical safety validation are tracked separately and have **not** been done.

## Evidence levels

| Level | Meaning |
|---|---|
| **A — automated** | an automated test in this repository passed (software, simulator, host-compiled firmware logic) |
| **B — built** | code compiles for the real target (AVR / ESP32 / Android) — not executed there |
| **P — physical** | verified on real hardware with recorded bench data — **nothing has reached this level yet** |

## Automated results (this session)

| Suite | Result |
|---|---|
| Frontend lint · unit · browser e2e (390/768/1280 px, incl. Android bridge) | clean · 27/27 · 18/18 |
| Backend (API, DB, auth/RBAC, WebSocket, MQTT broker round-trip, incident engine, commands, Aura, push) | 55/55 |
| Firmware logic on host (ASan + UBSan) | 20 tests / 101 checks |
| Full-stack system test (browser → server → Mosquitto → device simulator) | 8/8 — also on the production Docker stack with broker auth |
| Aura through the web UI (scripted provider) | 3/3 |
| Firmware build for ATmega328P / ESP32 | UNO 486 B RAM (24 %), 9.2 KB flash · ESP32 18 % RAM, 71 % flash |
| Android debug APK | builds, 4.9 MB, API 23–35 |
| Dependency audit (pip-audit, npm audit ×2) | 0 known vulnerabilities |

## The 16 fault scenarios from the brief

| # | Scenario | What is covered automatically (A) | Physical bench procedure (P) — still to do |
|---|---|---|---|
| 1 | MQ-2 smoke | firmware: warm-up lockout, hysteresis, buzzer/fan/door/LED, cooldown, critical escalation; system test: incident, actions, clear-hold | incense/lighter-gas test per CALIBRATION.md; record peak, time to alarm, outputs |
| 2 | Flame | firmware: 4-of-5 debounce, lights off, one SMS+call request per episode; system test: EMERGENCY + SMS "sent" | candle at measured distance; time to alarm; SMS received on phone |
| 3 | Water leak | firmware hysteresis, submerged = wet; system test water scenario | drops / submersion; time to alert |
| 4 | DHT22 disconnection | firmware: 3 failures → fault, 10 s freshness; simulator `dht_fault` / `dht_stale`; UI never shows healthy | unplug DATA wire; app shows fault/stale within 30 s |
| 5 | ESP32 disconnection | broker last-will → OFFLINE in 0.3–0.4 s (system test); UNO fault blink on link loss (firmware) | power off ESP32; app OFFLINE; UNO keeps alarming locally |
| 6 | Arduino UNO disconnection | one controller incident, no per-sensor noise (system test); ESP32 rejects commands "UNO not reachable" (code) | unplug UNO TX; app shows UNO not responding |
| 7 | Wi-Fi failure | equivalent to #5 for the server; ESP32 offline buffer for events/GSM (code, **not executed**) | switch router off during a test alarm; SMS still sent; events appear after reconnect |
| 8 | Backend failure | web app retries with back-off and shows OFFLINE (e2e); firmware has no server dependency (by design) | stop the server during a test alarm; local outputs + SMS unaffected |
| 9 | GSM network failure | SIM800C driver: unregistered → "failed", never "sent" (host test); GSM incident (backend test) | remove antenna/SIM; app shows GSM incident; attempts fail honestly |
| 10 | SIM800C power interruption | driver power-cycles a silent modem (host test) | unplug SIM800C supply; observe recovery and reporting |
| 11 | Servo failure | **not detectable** — no position feedback; UI says "position not sensed" | disconnect servo; confirm app never claims the door moved |
| 12 | Relay failure | **not detectable** — no contact sense; reported as commanded only | disconnect relay; confirm "done · unconfirmed" only |
| 13 | Exhaust fan failure | **not detectable** without a current sensor (optional ACS712/INA219) | — |
| 14 | Power supply interruption | safe boot defaults + watchdog (code); reboot reason reported | cut 12 V during alarm; on return: safe defaults, alarm resumes if hazard persists |
| 15 | Stale readings | state engine + incident engine: stale never NORMAL, hazard held open (unit + backend tests) | stop UNO telemetry; app shows stale, alert held |
| 16 | Controller restart during an emergency | **fixed in this phase**: a watchdog/brown-out reset no longer re-enters the 3-min MQ-2 lockout (host test); flame needs no warm-up | force a watchdog reset while the MQ-2 is in alarm; alarm must resume within a second |

## Emergency validation checklist (for the bench session)

- [ ] Local alarm works with Wi-Fi, server and phone all off (scenarios 7, 8)
- [ ] Alerts generated correctly for smoke, flame, water (1–3)
- [ ] Actuators respond per policy; failed actuators are never reported as working (11–13)
- [ ] Communication recovers after Wi-Fi/server/GSM outages (5–10)
- [ ] Incidents retained across server restarts (PostgreSQL persistence — automated tests cover storage)
- [ ] Power loss and restart handled safely (14, 16)
- [ ] False positives/negatives measured (below)

## False positives and false negatives (method)

For each sensor run at least: 20 trials with the stimulus (record detected / missed, time to alarm) and 24 h of
normal household activity including cooking, bathing and cleaning (record any alarm). Report detection rate,
false-alarm count per day and time-to-alarm distribution. **No such data exists yet.**

## Calibration

Procedures in [CALIBRATION.md](CALIBRATION.md). All thresholds are placeholders until those measurements are
recorded. No calibration values have been invented.

## Bench results

| Date | Scenario | Setup | Result | Notes / logs |
|---|---|---|---|---|
| — | — | — | — | *no physical tests have been run yet* |
