# ORION — Smart Home Safety & Automation (web app, Phase 1)

ORION is a prototype home-safety system (Arduino UNO + ESP32, MQ-2 smoke/gas, flame, water and DHT22 sensors,
exhaust fan, buzzer, LEDs, servo door, SIM800C GSM for SMS/calls). This is its web app, with **Aura**, an AI assistant.

## Files
- `index.html` — the whole app in one file (built). Open it in Chrome to run it with demo data.
- `src/` — the source, split by purpose. `build.py` joins them into `index.html` (`python3 build.py`).
  - `core.js` – config, formatting, list of undecided ("pending") hardware decisions
  - `sources.js` – data layer. `DemoSource` = deterministic simulation (scenarios: smoke, flame, leak, faults, offline…);
    `LiveSource` = placeholder for the Phase 2 backend. The UI only talks to this adapter interface.
  - `state.js` – freshness + overall state (NORMAL / ATTENTION / EMERGENCY / DEGRADED / OFFLINE)
  - `charts.js` – SVG charts; `components.js` – icons and shared UI pieces
  - `views.js` – Home, History, Alerts, Devices, Settings pages
  - `aura.js` – basic rule-based fallback answers
  - `aura-ai.js` – Aura's AI: prompt, ORION data context, tools (history, alerts, open page, propose command), languages
  - `aura-view.js` – Aura chat + voice mode (listening, silence timing, speaking)
  - `app.js` – routing, header, dialogs, demo scenarios; `styles.css` – calm dark/light themes

## Important: what only works inside Claude
Aura's AI, Claude's voices and Claude's mic use the Claude artifact platform (`window.claude.use('sample' | 'tts' | 'dictation')`).
Opened anywhere else, Aura falls back to basic English answers and the device's own voice. A standalone version
(Phase 2) would need its own backend that calls an AI API with a server-side key.

All readings are simulated demo data — no hardware is connected yet. ORION is not a certified safety device.
