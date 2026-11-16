# Wiring and bill of materials (proposed — check every connection against your modules before powering)

The pin map and power tree are in [hardware-architecture.md](hardware-architecture.md). This page lists the wires
and the parts.

## Connections

| From | To | Notes |
|---|---|---|
| MQ-2 VCC / GND / AO | 5 V rail / GND / UNO A0 | heater draws ~150 mA — from the 5 V buck, not the UNO pin |
| Water sensor VCC / GND / S | 5 V / GND / UNO A1 | |
| Flame VCC / GND / DO (/ AO) | 5 V / GND / UNO D2 (/ A2) | set `FLAME_ACTIVE_LOW`, `HAS_FLAME_AO` |
| DHT22 VCC / DATA / GND | 5 V / UNO D4 (+10 kΩ to 5 V if bare sensor) / GND | |
| Relay IN1 / VCC / GND | UNO D7 / 5 V / GND | relay contacts in series with the 12 V fan; flyback diode across the fan |
| Buzzer | UNO D8 via NPN (e.g. 2N2222 + 1 kΩ base) | active buzzer |
| MG995 signal / SG90 signal | UNO D9 / D10 | servo power from the 6 V buck; grounds joined |
| LEDs red, green, white, warm | UNO D5, D6, D11, D12 via 220–330 Ω | larger model lights via transistor |
| UNO TX (D1) → ESP32 GPIO16 | **through BSS138 level shifter** (5 V → 3.3 V) | never direct |
| ESP32 GPIO17 → UNO RX (D0) | through the same shifter | |
| SIM800C TXD / RXD | ESP32 GPIO26 / GPIO27 | check the breakout's logic level |
| SIM800C PWRKEY | ESP32 GPIO25 via NPN | |
| SIM800C VCC | 4.0 V buck (≥ 2 A) + ≥ 1000 µF low-ESR | never from 5 V or a GPIO |

## Bill of materials

In your inventory: Arduino UNO, ESP32, MQ-2, flame sensor, water sensor, DHT22, 12 V exhaust fan, 5 V relay module,
buzzer, MG995, SG90, LEDs, SIM800C.

Additional parts this design needs:

| Part | Qty | Why |
|---|---|---|
| 12 V adapter, ≥ 3 A | 1 | fan + all regulators |
| Inline fuse holder + 3 A fuse | 1 | protects the wiring |
| Buck converter 12 V → 5 V, ≥ 3 A | 1 | UNO, ESP32, sensors, relay coil |
| Buck converter 12 V → 6 V, ≥ 3 A | 1 | MG995 (stall ≈ 2.5 A) + SG90 |
| Buck converter 12 V → 4.0 V, ≥ 2 A | 1 | SIM800C bursts |
| Capacitors 1000 µF (low-ESR) | 2–3 | servo rail, SIM800C rail |
| BSS138 4-channel bi-directional level shifter | 1 | UNO ↔ ESP32 UART |
| 1N4007 / 1N5819 diode | 1 | fan flyback |
| NPN transistors (2N2222) + 1 kΩ resistors | 2–4 | buzzer, SIM800C PWRKEY, model lights |
| 220–330 Ω resistors, 10 kΩ resistors | ~10 | LEDs, DHT22 pull-up |
| 2G-capable SIM card | 1 | Jio has no 2G network |
| Optional: ACS712/INA219, limit switch | — | would allow *verified* fan/door states |
