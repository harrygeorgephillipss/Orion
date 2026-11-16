# Hardware architecture (Phase 3 design — **proposed, not built or tested**)

This is the design the firmware will implement. Pin numbers and module details are a **proposal** to be checked
against your actual modules before wiring (see "Information still needed"). No component has been removed or
replaced; the mist maker stays a disabled placeholder because it is not in the inventory.

## Division of responsibility

| | Arduino UNO — **safety controller** (5 V) | ESP32 — **communications gateway** (3.3 V) |
|---|---|---|
| Reads | MQ-2 (A0), water (A1), flame (DO D2, AO A2 if 4-pin), DHT22 (D4) | — |
| Drives | relay → 12 V fan, buzzer, LEDs, MG995, SG90 (signal only) | its own status LED |
| Decides | **all local emergency actions** (no network involved) | when to send SMS/calls (on UNO hazard events), retries |
| Talks to | ESP32 over UART | UNO (UART), MQTT broker (Wi-Fi), SIM800C (UART) |
| Watchdog | AVR WDT 2 s; safe defaults on reset | task WDT + interrupt WDT; reboot reason reported |

Why this split:
- The MQ-2 and water modules output 0–5 V analog — native to the UNO's 5 V ADC. The ESP32's ADC is 3.3 V,
  non-linear near the rails, and ADC2 cannot be used while Wi-Fi is on.
- The life-safety loop stays on the simplest MCU with no network stack, so Wi-Fi/MQTT problems cannot stall it.
- The UNO has a single hardware UART and 2 KB RAM; SoftwareSerial disables interrupts and disturbs servo timing.
  So the SIM800C goes on the ESP32's spare hardware UART. GSM alerts are still **local**: the ESP32 sends them on a
  UNO hazard event without needing Wi-Fi, the server or the app.

## What happens without internet

| Failure | Local protection (UNO) | SMS/call (ESP32 + SIM800C) | Apps |
|---|---|---|---|
| Wi-Fi / server / AI / phone down | unchanged | unchanged | show OFFLINE / last-known values |
| ESP32 dead | unchanged; UNO shows "gateway lost" LED pattern | **not available** | OFFLINE within ~1 s (broker last-will) |
| UNO dead / link lost | **none** (UNO resets via watchdog; outputs return to safe defaults) | ESP32 reports controller lost | "Arduino UNO not responding" |
| SIM800C unregistered / unpowered | unchanged | fails, reported as failed (never "sent") | GSM incident |

## UNO ↔ ESP32 link

- Hardware UART, 38400 baud. **UNO TX (5 V) → ESP32 RX must go through a level shifter** (BSS138 module, or a
  1 kΩ / 2 kΩ divider). ESP32 TX (3.3 V) → UNO RX via the same BSS138 module (3.3 V is marginal for the UNO's
  input-high threshold, so don't rely on it directly). Common ground.
- Frames: ASCII `$TYPE,seq,field,…*CRC8\n`, ACK/NACK + retransmit, heartbeat both ways every 2 s.
- Disconnect the ESP32 from D0/D1 while uploading to the UNO over USB.

## Proposed pin map (to confirm)

| UNO pin | Connection | Notes |
|---|---|---|
| D0/D1 | ESP32 UART2 via level shifter | shared with USB programming |
| A0 | MQ-2 AO | module powered from 5 V; heater ≈ 150 mA |
| A1 | Water sensor AO | |
| A2 | Flame AO (if the module has one) | allows disconnect detection |
| D2 | Flame DO | active level to be measured |
| D4 | DHT22 data | 10 kΩ pull-up to 5 V if not on the module |
| D7 | Relay IN1 → fan | active level to be measured; relay coil from 5 V rail, not a pin |
| D8 | Buzzer via NPN transistor | active buzzer (no `tone()`, which would use Timer2) |
| D9 / D10 | MG995 / SG90 signal | Servo library uses Timer1 (PWM on D9/D10 is then unavailable — fine) |
| D5, D6, D11, D12 | Red, green, white, warm-white LEDs | 220–330 Ω each; model lights via transistor if > 20 mA |

| ESP32 pin | Connection |
|---|---|
| GPIO16 / GPIO17 | UART2 RX/TX ↔ UNO (through shifter) |
| GPIO26 / GPIO27 | UART1 RX/TX ↔ SIM800C (check your breakout's logic level; many are 2.8 V/3.3 V) |
| GPIO25 | SIM800C PWRKEY/RST via transistor (power-cycle on hang) |
| GPIO2 | status LED |

## Power (no high-current load on GPIO or the UNO's 5 V pin)

```
12 V ≥ 3 A adapter ─ fuse ─┬─ relay contacts ─ 12 V fan (flyback diode across the fan)
                           ├─ buck → 5 V 3 A ─ UNO (5 V pin), MQ-2, sensors, relay coil, ESP32 (VIN)
                           ├─ buck → 6 V ≥ 3 A + 1000 µF ─ MG995 (stall ≈ 2.5 A) and SG90
                           └─ buck → 4.0 V ≥ 2 A + ≥ 1000 µF low-ESR ─ SIM800C (2 A bursts)
All grounds joined at one star point. Never connect two regulator outputs together.
```

## Sensor handling (firmware rules)

- **MQ-2**: warm-up lockout after power-on (state `warming_up`, no hazard decisions; manufacturers specify a
  24–48 h burn-in for a new sensor and minutes for each power-up — the exact lockout time will be measured).
  Thresholds on raw ADC with hysteresis. **No ppm values** without a validated calibration. Rail-stuck readings
  (≈ 0 or ≈ 1023) ⇒ `disconnected`/`fault`.
- **Flame**: N-of-M debounce (e.g. 4 of 5 samples over ~0.5 s) so one noisy sample is not a fire; AO rail checks
  where available. Sensitivity set by the module pot, documented in the calibration guide.
- **Water**: threshold with hysteresis; rail-stuck ⇒ fault.
- **DHT22**: ≥ 2 s between reads; checksum/timeouts counted; three consecutive failures ⇒ `fault`;
  last good value never re-sent as fresh.

## Actuators

Every output is reported as **commanded**. No feedback sensors are in the inventory, so nothing is reported as
physically verified. Optional additions that would enable verification (not added without your decision):
ACS712/INA219 current sensor on the fan line, relay contact sense input, a limit switch on the door.

## Information still needed from you

Flame module type (3-pin DO or 4-pin DO+AO) and active level · water sensor model · relay module channel count,
active level and whether it is opto-isolated · SIM800C breakout model (logic level, power pins, PWRKEY) ·
DHT22 bare or on a module · buzzer active or passive · what the SG90 is for · MG995 door behaviour after 5 s ·
which power adapters/buck converters you have · a 2G-capable SIM (Jio has no 2G).
