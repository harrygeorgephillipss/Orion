# Sensor calibration and thresholds

All values in `hardware/lib/OrionCore/src/orion_config.h` are **placeholders**. No calibration has been done; ORION
shows raw ADC values and never claims ppm. Record every measurement you make (date, temperature, humidity, values).

## MQ-2
1. **Burn-in**: power a new sensor continuously for 24–48 h before any measurement (manufacturer guidance).
2. **Warm-up** after each power-on: log the raw value every 10 s from power-on until it is stable (±5 counts for
   2 min). Set `MQ2_WARMUP_MS` to that time plus a margin.
3. **Baseline**: log clean-air values over 24 h in the room where it will be installed (cooking, humidity and
   temperature move it). Note min / max / mean.
4. **Thresholds**: set `MQ2_WARNING` comfortably above the highest normal value you logged (including cooking),
   `MQ2_CRITICAL` higher still. Test with a **safe** stimulus (e.g. a smouldering incense stick or a butane lighter
   released briefly — no open flame, ventilated, someone supervising) and record the peak.
5. MQ-2 cannot distinguish smoke from LPG, alcohol vapour or cooking fumes — expect false positives.
6. Replace the sensor per the manufacturer's life (typically a few years) and re-check the baseline every 6 months.

## Flame sensor
Adjust the module's potentiometer so the DO LED trips at your required distance with a **candle/lighter flame
held safely** and does **not** trip in sunlight or under room lights. Record distance and angle. IR flame sensors
only see flames in their field of view; they don't see smouldering fires.

## Water sensor
Log the dry value and the value with a few drops and when submerged. Set `WATER_WET` between dry and drops. These
probe sensors corrode; inspect monthly.

## DHT22
Compare against a reference thermometer/hygrometer for 1 h. Typical DHT22 accuracy: ±0.5 °C, ±2–5 %RH. ORION
reports values as measured; temperature advisories are set in the app (Settings → Alert levels).

## Recording
Put results in [BENCH_TESTS.md](BENCH_TESTS.md). Change thresholds only in `orion_config.h` and re-flash; the app's
alert levels are display/advisory only and cannot weaken firmware thresholds.
