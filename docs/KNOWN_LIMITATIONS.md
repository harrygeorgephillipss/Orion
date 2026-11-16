# Known limitations and safety limitations

## Safety

- **ORION is a prototype and is not certified** for any safety purpose. It must not replace a certified smoke
  alarm, gas detector or fire-alarm system. Any claim otherwise would require independent testing and certification.
- **No hardware exists in the repository yet.** The local emergency logic, watchdogs and GSM alerting are designed
  (docs/hardware-architecture.md) but not implemented in firmware or tested. Until Phase 3/6 bench results exist,
  there is **no evidence** ORION protects anything.
- The MQ-2 is a non-selective sensor reporting raw ADC counts; ORION shows no ppm values and cannot tell smoke
  from other gases or cooking fumes. False positives and false negatives have not been measured.
- A flame sensor sees infrared from a flame in its field of view only; it does not detect smouldering fires.
- "SMS sent" means the modem accepted it; delivery is not confirmed. SIM800C is 2G-only — coverage depends on the
  operator (Jio has no 2G network) and may disappear when 2G is switched off.
- Without feedback sensors, ORION cannot know whether the fan, relay, door or buzzer physically operated.
- In a real fire or gas leak: evacuate and call **112** / **101** (fire, India). Don't wait for ORION or Aura.

## Software (current state)

- Aura's AI still depends on the Claude artifact host (Phase 4 replaces it); outside it Aura gives basic,
  English-only, rule-based answers.
- No Android app yet (Phase 5); no push notifications.
- TLS for HTTPS/MQTT is configured but untested. Rate limiting is per-process memory.
- Telemetry retention pruning exists but isn't scheduled.
- Real-time updates re-fetch the full overview on each event — fine for one home, not designed for many homes.
- Server settings (thresholds) never reach the firmware: the controller's own thresholds decide hazards and are
  reported back. Changing them requires a firmware change (by design, so a compromised server can't weaken them).
- The simulator mirrors planned firmware rules but is not the firmware; simulated results prove nothing about
  hardware behaviour.
- Fonts load from Google Fonts; offline/Android rendering of Indian scripts falls back to system fonts until fonts
  are bundled (Phase 5).
