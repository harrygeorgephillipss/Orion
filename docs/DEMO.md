# ORION — demo day checklist

## What exists (all on the `dev` branch)

| Part | State |
|---|---|
| Web app + Android app (same UI) | Home, History, Alerts, Devices, Aura, Settings; live updates over WebSocket |
| Cloud server (Google Cloud VM) | FastAPI + PostgreSQL + Mosquitto + Caddy HTTPS, auto-start, `https://<ip-with-dashes>.sslip.io` |
| Aura | Claude (server-side key) with live sensor tools; emergency guidance added by the server; if Claude is unavailable it still answers from its offline mode with the same readings |
| Voice | Mic + spoken replies; Google speech on the server (VM identity) or the phone's own voice; EN / ML / HI |
| ESP32 gateway firmware | Wi-Fi setup page (setup code), MQTT to the server (TLS on 8883 for the cloud), SIM800C SMS/calls, offline event buffer |
| Arduino UNO firmware | Reads MQ-2, flame, water, DHT22; runs the alarms locally (buzzer, fan, LEDs, servo) — no server needed |
| Simulated home | One click on Home; realistic readings through the real server path, labelled "simulated" |

## Before the demo (10 minutes)

1. Server up to date (SSH):
   `cd /opt/orion && sudo git pull && sudo docker compose --profile https -f deployment/docker-compose.yml --env-file .env up -d --build`
2. Aura: `sudo bash /opt/orion/scripts/cloud/check-aura.sh` → **WORKS**. If not: new key from console.anthropic.com →
   API keys (starts `sk-ant-api03-`) → `sudo bash /opt/orion/scripts/cloud/set-keys.sh`.
3. Voice (optional): `sudo bash /opt/orion/scripts/cloud/enable-google-voice.sh` → both **WORKS**.
4. Open the app, sign in, Home shows "All good" (or the connect guide if nothing is registered).

## Connecting the real ESP32 + UNO

1. Flash `hardware/arduino_uno` to the UNO and `hardware/esp32` to the ESP32 (PlatformIO: `pio run -t upload` in each folder).
   Wire UNO TX→(level shifter)→ESP32 GPIO16, ESP32 GPIO17→UNO RX, common ground (docs/WIRING_AND_BOM.md).
2. App → Home → **Register my ESP32** (or Settings → Registered devices) → fill ids → **Register**. Copy the setup code.
   The server address (your sslip.io name) and port 8883 are filled in.
3. Power the ESP32. First start (or hold BOOT 5 s): it opens Wi-Fi **ORION-Setup-XXXX**, password `orion-setup`.
   Join it with the phone; the setup page opens (or go to 192.168.4.1). Pick home Wi-Fi, paste the setup code, Save.
4. Within ~30 s the gateway shows **Online** and readings appear on Home. MQ-2 shows "warming up" for ~3 minutes.

The ESP32 needs internet over Wi-Fi (a phone hotspot works). Alarms on the UNO work even with no Wi-Fi.

## Demo script (5 minutes)

1. Home: live sensor tiles, devices, connections. (No hardware? **Start a simulated home**.)
2. Trigger smoke (real: smoke near the MQ-2 / simulated: **Smoke**) → status turns red, alert card, buzzer + fan.
3. Ask Aura (type or mic): "Is everything safe?" → explains the alert, gives 101 / 112.
4. Alerts page: timeline, mark as seen. History: the spike on the chart.
5. **Normal** → back to "All good".

## Honest limits to mention

- Prototype, not a certified safety device. Sensors need calibration (docs/CALIBRATION.md).
- Push notifications need Firebase (not set up). SMS/calls need a 2G SIM in the SIM800C.
- Real hardware and Malayalam/Hindi voice have not been field-tested yet.
