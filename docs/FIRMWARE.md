# Firmware (Arduino UNO + ESP32)

Status: **compiles for the real chips** (PlatformIO, 2026-11-16) and the shared logic passes **19 host unit tests /
94 checks** under AddressSanitizer + UBSan. **Not yet run on physical boards.**

| | UNO (`hardware/arduino_uno`) | ESP32 (`hardware/esp32`) |
|---|---|---|
| Role | safety controller: sensors, decisions, outputs | gateway: Wi-Fi/MQTT, SIM800C, UNO link |
| Build | `pio run` → RAM 483 B (24 %), flash 9.1 KB (28 %) | `pio run` → RAM 59 KB (18 %), flash 912 KB (71 %) |
| Libraries | OrionCore, Servo 1.2.2 | OrionCore, PubSubClient 2.8, ArduinoJson 7.2.1 |
| Watchdog | AVR WDT 2 s → reset to safe outputs | task WDT 10 s |

## OrionCore (`hardware/lib/OrionCore`) — the logic, testable on a PC

- `orion_safety` — MQ-2 (warm-up lockout, hysteresis, low-rail = disconnected, high-rail = alarm), flame
  (4-of-5 debounce), water (hysteresis; high rail = wet), DHT22 (3 failures = fault, 10 s freshness),
  and `SafetyController` with the local rules:
  - **Smoke** (MQ-2 warning/critical): buzzer ON, fan ON, red LED, door servo 180° for 5 s; when it clears: buzzer
    OFF, fan keeps running 60 s.
  - **Flame**: red LED, white + warm lights OFF, one SMS + call request per episode.
  - **Water**: reported (no local actuator in the current policy).
  - Remote commands: fan on/off, buzzer test only; **fan OFF is refused during smoke or its cooldown**; expired
    commands are refused. Sensor faults or a lost gateway link blink the green LED.
- `orion_link` — UNO↔ESP32 frames with CRC-8 (format in the header file).
- `orion_sim800` — non-blocking SIM800C driver (init, SIM/registration/signal polling, SMS with retries, calls with
  answer detection via `+COLP`, power-cycle on a hung modem).

Run the tests: `make -C hardware/lib/OrionCore/test`.

## Configuration before flashing

- **UNO** `src/main.cpp`: `FLAME_ACTIVE_LOW`, `RELAY_ACTIVE_LOW`, `HAS_FLAME_AO` — measure your modules first.
  Thresholds and timings: `OrionCore/src/orion_config.h` (placeholders until calibrated — [CALIBRATION.md](CALIBRATION.md)).
- **ESP32**: `cp include/secrets.example.h include/secrets.h`, fill in Wi-Fi, broker address, the gateway id/password
  from registration, controller/sensor ids exactly as registered, and emergency numbers. `secrets.h` is git-ignored.

## Flashing

```bash
pip install platformio
```

```bash
cd hardware/arduino_uno && pio run -t upload
```

(unplug the ESP32 from D0/D1 first)

```bash
cd hardware/esp32 && pio run -t upload && pio device monitor
```

Arduino IDE alternative: copy `hardware/lib/OrionCore` into your Arduino `libraries` folder and open each
`src/main.cpp` as a sketch (rename to `.ino`).

## Known firmware limitations

- A disconnected flame DO wire or water sensor wire cannot be detected in firmware alone (both read like "no
  hazard"); see [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md). MQ-2 low-rail disconnection is detected.
- No actuator feedback hardware: every output is reported as commanded, never verified.
- Emergency contacts come from the app via the server (retained MQTT `config` topic) and are stored in ESP32 flash,
  so SMS/calls work offline. `EMERGENCY_NUMBERS` in `secrets.h` is only the fallback before the first list arrives.
- DHT22 is read by bit-banging with interrupts off for ~5 ms every 2.5 s (brief servo jitter possible).
- Event text and GSM wording are English only.
