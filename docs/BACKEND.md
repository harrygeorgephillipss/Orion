# Backend: installation, database, configuration

Python 3.12+ (tested on 3.12 in the Docker image and 3.13 locally), PostgreSQL 16, Mosquitto 2.

## Option A — Docker Compose (recommended)

1. Create `.env` with strong random secrets and your owner account:

   ```bash
   python3 scripts/setup.py --server-url https://your-server-address
   ```

   (It asks for the owner email and password. Add `AURA_*` and `FCM_*` values to `.env` later if you want them.)
2. Start:

   ```bash
   docker compose -f deployment/docker-compose.yml --env-file .env up -d --build
   ```

   The backend runs `alembic upgrade head` on start, creates the owner from `ORION_BOOTSTRAP_OWNER_*` if no users
   exist, creates its own broker account, and serves the web app at `/` (port 8000 on 127.0.0.1; put Caddy in front
   for HTTPS — `--profile https`). **Broker accounts are automatic in this setup:** the server writes Mosquitto's
   password file (shared volume) and the broker reloads it within seconds.

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

In the app: **Settings → Registered devices → Register a gateway** (or `POST /api/v1/devices/gateways`). It returns
the gateway's MQTT password **once**. With Docker Compose the broker account is created automatically; for a
hand-run Mosquitto add it with `python3 scripts/mqtt_passwd.py <passwd-file> <gateway-id>` and restart it. Telemetry from anything not registered is rejected and counted.

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
