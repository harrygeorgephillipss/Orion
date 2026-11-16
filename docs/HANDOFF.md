# Development handoff

Last updated: 2026-11-16 · branch `dev`. Read this first, then [README.md](../README.md) and [VALIDATION.md](VALIDATION.md).

## Owner decisions (don't re-ask)

- Repo: untouched prototype is commit `8e4f04b`; all work on `dev`. The cloud session could not push `main`/tags
  (git policy) — create `main` from `8e4f04b` on GitHub, then merge `dev` by PR when happy.
- Aura: Anthropic API behind a provider interface; model set by the owner (`AURA_MODEL`).
- Android: Capacitor wrapping the web UI. Mist maker: disabled placeholder.
- Architecture: UNO = safety controller (all sensors/outputs), ESP32 = gateway (Wi-Fi/MQTT + SIM800C).
- The owner's personal email/phone are **not** stored in the repo: email goes in their `.env`
  (`ORION_BOOTSTRAP_OWNER_EMAIL`), phone numbers as emergency contacts / ESP32 `secrets.h`.

## State

| Phase | State | Evidence |
|---|---|---|
| 1 Web app | done | lint, 27 unit, 18 e2e |
| 2 Backend | done | 55 backend tests, full-stack system test 8/8 (also on production compose stack) |
| 3 Firmware | code done | 20 host tests / 101 checks; UNO + ESP32 compile — **never run on boards** |
| 4 Aura | code done | 10 backend tests + UI test 3/3 with scripted provider — **real API untested (no key)** |
| 5 Android | code done | debug APK builds; bridge tests 2/2 — **never run on a phone; push needs Firebase** |
| 6 Validation | partly | CI workflow, audits clean, scenario map in VALIDATION.md — **no bench data** |

## What only the owner can do next

1. Wire the hardware per [WIRING_AND_BOM.md](WIRING_AND_BOM.md); set module polarities in `hardware/arduino_uno/src/main.cpp`.
2. Flash both boards ([FIRMWARE.md](FIRMWARE.md)); register the gateway; add its broker password.
3. Run the bench procedures in [VALIDATION.md](VALIDATION.md) and [CALIBRATION.md](CALIBRATION.md); record results.
4. Provide an Anthropic API key (server `.env`) to test Aura for real.
5. Create a Firebase project, add `google-services.json`, set `FCM_*` on the server ([ANDROID.md](ANDROID.md)); install the APK.

## Environment notes (cloud sessions)

- Session environment "orion" allows the PlatformIO registry, `dl.google.com` and Gradle hosts (needed for firmware
  and Android builds). Maven Central may rate-limit (HTTP 429): rerun Gradle with `--max-workers=1`.
- Docker builds in the sandbox need the sandbox CA (see TESTING.md); the committed Dockerfile is clean.

## Resume

```bash
git clone https://github.com/harrygeorgephillipss/Orion.git && cd Orion && git checkout dev
```

Then [BACKEND.md](BACKEND.md) (Option B) and [TESTING.md](TESTING.md). Expected: everything in the table above passes.

## Conventions

- Snapshot shape: `DemoSource.snapshot()` and `backend/app/services/snapshot.py:overview()` must stay in sync.
- Never present simulated data without the `simulated` flag; never mark an output "verified" without feedback.
- Commit messages end with the Co-Authored-By / Claude-Session lines; keep AI model IDs out of repo files.
