# Android app (Phase 5)

The app is the ORION web app inside a Capacitor 7 shell (`android/`), plus native push notifications, speech and
network handling (`frontend/src/native.js`). Same backend, same accounts, same screens.

Status (2026-11-16): **debug APK builds** (4.9 MB; min Android 6.0 / API 23 — covers Android 9; target API 35).
**Not yet run on a phone or emulator, and push is untested end to end** (needs your Firebase project).

## Build

Needs Node 20+, JDK 21, Android SDK (platform 35, build-tools 35).

```bash
cd android && npm ci
```

```bash
npm run sync          # rebuilds frontend/index.html and copies it into the app
```

```bash
cd android && ./gradlew assembleDebug     # → android/app/build/outputs/apk/debug/app-debug.apk
```

Install on a phone: enable *Install unknown apps*, copy the APK, open it — or `adb install app-debug.apk`.
A release build needs your own signing key (`./gradlew bundleRelease` + a keystore you keep out of git).

## Connecting to your server

1. In the app: **Settings → Data → ORION server**: `https://your-server` (the app has no address of its own).
2. On the server, allow the app's origin: `ORION_CORS_ORIGINS=https://localhost` (add it next to any others).
3. The app runs as an `https` page, so Android blocks plain `http://` servers. Use HTTPS (Caddy profile in
   `deployment/`). **LAN-only testing** with plain HTTP: set `"server": {"androidScheme": "http", "cleartext": true}`
   in `android/capacitor.config.json`, run `npm run sync`, rebuild — and switch back before real use.

## Push notifications (Firebase Cloud Messaging)

You need a Firebase project (free):

1. Firebase console → add project → add an **Android app** with package name `org.orion.homesafety`.
2. Download `google-services.json` into `android/android/app/` (git-ignored) and rebuild the APK.
3. Project settings → Service accounts → **Generate new private key** → save the JSON **on the server, outside the
   repository**.
4. Server `.env`: `FCM_PROJECT_ID=<project id>` and `FCM_SERVICE_ACCOUNT_FILE=/path/to/that.json`. Restart.
5. Sign in on the phone and allow notifications. `GET /api/v1/push/status` → `{"enabled": true}`.

What is pushed: smoke, flame, water, high temperature (when an advisory is set), sensor stopped/fault, controller
offline, GSM unavailable — with type, place, severity and time. Critical alerts use the high-importance
"ORION emergencies" channel. Each user can turn levels off (`/api/v1/aura/preferences` → `push`).
Simulated incidents are **not** pushed (set `PUSH_SIMULATED=true` on the server to test the path with the simulator).
Push is delivered by Google when the app is closed. It is a convenience — ORION's local alarm and SMS never depend on it.

## Native features

| Feature | Implementation |
|---|---|
| Sign-in | "mobile" flow: refresh token in app-private storage (Capacitor Preferences), rotated on every use, revoked on sign-out |
| Live data / offline | same as the web app: WebSocket + re-fetch; reconnects when the network returns (Network plugin) |
| Aura voice | Android speech recognition and text-to-speech (community plugins); languages depend on the phone's installed voices |
| Notifications | FCM, two channels, tap opens Alerts |

Limitation: the refresh token is protected by Android's app sandbox, not by the hardware keystore. A keystore-backed
plugin can replace `Preferences` later without server changes.
