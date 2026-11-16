# ORION device ↔ server protocol (MQTT)

Status: **implemented on the server and in the device simulator** (`sim_device.py`). The ESP32 firmware that will
speak it is Phase 3 and does not exist yet.

## Transport

- MQTT 3.1.1/5 to Mosquitto. QoS 1 for everything. Port 1883 on a trusted LAN, **8883 + TLS** anywhere else.
- Each gateway logs in with **username = its gateway id** and the password returned once by
  `POST /api/v1/devices/gateways`. The broker ACL (`deployment/mosquitto/acl`) only lets a gateway publish under
  its own subtree and read its own `cmd` topic. Verified on Mosquitto 2.1.2 (see docs/TESTING.md).
- The gateway sets a **last-will**: topic `.../status`, payload `{"online":false}`, retained. If the gateway loses
  power or Wi-Fi, the broker publishes it and the server marks the gateway offline within a second.

## Topics

`{root}/{home_id}/{gateway_id}/{kind}` — `root` defaults to `orion`, `home_id` to `home-1`.

| kind | direction | purpose |
|---|---|---|
| `status` | device → server (retained) | online/offline, firmware, boot reason |
| `heartbeat` | device → server, every 2 s | gateway uptime/RSSI + link state of each controller (UNO) behind it |
| `telemetry` | device → server | sensor readings as decided by the safety controller |
| `actuators` | device → server | what the controller **commanded** each output to do |
| `event` | device → server | firmware-reported actions ("buzzer ON; exhaust fan ON") |
| `gsm` | device → server | SIM800C registration/signal + SMS/call attempt states |
| `cmd_ack` | device → server | answer to a command |
| `cmd` | server → device | a remote command (allow-listed, expiring) |
| `config` | server → device (retained) | emergency contacts `{"version":1,"contacts":[{"name","phone","sms","call"}]}`, stored in flash |

All device → server messages carry a monotonically increasing `seq` (gaps are counted and shown in Diagnostics).
Times are **relative** (`age_ms` = how long ago, by the device's own clock) so devices need no real-time clock;
the server computes `recorded_at = received_at − age_ms` (capped at 10 min).

## Payloads

```jsonc
// status
{"online": true, "fw": "0.3.0", "boot_reason": "power_on"}

// heartbeat
{"seq": 812, "uptime_s": 3600, "rssi": -58,
 "controllers": [{"id": "uno-01", "link_ok": true, "last_rx_ms_ago": 150, "fw": "0.3.0", "boot_reason": "watchdog"}]}

// telemetry — state is decided by the UNO firmware and is authoritative for hazards
{"seq": 813, "controller": "uno-01", "readings": [
  {"sensor": "mq2-01", "fields": {"raw_adc": 412}, "quality": "valid", "state": "warning", "age_ms": 300,
   "fw_threshold": {"warning": 350, "critical": 500}},
  {"sensor": "mq2-01", "fields": {"raw_adc": null}, "quality": "warming_up", "state": "unknown", "warmup_remaining_s": 95},
  {"sensor": "flame-01", "fields": {"detected": true, "digital_value": 0}, "quality": "valid", "state": "critical"},
  {"sensor": "water-01", "fields": {"raw_adc": 640, "wet": true}, "quality": "valid", "state": "warning", "fw_threshold": {"wet": 300}},
  {"sensor": "dht-01", "fields": {"temperature_c": null, "humidity_percent": null}, "quality": "fault", "fault": "checksum"}]}
```

- `quality`: `valid | warming_up | fault | disconnected`. Only `valid` readings are stored as values.
- `state`: `normal | warning | critical | unknown`.
- Server-side range checks: raw ADC 0–4095, temperature −40…80 °C, humidity 0–100 %. Out of range ⇒ stored as a fault.

```jsonc
// actuators — commanded states only; "feedback": false means nothing confirms the physical result
{"seq": 814, "controller": "uno-01", "actuators": {
  "fan": {"commanded": "on", "by": "firmware (smoke rule)", "cooldown_remaining_s": 0, "feedback": false},
  "buzzer": {"commanded": "on", "pattern": "continuous", "feedback": false},
  "mg995": {"target_angle": 180, "reported_position": null, "feedback": false},
  "relay": {"channels": [{"ch": 1, "load": "Exhaust fan", "commanded": "energised"}], "feedback": false},
  "leds": {"items": [{"id": "led-red", "commanded": "on"}]}}}

// event
{"seq": 815, "controller": "uno-01", "kind": "action", "hazard": "smoke", "sensor": "mq2-01", "text": "Buzzer ON; exhaust fan ON", "age_ms": 120}

// gsm — "sent" means the modem accepted it (+CMGS); "delivered" only with a network delivery report
{"seq": 816, "module": {"id": "gsm-01", "registered": true, "csq": 17, "operator": "…", "sim": "READY"},
 "attempts": [{"id": "a-1731…", "type": "sms", "destination": "+91…", "status": "sent", "note": "+CMGS: 41",
               "hazard": "flame", "sensor": "flame-01", "age_ms": 900}]}
```

The server masks phone numbers before storing attempts (`•••• 42`).

```jsonc
// cmd (server → device)
{"command_id": "cmd-…", "controller": "uno-01", "actuator": "fan", "action": "on", "expires_at": 1731…, "ttl_ms": 30000}

// cmd_ack (device → server); send "accepted" first, then the outcome
{"command_id": "cmd-…", "status": "accepted" | "rejected" | "executed_unverified" | "verified" | "failed", "note": "…"}
```

Rules for firmware authors:

1. The UNO is the final authority. It **must** reject commands that conflict with a local safety rule
   (e.g. fan OFF during smoke or its cooldown) and say why in `note`.
2. Ignore a command whose `ttl_ms` has passed by the time it reaches the UNO.
3. Report `verified` **only** if a feedback sensor confirmed the change. With no feedback hardware, report
   `executed_unverified`. The apps then show "Done · unconfirmed".
4. Only these commands exist: fan on, fan off, buzzer test. Door/servo, SG90 and the mist maker have no remote
   commands.
