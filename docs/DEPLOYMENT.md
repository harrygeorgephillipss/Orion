# Deployment

Target: one home, one server (LAN PC / Raspberry Pi 4+ / small VPS) running Docker.

1. Follow [BACKEND.md](BACKEND.md) Option A (`.env`, broker password file, `docker compose up`).
2. **HTTPS**: set your domain in `deployment/Caddyfile` (or `tls internal` for a LAN-only certificate) and start
   with `--profile https`. Browsers then reach `https://your-domain/`; the backend stays on 127.0.0.1:8000.
3. **MQTT over TLS** (needed whenever the broker is reachable beyond a trusted LAN): put `ca.crt`, `server.crt`,
   `server.key` in `deployment/mosquitto/certs/` (git-ignored), mount it, uncomment the 8883 listener in
   `mosquitto.conf`, publish port 8883 instead of 1883, and set `ORION_MQTT_TLS=true` / `ORION_MQTT_PORT=8883`.
   *Not yet exercised in tests.*
4. Register each gateway (`POST /api/v1/devices/gateways`), add its password to the broker file
   (`scripts/mqtt_passwd.py`), restart the broker, flash the password into the gateway (Phase 3).
5. Backups: schedule `pg_dump` (see BACKEND.md). Keep `.env` and the broker password file in a password manager.
6. Updates: `git pull && docker compose … up -d --build` (migrations run automatically on start).

Monitoring: `GET /api/v1/health` (no auth) for uptime checks; `GET /api/v1/system/status` (admin) for MQTT
counters. Logs: `docker compose logs -f backend`.
