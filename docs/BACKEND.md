# Backend: installation, database, configuration

Python 3.12+ (tested on 3.12 in the Docker image and 3.13 locally), PostgreSQL 16, Mosquitto 2.

## Option A — Docker Compose (recommended)

1. Copy `.env.example` to `.env` and replace **every** placeholder. Generate the JWT key with
   `python3 -c "import secrets;print(secrets.token_hex(32))"`. Set `ORION_ENV=production` for anything beyond your laptop.
2. Create the broker password file (hashes only; the file is git-ignored):

   ```bash
   python3 scripts/mqtt_passwd.py deployment/mosquitto/passwd orion-backend --from-env ORION_MQTT_PASSWORD
   ```

3. Start:

   ```bash
   docker compose -f deployment/docker-compose.yml --env-file .env up -d --build
   ```

   The backend runs `alembic upgrade head` on start, creates the owner from `ORION_BOOTSTRAP_OWNER_*` if no users
   exist, and serves the web app at `/` (port 8000 on 127.0.0.1; put Caddy in front for HTTPS — `--profile https`).

## Option B — local development

```bash
cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
```

```bash
docker run -d --name orion-pg -e POSTGRES_USER=orion -e POSTGRES_PASSWORD=orion-dev -e POSTGRES_DB=orion -p 5432:5432 postgres:16-alpine
```

```bash
docker run -d --name orion-mqtt -p 1883:1883 eclipse-mosquitto:2 mosquitto -c /mosquitto-no-auth.conf
```

(The second broker command allows anonymous clients — for local development only.)

```bash
cd backend && .venv/bin/alembic upgrade head
```

```bash
cd backend && ORION_BOOTSTRAP_OWNER_EMAIL=you@example.com ORION_BOOTSTRAP_OWNER_PASSWORD='Choose-a-strong-1' .venv/bin/uvicorn app.main:app --reload
```

Build the web app after any frontend change (`python3 frontend/build.py`); the backend serves `frontend/index.html`.

## Database

- Schema is managed by Alembic (`backend/alembic/versions/`). After changing `app/models.py`:
  `alembic revision --autogenerate -m "…"`, review the file, then `alembic upgrade head`.
- Main tables: `users`, `refresh_tokens`, `devices` (gateway/controller), `sensors` (latest reading),
  `telemetry` (history; B-tree on sensor+metric+time, BRIN on time), `incidents` + `incident_events` +
  `incident_actions`, `commands` + `command_history`, `gsm_modules`, `gsm_attempts`, `activity_events`,
  `audit_log`, `config` (versioned), `notification_contacts`.
- Every row from a simulated device carries `simulated = true`.
- Retention: `services.snapshot.prune_telemetry(db, keep_days=90)` exists but is **not scheduled yet**.
- Backups: `docker compose exec db pg_dump -U $POSTGRES_USER $POSTGRES_DB > backup.sql`.

## Configuration (environment)

All variables are listed with placeholders in `/.env.example`. Server-side settings that users edit at run time
(freshness windows, thresholds, room names, home name) live in the `config` table and are changed through
`PUT /api/v1/config/{key}` (admin) or the web app's Settings page.

## Users

- First owner: `ORION_BOOTSTRAP_OWNER_EMAIL` / `ORION_BOOTSTRAP_OWNER_PASSWORD` (only used while the user table is empty).
- More users: web API `POST /api/v1/users` (admin+), or `python -m app.cli create-user EMAIL NAME ROLE`
  (password is prompted, never passed on the command line).
- Roles: `owner > admin > member > viewer` — matrix in [SECURITY.md](SECURITY.md).

## Registering devices

`POST /api/v1/devices/gateways` (admin) registers an ESP32 gateway together with its controller(s), sensors and GSM
module, and returns the gateway's MQTT password **once**. Add it to the broker:

```bash
python3 scripts/mqtt_passwd.py deployment/mosquitto/passwd <gateway-id>
```

then restart the broker container (`docker compose -f deployment/docker-compose.yml restart mqtt`; the broker re-copies the file on start). Telemetry from anything not registered is rejected and counted.

### Device simulator

For testing without hardware. Register it as a **simulated** gateway — every value it produces is then tagged
"simulated" in the API, the apps and Aura:

```bash
curl -X POST http://localhost:8000/api/v1/devices/gateways -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d @hardware/communication/sim_gateway.json
```

```bash
backend/.venv/bin/python hardware/communication/sim_device.py --username esp32-sim --password '<from the response>'
```

Type `flame`, `smoke_warning`, `smoke_critical`, `water`, `dht_fault`, `dht_stale`, `uno_offline`, `gsm_outage`
or `normal` + Enter to change what it does; stop it (Ctrl-C) to simulate the gateway losing power.
