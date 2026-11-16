// ORION local safety logic — runs on the Arduino UNO with no network involved.
// Pure C++: time is passed in (milliseconds, wrap-safe), so the same code is unit-tested on a PC.
#pragma once
#include <stdint.h>
#include "orion_config.h"

namespace orion {

enum class Quality : uint8_t { Valid = 0, WarmingUp = 1, Fault = 2, Disconnected = 3 };
enum class Level : uint8_t { Normal = 0, Warning = 1, Critical = 2, Unknown = 3 };

inline bool elapsed(uint32_t now, uint32_t since, uint32_t ms) { return (uint32_t)(now - since) >= ms; }

// Counts consecutive samples at a rail. Not proof of a broken wire, but never treated as a valid reading.
struct RailWatch {
  uint8_t low = 0, high = 0;
  bool check(int raw, bool watchLow, bool watchHigh);
};

class Mq2 {
 public:
  void begin(uint32_t now) { start_ = now; started_ = true; }
  void update(int raw, uint32_t now);
  int raw = -1;
  Level level = Level::Unknown;
  Quality quality = Quality::WarmingUp;
  uint16_t warmupLeftS(uint32_t now) const;
 private:
  uint32_t start_ = 0;
  bool started_ = false;
  RailWatch rail_;
};

class Flame {
 public:
  // digitalActive: the module's DO already converted to "flame seen" (polarity applied by the caller).
  // analog: AO reading, or -1 if the module has no AO pin.
  void update(bool digitalActive, int analog);
  bool detected = false;
  Quality quality = Quality::Valid;
 private:
  uint8_t window_ = 0;  // last FLAME_WINDOW samples as bits
  uint8_t n_ = 0;
  RailWatch rail_;
};

class Water {
 public:
  void update(int raw);
  int raw = -1;
  bool wet = false;
  Quality quality = Quality::Valid;
 private:
  RailWatch rail_;
};

class Dht {
 public:
  void success(float tempC, float humidity, uint32_t now);
  void failure();
  bool current(uint32_t now) const { return has_ && !elapsed(now, at_, cfg::DHT_MAX_AGE_MS); }
  float tempC = 0, humidity = 0;
  Quality quality = Quality::Valid;
  uint8_t fails = 0;
 private:
  bool has_ = false;
  uint32_t at_ = 0;
};

enum class Hazard : uint8_t { None = 0, Smoke = 1, Flame = 2, Water = 3 };
// Firmware events (sent to the gateway, which turns them into text). Codes are stable — keep in sync with the ESP32.
enum class EventCode : uint8_t {
  SmokeStart = 1, SmokeEnd = 2, DoorReturned = 3, FanCooldownEnded = 4,
  FlameStart = 5, FlameEnd = 6, WaterStart = 7, WaterEnd = 8, SmokeCritical = 9,
};
struct Event { Hazard hazard; EventCode code; };

enum class Actuator : uint8_t { Fan = 1, Buzzer = 2 };
enum class Action : uint8_t { On = 1, Off = 2, Test = 3 };
enum class CmdResult : uint8_t { ExecutedUnverified = 0, RejectedInterlock = 1, RejectedNotAllowed = 2, RejectedExpired = 3 };

struct Outputs {
  bool fan = false, buzzer = false;
  bool ledRed = false, ledGreen = true, lightWhite = true, lightWarm = true;
  uint8_t doorAngle = cfg::DOOR_REST_ANGLE;
  bool faultBlink = false;  // green LED blinks when any sensor is faulty/disconnected or the gateway link is lost
};

class SafetyController {
 public:
  void begin(uint32_t now);
  // One control step: evaluate sensors, update outputs, queue events.
  void step(uint32_t now, const Mq2& mq2, const Flame& flame, const Water& water, const Dht& dht, bool gatewayLinkOk);
  // Remote command (from the gateway). The local rules always win.
  CmdResult command(Actuator a, Action act, uint32_t ttlLeftMs, uint32_t now);
  Outputs out;
  bool smoke() const { return smoke_; }
  bool flameActive() const { return flame_; }
  bool waterActive() const { return water_; }
  uint16_t fanCooldownLeftS(uint32_t now) const;
  // GSM request: set once per flame episode; the caller clears it after forwarding.
  bool gsmRequest = false;
  Hazard gsmHazard = Hazard::None;
  // Event queue
  bool popEvent(Event& e);
 private:
  void push(Hazard h, EventCode c);
  bool smoke_ = false, smokeCrit_ = false, flame_ = false, water_ = false;
  bool cooldown_ = false, doorOpen_ = false, manualFan_ = false, buzzerTest_ = false;
  uint32_t cooldownAt_ = 0, doorAt_ = 0, buzzerTestAt_ = 0;
  Event q_[8];
  uint8_t qh_ = 0, qn_ = 0;
};

}  // namespace orion
