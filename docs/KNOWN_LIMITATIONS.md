# Known limitations and safety limitations

## Safety

- **ORION is a prototype and is not certified** for any safety purpose. It must not replace a certified smoke
  alarm, gas detector or fire-alarm system. Any claim otherwise would require independent testing and certification.
- **The firmware has not been run on real boards.** The local emergency logic, watchdogs and GSM alerting are written,
  unit-tested on a PC and compile for the UNO and ESP32, but until bench results exist (docs/VALIDATION.md) there is
  **no evidence** ORION protects anything.
- A disconnected flame-sensor DO wire or water-sensor wire reads like "no hazard" and cannot be detected in firmware
  alone. MQ-2 disconnection (low rail) is detected; an MQ-2 stuck high is treated as an alarm (fail-safe).
- The MQ-2 is a non-selective sensor reporting raw ADC counts; ORION shows no ppm values and cannot tell smoke
  from other gases or cooking fumes. False positives and false negatives have not been measured.
- A flame sensor sees infrared from a flame in its field of view only; it does not detect smouldering fires.
- "SMS sent" means the modem accepted it; delivery is not confirmed. SIM800C is 2G-only — coverage depends on the
  operator (Jio has no 2G network) and may disappear when 2G is switched off.
- Without feedback sensors, ORION cannot know whether the fan, relay, door or buzzer physically operated.
- In a real fire or gas leak: evacuate and call **112** / **101** (fire, India). Don't wait for ORION or Aura.

## Software (current state)

- Aura's server-side AI has only been tested with a scripted provider; it has not been run against the real
  Anthropic API (no key in the build environment). Without a configured provider Aura gives basic English answers.
- The Android app builds but has not been run on a phone; push notifications need the owner's Firebase project and
  are untested end to end. The refresh token is protected by Android's app sandbox, not the hardware keystore.
- Emergency phone numbers for offline SMS live in the ESP32 firmware (`secrets.h`); changing them needs a re-flash.
- TLS for HTTPS/MQTT is configured but untested. Rate limiting is per-process memory.
- Telemetry retention pruning exists but isn't scheduled.
- Real-time updates re-fetch the full overview on each event — fine for one home, not designed for many homes.
- Server settings (thresholds) never reach the firmware: the controller's own thresholds decide hazards and are
  reported back. Changing them requires a firmware change (by design, so a compromised server can't weaken them).
- The simulator mirrors planned firmware rules but is not the firmware; simulated results prove nothing about
  hardware behaviour.
- Fonts load from Google Fonts; offline (and in the Android app without internet) Indian scripts fall back to the
  phone's system fonts, which Android includes for Malayalam, Hindi, Tamil and the other supported scripts.
