# Running the ORION server on a Windows laptop

For a Windows 10/11 laptop with 8 GB RAM or more. The laptop runs the server; the phone app reaches it from
anywhere through a free **Tailscale Funnel** address (`https://<laptop>.<tailnet>.ts.net`); the ESP32 reaches the
broker directly over home Wi-Fi.

## Install (once)

1. Download `scripts/windows/Install-ORION.cmd` and `scripts/windows/install-orion.ps1` into the same folder
   (or the whole repository) and double-click **Install-ORION.cmd**. Allow the administrator prompt.
2. The script installs Git, Docker Desktop and Tailscale. **After Docker Desktop is installed it asks you to restart
   Windows — restart and double-click it again.** On the second run:
   - Docker Desktop may show a licence/survey window: accept or skip it.
   - A browser opens for Tailscale: sign in (free account) and approve the laptop.
   - It asks for the owner email and password you will sign in with, and optionally your Anthropic key + Claude
     model ID and a Google Cloud API key for voice. These are typed only on the laptop and stored in
     `%USERPROFILE%\ORION\.env` (readable only by your Windows account).
   - When Tailscale shows a link to enable **Funnel/HTTPS**, open it and allow it.
3. At the end it prints the **app address** and the **ESP32 broker address**. Enter the app address in the phone
   app; use the broker address when you register the gateway (Settings → Registered devices).

Running the script again is safe: it skips finished steps, updates the ORION files and keeps your `.env`.

## What it changes on the laptop

| Change | Why | Undo |
|---|---|---|
| Installs Git, Docker Desktop, Tailscale | run and publish the server | Settings → Apps |
| `%USERPROFILE%\ORION` | ORION files + `.env` | delete the folder |
| Scheduled task **ORION server** (at sign-in) | starts Docker Desktop, ORION and the public address | Task Scheduler → delete |
| Firewall rule **ORION broker (home network)**, TCP 1883, private networks only | ESP32 → broker | Windows Defender Firewall → Inbound rules |
| Optional: Wi-Fi set to *Private* | firewall rule applies at home only | Settings → Network → Wi-Fi → properties |
| Optional: no sleep on charger, lid close does nothing on charger | keeps ORION online | Control Panel → Power Options |

## Day to day

- Turn on / sign in → ORION is back within about a minute. Waking from sleep → a few seconds.
- Asleep or off → the app shows the server as unreachable; the UNO/ESP32 keep alarms, fan and SMS/calls working.
  Readings from that time are not recorded (history shows a gap).
- Windows only starts the task after you **sign in** (Docker Desktop needs a signed-in user).
- Log: `%USERPROFILE%\ORION\orion-start.log`. Status: open `https://<your address>/api/v1/health`.
- Stop: `docker compose -f deployment\docker-compose.yml --env-file .env down` in the ORION folder (data is kept).
- Update: run Install-ORION.cmd again, then `docker compose ... up -d --build`.
- Backup the database: `docker compose -f deployment\docker-compose.yml exec db pg_dump -U orion orion > backup.sql`.

## Router

Reserve the laptop's address for it in your router (DHCP reservation). The ESP32's setup code contains it; if it
changes, the gateway can't find the broker until you re-run the setup code with the new address.

## Limits / not tested

- These scripts have **not been run on a real Windows machine yet** (they were written and reviewed, but this
  development environment could not run PowerShell). Expect to report the first run's messages if something stops.
- The public address exposes only the web app/API (port 8000, HTTPS). The broker is not on the internet.
- Behind Tailscale Funnel, all visitors may appear to come from one address, so sign-in rate limits are shared.
- Tailscale Funnel is free for personal use at the time of writing; check Tailscale's current terms.
