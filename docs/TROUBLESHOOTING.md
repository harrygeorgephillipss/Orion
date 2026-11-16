# Troubleshooting

| Symptom | Check |
|---|---|
| App says **Offline · gateway disconnected** | ESP32 powered? Wi-Fi in range? `pio device monitor` on the ESP32; broker reachable from the ESP32's network; password in `secrets.h` = the one returned at registration and added with `scripts/mqtt_passwd.py`; broker restarted after adding it |
| **Arduino UNO not responding** | UNO powered? UART wires crossed (TX→RX) through the level shifter; common ground; 38400 baud on both; UNO not stuck in a reset loop (watchdog → boot reason "watchdog") |
| A sensor shows **No reading / Not updating** | wiring of that sensor; for DHT22 the pull-up resistor; check `Diagnostics` in Settings for quality and sequence numbers |
| MQ-2 stays **Warming up** | expected for the warm-up period after power-on; longer means the heater isn't powered |
| Server log: `rejected … not registered` | the ids in `secrets.h` must match the registration exactly (gateway, controller, sensors, GSM module) |
| **GSM: No network** | 2G SIM? antenna? 4 V/2 A supply? CSQ 99 means no signal |
| SMS shows **failed** | read the note: not registered, modem error, or no response (power) |
| Fan command **rejected** | expected during smoke and its 60 s cooldown — the safety controller refuses to switch the fan off |
| Command **expired** | the UNO didn't answer within 30 s — check the UNO link |
| Aura answers in **basic mode** | `AURA_PROVIDER`, `AURA_MODEL`, `ANTHROPIC_API_KEY` on the server; Aura ⓘ panel shows the reason |
| Can't sign in: **account locked** | 5 wrong passwords → wait 5 minutes |
| Broker container exits | `docker compose logs mqtt`; check `deployment/mosquitto/entrypoint.sh` is mounted and the `mqttauth` volume exists |
| Gateway rejected by the broker | password in `secrets.h` must be the one shown at registration; re-register the gateway to get a new one |
