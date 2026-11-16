# Security

What is implemented (Phase 2) and what is still open. Nothing here has been independently audited.

## People

- Passwords: Argon2id (argon2-cffi defaults). Policy: ≥ 10 characters, upper + lower case, a digit.
  Unknown e-mail and wrong password give the same error and take the same time.
- Sessions: JWT access tokens (HS256, 15 min). Refresh tokens are random, stored only as SHA-256 hashes, rotated
  on every use; re-use of an old token revokes the whole family (theft detection). Browsers get the refresh token
  only as an `HttpOnly; SameSite=Strict` cookie (`Secure` in production) — JavaScript never sees it.
- Brute force: 10 login attempts/min per IP; 5 failures lock the account for 5 min.

### Role matrix

| Action | viewer | member | admin | owner |
|---|:-:|:-:|:-:|:-:|
| See dashboard, history, incidents, devices, config | ✓ | ✓ | ✓ | ✓ |
| Acknowledge incidents | | ✓ | ✓ | ✓ |
| Send allow-listed device commands | | ✓ | ✓ | ✓ |
| Change server settings, register devices, manage contacts, read audit log | | | ✓ | ✓ |
| Create users (lower roles only) | | | ✓ | ✓ |
| Grant owner, change the owner, delete devices | | | | ✓ |

## Devices

- Each gateway has its own broker account (username = gateway id, random 32-char password shown once at
  registration; the server keeps only an Argon2 hash). Mosquitto stores PBKDF2-SHA512 hashes.
- Broker ACL: a gateway may publish only `orion/+/<its id>/{status,heartbeat,telemetry,actuators,event,gsm,cmd_ack}`
  and read only `orion/+/<its id>/cmd`. **Verified** on Mosquitto 2.1.2: wrong password and anonymous logins are
  refused; publishing into another gateway's topics is dropped; a gateway cannot inject commands.
- The server additionally rejects messages from unregistered gateways, controllers that don't belong to the
  publishing gateway, unregistered sensors, malformed payloads and out-of-range values.
- Commands: allow-list only (fan on/off, buzzer test); expire after 30 s; one at a time per controller; rate-limited;
  audited. Door servo, SG90 and mist maker have **no** remote commands. The safety controller can refuse anything.

## Transport

- Production must run behind HTTPS (Caddy profile in `deployment/docker-compose.yml`) and MQTT over TLS (8883,
  config stub in `deployment/mosquitto/mosquitto.conf`). HSTS is sent when `ORION_ENV=production`.
  **TLS has not been exercised in tests yet.**
- Security headers: `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Permissions-Policy`, `Cache-Control: no-store` on the API. No stack traces are returned to clients.

## Secrets

- Only `.env.example` (placeholders) is committed. `.env`, broker password files, certificates, Firebase files and
  keys are in `.gitignore`. The server refuses to start in production without `ORION_SECRET_KEY` (≥ 32 chars).
- Emergency phone numbers live only in the database; non-admins see them masked; they are never written to the
  audit log or to GSM attempt records (masked there).
- Aura's AI key (Phase 4) will be read from the server environment only and never sent to any client.

## Audit log

Logins (success/failure), refresh-token reuse, user changes, device registration/deletion, config changes,
command creation/refusal, acknowledgements, contact changes.

## Open items

- TLS for HTTPS and MQTT configured but not tested; certificate guidance in [DEPLOYMENT.md](DEPLOYMENT.md).
- Rate limiting is in-memory (single process); a second instance would need a shared store.
- No automated dependency-vulnerability scan yet (`pip-audit` / `npm audit` to be added to CI in Phase 6).
- Account recovery (forgotten password) not implemented — the owner resets via the CLI.
- Firmware secure storage of the gateway password (ESP32 NVS encryption) is Phase 3.
