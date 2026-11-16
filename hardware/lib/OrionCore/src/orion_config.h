// ORION tunables. Every threshold below is a PLACEHOLDER until measured on the real sensors
// (see docs/CALIBRATION.md). Raw values are 10-bit ADC counts (0..1023) on the UNO.
#pragma once
#include <stdint.h>

namespace orion {
namespace cfg {
// MQ-2 smoke / gas (raw ADC, NOT ppm)
constexpr int MQ2_WARNING = 350;
constexpr int MQ2_CRITICAL = 500;
constexpr int MQ2_HYST = 25;                     // must fall this far below a level to leave it
constexpr uint32_t MQ2_WARMUP_MS = 180000UL;     // power-on lockout; burn-in of a NEW sensor takes 24–48 h
// Flame: N of the last M samples must agree before the state changes (rejects single noisy samples)
constexpr uint8_t FLAME_WINDOW = 5;
constexpr uint8_t FLAME_ON_COUNT = 4;
constexpr uint8_t FLAME_OFF_COUNT = 0;           // all samples clear before "no flame"
// Water (raw ADC)
constexpr int WATER_WET = 300;
constexpr int WATER_HYST = 30;
// Rail detection: an analog input stuck at the rails usually means a broken wire or short
constexpr int RAIL_LOW = 3;
constexpr int RAIL_HIGH = 1020;
constexpr uint8_t RAIL_SAMPLES = 20;             // consecutive samples before declaring a fault
// DHT22
constexpr uint8_t DHT_FAILS_FOR_FAULT = 3;
constexpr uint32_t DHT_MAX_AGE_MS = 10000UL;     // a reading older than this is not reported as current
// Responses
constexpr uint32_t FAN_COOLDOWN_MS = 60000UL;    // fan keeps running after smoke clears
constexpr uint32_t DOOR_OPEN_MS = 5000UL;        // MG995 target 180° for 5 s on smoke (policy pending review)
constexpr uint8_t DOOR_OPEN_ANGLE = 180;
constexpr uint8_t DOOR_REST_ANGLE = 0;
constexpr uint32_t BUZZER_TEST_MS = 2000UL;
// Link
constexpr uint32_t LINK_TIMEOUT_MS = 6000UL;     // no frame from the other board for this long = link lost
}  // namespace cfg
}  // namespace orion
