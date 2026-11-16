# SIM800C setup

1. **SIM**: a 2G-capable SIM with SMS credit and calling (Airtel/Vi currently; Jio has no 2G). Remove the PIN lock
   (put it in a phone and disable "SIM PIN") — the firmware does not enter PINs.
2. **Power**: dedicated buck at **4.0 V, ≥ 2 A**, ≥ 1000 µF low-ESR capacitor close to the module. Under-powered
   modules reset during transmit bursts (symptom: SMS fails, modem power-cycles).
3. **Antenna**: always attached before power-on.
4. **Wiring**: TXD → ESP32 GPIO26, RXD ← GPIO27, PWRKEY via NPN on GPIO25, common ground. Check your breakout's
   logic level (2.8 V/3.3 V boards are fine with the ESP32; 5 V boards need shifting).
5. **Numbers**: add them in the app (**Settings → Emergency contacts**, admin). The server sends the list to the
   gateway, which stores it in flash and uses it offline; the first contact marked "call" is phoned.
   `EMERGENCY_NUMBERS` in `secrets.h` is only a fallback used until the gateway has received a list.
6. **Check**: on the ORION Devices page → "Text & call alerts": the module should show "Can text & call" with a
   signal value (CSQ 10–31 is usable; 99 = unknown).

What ORION reports: `sent` = modem accepted (`+CMGS`), **not delivered**. `answered` = the call was connected
(`+COLP`). `failed` with the modem's reason, `timeout` = no answer within 30 s. Failed SMS are retried up to 3 times;
nothing is sent while the module is not registered — those attempts are reported as failed, never as sent.

Manual test (bench): trigger the flame sensor with a lighter **at a safe distance outdoors or with an IR remote/LED
substitute where possible** — or simulate the DO line — and confirm the SMS arrives on the phone. Record the result
in [BENCH_TESTS.md](BENCH_TESTS.md).
