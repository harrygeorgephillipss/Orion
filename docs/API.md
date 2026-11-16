# ORION API (v1)

Interactive OpenAPI docs are served by the backend at **`/api/docs`** (schema at `/api/openapi.json`).
All endpoints are under `/api/v1`. All times are **epoch milliseconds (UTC)**. Errors are `{"detail": "…"}`.

## Authentication

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | `/auth/login` | anyone (rate-limited 10/min/IP) | `{"email","password","client":"web"\|"mobile"}` → `{access_token, expires_in, user}`. Web: refresh token in httpOnly `orion_refresh` cookie. Mobile: `refresh_token` in body. 5 failures → 5 min lock. |
| POST | `/auth/refresh` | holder of a refresh token | Rotates the refresh token. Re-using an old one revokes the whole token family. |
| POST | `/auth/logout` | — | Revokes the refresh-token family, clears the cookie. |
| GET | `/auth/me` | signed in | Current user. |

Send `Authorization: Bearer <access_token>` (15 min lifetime by default) on every other call.

## Endpoints

| Method | Path | Minimum role | Purpose |
|---|---|---|---|
| GET | `/health` | none | `{status, database, mqtt}` — no home data |
| GET | `/overview` | viewer | Full snapshot used by the apps: sensors, controllers, GSM, actuators, incidents (active + 50 recent), events, commands, logs. `status:"empty"` until a device is registered. `simulated` / `contains_simulated` flags. |
| GET | `/telemetry?series=<sensor>:<metric>&from=&to=&max_points=` | viewer | History. Metrics: `mq2`, `flame`, `water`, `temp`, `hum`. Long ranges are bucket-averaged. |
| GET | `/incidents?state=all\|active\|cleared&limit=` | viewer | Incidents with timeline and actions |
| POST | `/incidents/{id}/ack` | member | Records that you know. **Does not clear or silence anything.** |
| GET | `/commands`, `/commands/allowed` | viewer | Recent commands with step history; the allow-list |
| POST | `/commands` | member (20/min) | `{"actuator","action","device_id"?}` — allow-list: fan on, fan off, buzzer test |
| GET | `/devices` | viewer | Registered devices and sensors |
| POST | `/devices/gateways` | admin | Register a gateway + controllers + sensors + GSM module; returns MQTT password **once** |
| DELETE | `/devices/{id}` | owner | Remove a device (and its children) |
| GET | `/config` | viewer | `freshness`, `thresholds`, `home`, `rooms` with version and author |
| PUT | `/config/{key}` | admin | Validated update; audited. Never changes firmware thresholds. |
| GET / POST / DELETE | `/contacts` | viewer (masked) / admin | Emergency contacts (E.164). Full numbers only for owner/admin. |
| GET | `/audit?limit=` | admin | Audit log |
| GET | `/system/status` | admin | MQTT connection, received/rejected message counts, WebSocket clients |
| GET / POST / PATCH | `/users…` | admin | User management (admins cannot create peers or owners) |
| POST | `/users/me/password` | signed in | Change own password (policy: ≥ 10 chars, mixed case, digit) |

## Command lifecycle

`requested → queued → sent → accepted → unknown ("done · unconfirmed") | completed (feedback-verified)`,
or `rejected` (controller interlock), `failed` (not sent — e.g. broker down), `expired` (no answer in 30 s).
A command is never shown as done unless the device answered.

## WebSocket `/api/v1/ws`

1. Connect, then send `{"type":"auth","token":"<access token>"}` within 5 s (closed with code 4401 otherwise).
2. Server replies `{"type":"ready"}`, then streams events:
   `update`, `telemetry`, `incident_opened`, `incident_escalated`, `incident_cleared`, `device_status`,
   `actuators`, `command`, `gsm_status`, `gsm_attempt`, `server_status`, `tick` (every 2 s).
3. Clients re-fetch `/overview` on events (the web app debounces by 250 ms). Send `ping` → `pong`.

## Device protocol

Gateways do not use the REST API; they speak MQTT — see [hardware/communication/PROTOCOL.md](../hardware/communication/PROTOCOL.md).
