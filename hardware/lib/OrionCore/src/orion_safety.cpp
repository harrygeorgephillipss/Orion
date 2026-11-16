#include "orion_safety.h"

namespace orion {

bool RailWatch::check(int raw, bool watchLow, bool watchHigh) {
  low = (watchLow && raw <= cfg::RAIL_LOW) ? (low < 255 ? low + 1 : 255) : 0;
  high = (watchHigh && raw >= cfg::RAIL_HIGH) ? (high < 255 ? high + 1 : 255) : 0;
  return low >= cfg::RAIL_SAMPLES || high >= cfg::RAIL_SAMPLES;
}

void Mq2::update(int r, uint32_t now) {
  raw = r;
  // A powered MQ-2 never sits at 0 V: a reading at the low rail means a broken wire or no heater power.
  // Such readings are never used to decide anything — in particular they can never clear an active alarm.
  // The HIGH rail is NOT treated as a fault: it may be a very high concentration, so it goes through the
  // thresholds and alarms (fail-safe).
  if (r <= cfg::RAIL_LOW) {
    if (rail_.check(r, true, false)) { quality = Quality::Disconnected; level = Level::Unknown; }
    return;  // hold the previous decision while the fault is being confirmed
  }
  rail_.check(r, true, false);
  if (!started_ || !elapsed(now, start_, cfg::MQ2_WARMUP_MS)) { quality = Quality::WarmingUp; level = Level::Unknown; return; }
  quality = Quality::Valid;
  Level prev = level == Level::Unknown ? Level::Normal : level;
  Level next;
  if (r >= cfg::MQ2_CRITICAL || (prev == Level::Critical && r >= cfg::MQ2_CRITICAL - cfg::MQ2_HYST)) next = Level::Critical;
  else if (r >= cfg::MQ2_WARNING || (prev != Level::Normal && r >= cfg::MQ2_WARNING - cfg::MQ2_HYST)) next = Level::Warning;
  else next = Level::Normal;
  level = next;
}

uint16_t Mq2::warmupLeftS(uint32_t now) const {
  if (!started_) return (uint16_t)(cfg::MQ2_WARMUP_MS / 1000);
  uint32_t e = now - start_;
  return e >= cfg::MQ2_WARMUP_MS ? 0 : (uint16_t)((cfg::MQ2_WARMUP_MS - e + 999) / 1000);
}

void Flame::update(bool digitalActive, int analog) {
  // Typical IR flame modules hold AO near the HIGH rail when no flame is seen, so a rail check would be wrong here.
  // A disconnected DO wire cannot be detected in firmware alone (see docs/hardware-architecture.md).
  (void)analog;
  quality = Quality::Valid;
  window_ = (uint8_t)(((window_ << 1) | (digitalActive ? 1 : 0)) & ((1u << cfg::FLAME_WINDOW) - 1));
  if (n_ < cfg::FLAME_WINDOW) n_++;
  uint8_t ones = 0;
  for (uint8_t i = 0; i < cfg::FLAME_WINDOW; i++) ones += (window_ >> i) & 1;
  if (!detected && ones >= cfg::FLAME_ON_COUNT) detected = true;
  else if (detected && ones <= cfg::FLAME_OFF_COUNT) detected = false;
}

void Water::update(int r) {
  raw = r;
  // A fully submerged sensor can read at the high rail, so high values always count as wet (fail-safe).
  // A dry sensor reads near 0 V, so a broken wire looks "dry": disconnection is not detectable on this input.
  quality = Quality::Valid;
  if (!wet && r >= cfg::WATER_WET) wet = true;
  else if (wet && r < cfg::WATER_WET - cfg::WATER_HYST) wet = false;
}

void Dht::success(float t, float h, uint32_t now) {
  if (t < -40 || t > 80 || h < 0 || h > 100) { failure(); return; }
  tempC = t; humidity = h; at_ = now; has_ = true; fails = 0; quality = Quality::Valid;
}

void Dht::failure() {
  if (fails < 255) fails++;
  if (fails >= cfg::DHT_FAILS_FOR_FAULT) quality = Quality::Fault;
}

void SafetyController::begin(uint32_t now) {
  out = Outputs();
  smoke_ = smokeCrit_ = flame_ = water_ = cooldown_ = doorOpen_ = manualFan_ = buzzerTest_ = false;
  gsmRequest = false; gsmHazard = Hazard::None; qn_ = 0; qh_ = 0;
  (void)now;
}

void SafetyController::push(Hazard h, EventCode c) {
  uint8_t idx = (uint8_t)((qh_ + qn_) % 8);
  q_[idx] = Event{h, c};
  if (qn_ < 8) qn_++; else qh_ = (uint8_t)((qh_ + 1) % 8);  // overwrite oldest
}

bool SafetyController::popEvent(Event& e) {
  if (!qn_) return false;
  e = q_[qh_]; qh_ = (uint8_t)((qh_ + 1) % 8); qn_--;
  return true;
}

void SafetyController::step(uint32_t now, const Mq2& mq2, const Flame& flame, const Water& water, const Dht& dht, bool linkOk) {
  // ---- smoke: decided only from a valid MQ-2 reading; warm-up/disconnect never raise or clear it ----
  if (mq2.quality == Quality::Valid) {
    bool on = mq2.level == Level::Warning || mq2.level == Level::Critical;
    if (on && !smoke_) {
      smoke_ = true; cooldown_ = false; doorOpen_ = true; doorAt_ = now;
      push(Hazard::Smoke, EventCode::SmokeStart);
    } else if (!on && smoke_) {
      smoke_ = false; smokeCrit_ = false; cooldown_ = true; cooldownAt_ = now;
      push(Hazard::Smoke, EventCode::SmokeEnd);
    }
    if (smoke_ && mq2.level == Level::Critical && !smokeCrit_) { smokeCrit_ = true; push(Hazard::Smoke, EventCode::SmokeCritical); }
  }
  if (doorOpen_ && elapsed(now, doorAt_, cfg::DOOR_OPEN_MS)) { doorOpen_ = false; push(Hazard::Smoke, EventCode::DoorReturned); }
  if (cooldown_ && elapsed(now, cooldownAt_, cfg::FAN_COOLDOWN_MS)) { cooldown_ = false; push(Hazard::Smoke, EventCode::FanCooldownEnded); }

  // ---- flame ----
  if (flame.detected && !flame_) {
    flame_ = true; push(Hazard::Flame, EventCode::FlameStart);
    gsmRequest = true; gsmHazard = Hazard::Flame;  // SMS + call, once per episode
  } else if (!flame.detected && flame_) {
    flame_ = false; push(Hazard::Flame, EventCode::FlameEnd);
  }
  // ---- water (reported; no local actuator response in the current policy) ----
  if (water.quality == Quality::Valid) {
    if (water.wet && !water_) { water_ = true; push(Hazard::Water, EventCode::WaterStart); }
    else if (!water.wet && water_) { water_ = false; push(Hazard::Water, EventCode::WaterEnd); }
  }
  if (buzzerTest_ && elapsed(now, buzzerTestAt_, cfg::BUZZER_TEST_MS)) buzzerTest_ = false;

  // ---- outputs ----
  bool hazard = smoke_ || flame_;
  out.buzzer = smoke_ || buzzerTest_;
  out.fan = smoke_ || cooldown_ || manualFan_;
  out.doorAngle = doorOpen_ ? cfg::DOOR_OPEN_ANGLE : cfg::DOOR_REST_ANGLE;
  out.ledRed = hazard;
  out.ledGreen = !hazard;
  out.lightWhite = !flame_;
  out.lightWarm = !flame_;
  bool sensorFault = mq2.quality == Quality::Disconnected || mq2.quality == Quality::Fault || flame.quality != Quality::Valid ||
                     water.quality != Quality::Valid || dht.quality != Quality::Valid;
  out.faultBlink = sensorFault || !linkOk;
}

CmdResult SafetyController::command(Actuator a, Action act, uint32_t ttlLeftMs, uint32_t now) {
  if (ttlLeftMs == 0) return CmdResult::RejectedExpired;
  if (a == Actuator::Fan && act == Action::On) { manualFan_ = true; out.fan = true; return CmdResult::ExecutedUnverified; }
  if (a == Actuator::Fan && act == Action::Off) {
    if (smoke_ || cooldown_) return CmdResult::RejectedInterlock;  // never switch the fan off during smoke/cooldown
    manualFan_ = false; out.fan = false; return CmdResult::ExecutedUnverified;
  }
  if (a == Actuator::Buzzer && act == Action::Test) { buzzerTest_ = true; buzzerTestAt_ = now; out.buzzer = true; return CmdResult::ExecutedUnverified; }
  return CmdResult::RejectedNotAllowed;
}

uint16_t SafetyController::fanCooldownLeftS(uint32_t now) const {
  if (!cooldown_) return 0;
  uint32_t e = now - cooldownAt_;
  return e >= cfg::FAN_COOLDOWN_MS ? 0 : (uint16_t)((cfg::FAN_COOLDOWN_MS - e + 999) / 1000);
}

}  // namespace orion
