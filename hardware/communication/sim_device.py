#!/usr/bin/env python3
"""ORION device simulator — emulates an ESP32 gateway + Arduino UNO over the real MQTT protocol.

It exists to test the server, apps and fault handling WITHOUT hardware. Register it as a *simulated* gateway
(POST /api/v1/devices/gateways with "simulated": true) so every reading it produces is labelled simulated.
It mirrors the planned firmware rules (smoke → buzzer, fan, door servo; flame → lights off + SMS/call request),
but it is NOT the firmware and proves nothing about real hardware behaviour.

Usage (from repo root, using the backend virtualenv):
  backend/.venv/bin/python hardware/communication/sim_device.py --gateway esp32-sim --controller uno-sim \
      --username esp32-sim --password '<from registration>' [--scenario normal]
Type a scenario name + Enter while running: normal, smoke_warning, smoke_critical, flame, water, dht_fault,
dht_stale, uno_offline, gsm_outage, quit.  'gateway_offline' simply means: stop this program (the broker's
last-will message then marks the gateway offline).
"""
from __future__ import annotations

import argparse
import asyncio
import json
import random
import sys
import time

import aiomqtt

SCENARIOS = ["normal", "smoke_warning", "smoke_critical", "flame", "water", "dht_fault", "dht_stale", "uno_offline", "gsm_outage"]


class Sim:
    def __init__(self, a: argparse.Namespace) -> None:
        self.a = a
        self.base = f"{a.root}/{a.home}/{a.gateway}"
        self.scenario = a.scenario
        self.seq = 0
        self.rng = random.Random(a.seed)
        self.cur = {"mq2": 175.0, "water": 34.0, "temp": 29.0, "hum": 72.0}
        self.fw = {"smoke": False, "flame": False, "cool_until": 0.0, "door_until": 0.0, "buzz_test_until": 0.0, "manual_fan": None}
        self.events: list[dict] = []
        self.gsm_attempts: list[dict] = []
        self.th = {"warning": 350, "critical": 500, "wet": 300}
        self.t0 = time.time()

    def nxt(self) -> int:
        self.seq += 1
        return self.seq

    # ---- physics + simulated UNO firmware ----
    def step(self) -> None:
        sc, r = self.scenario, self.rng
        mq2_t = {"smoke_warning": 428, "smoke_critical": 588, "flame": 315}.get(sc, 172)
        water_t = 640 if sc == "water" else 34
        self.cur["mq2"] += (mq2_t - self.cur["mq2"]) * 0.35 + (r.random() - 0.5) * 10
        self.cur["water"] += (water_t - self.cur["water"]) * 0.5 + (r.random() - 0.5) * 8
        self.cur["temp"] += (29.0 - self.cur["temp"]) * 0.05 + (r.random() - 0.5) * 0.08
        self.cur["hum"] += (72.0 - self.cur["hum"]) * 0.05 + (r.random() - 0.5) * 0.4
        now = time.time()
        fw = self.fw
        smoke_on = self.cur["mq2"] >= (self.th["warning"] - 25 if fw["smoke"] else self.th["warning"])
        if smoke_on and not fw["smoke"]:
            fw.update(smoke=True, cool_until=0.0, door_until=now + 5)
            self.event("smoke", "mq2-sim", "Red LED ON, green LED OFF; buzzer ON; exhaust fan ON; MG995 target 180° for 5 s")
        elif not smoke_on and fw["smoke"]:
            fw.update(smoke=False, cool_until=now + 60)
            self.event("smoke", "mq2-sim", "Smoke ended: buzzer OFF; fan cooldown 60 s started")
        flame = sc == "flame"
        if flame and not fw["flame"]:
            fw["flame"] = True
            self.event("flame", "flame-sim", "Red LED ON; white + warm-white lights OFF; GSM SMS and call requested")
            for kind in ("sms", "call"):
                self.gsm_attempts.append({"id": f"gsm-{int(now * 1000)}-{kind}", "type": kind, "destination": "+910000000000", "status": "queued", "note": "Queued on gateway (simulated)", "hazard": "flame", "sensor": "flame-sim", "_t": now})
        elif not flame and fw["flame"]:
            fw["flame"] = False
            self.event("flame", "flame-sim", "Flame ended: model lights restored")
        for g in self.gsm_attempts:
            age = now - g["_t"]
            if g["status"] in ("queued", "sending") and sc == "gsm_outage":
                g.update(status="failed", note="Modem not registered on network (AT+CREG?)", error_code="NOT REGISTERED")
            elif g["type"] == "sms" and g["status"] == "queued" and age > 2:
                g.update(status="sending", note="AT+CMGS issued")
            elif g["type"] == "sms" and g["status"] == "sending" and age > 6:
                g.update(status="sent", note="Modem accepted (+CMGS). Delivery not confirmed.")
            elif g["type"] == "call" and g["status"] == "queued" and age > 4:
                g.update(status="sending", note="Dialling (ATD)…")
            elif g["type"] == "call" and g["status"] == "sending" and age > 34:
                g.update(status="timeout", note="Dialled; no answer within 30 s.", error_code="NO ANSWER")

    def fan_on(self) -> bool:
        now = time.time()
        return self.fw["smoke"] or now < self.fw["cool_until"] or self.fw["manual_fan"] == "on"

    def event(self, hazard: str, sensor: str, text: str) -> None:
        self.events.append({"hazard": hazard, "sensor": sensor, "text": text})

    def readings(self) -> list[dict]:
        sc = self.scenario
        mq = max(0, min(1023, round(self.cur["mq2"])))
        mq_state = "critical" if mq >= self.th["critical"] else "warning" if mq >= self.th["warning"] else "normal"
        wv = max(0, min(1023, round(self.cur["water"])))
        out = [
            {"sensor": "mq2-sim", "fields": {"raw_adc": mq}, "quality": "valid", "state": mq_state, "age_ms": 300, "fw_threshold": {"warning": self.th["warning"], "critical": self.th["critical"]}},
            {"sensor": "flame-sim", "fields": {"detected": sc == "flame", "digital_value": 0 if sc == "flame" else 1}, "quality": "valid", "state": "critical" if sc == "flame" else "normal", "age_ms": 300},
            {"sensor": "water-sim", "fields": {"raw_adc": wv, "wet": wv >= self.th["wet"]}, "quality": "valid", "state": "warning" if wv >= self.th["wet"] else "normal", "age_ms": 300, "fw_threshold": {"wet": self.th["wet"]}},
        ]
        if sc == "dht_fault":
            out.append({"sensor": "dht-sim", "fields": {"temperature_c": None, "humidity_percent": None}, "quality": "fault", "state": "unknown", "fault": "read failure (checksum / timeout)", "age_ms": 300})
        elif sc != "dht_stale":
            out.append({"sensor": "dht-sim", "fields": {"temperature_c": round(self.cur["temp"], 1), "humidity_percent": round(self.cur["hum"], 1)}, "quality": "valid", "state": "normal", "age_ms": 300})
        return out

    def actuators(self) -> dict:
        now = time.time()
        hazard = self.fw["smoke"] or self.fw["flame"]
        fan = "on" if self.fan_on() else "off"
        buzzer = "on" if self.fw["smoke"] or now < self.fw["buzz_test_until"] else "off"
        door = 180 if now < self.fw["door_until"] else 0
        return {
            "fan": {"id": "fan", "name": "12 V exhaust fan", "commanded": fan, "by": "simulated firmware", "last_changed_at": int(now * 1000), "cooldown_remaining_s": max(0, int(self.fw["cool_until"] - now)) if not self.fw["smoke"] else 0, "feedback": False},
            "relay": {"id": "relay", "name": "5 V relay module", "channels": [{"ch": 1, "load": "Exhaust fan (planned mapping)", "commanded": "energised" if fan == "on" else "de-energised"}], "active_level": "unverified", "feedback": False},
            "buzzer": {"id": "buzzer", "name": "Buzzer", "commanded": buzzer, "pattern": "continuous" if self.fw["smoke"] else None, "feedback": False},
            "mg995": {"id": "mg995", "name": "MG995 servo — model door", "target_angle": door, "reported_position": None, "feedback": False},
            "sg90": {"id": "sg90", "name": "SG90 servo — purpose pending", "target_angle": None, "feedback": False},
            "leds": {"id": "leds", "name": "Indicator LEDs", "feedback": False, "items": [
                {"id": "led-green", "name": "Green — status normal", "color": "green", "commanded": "off" if hazard else "on"},
                {"id": "led-red", "name": "Red — warning", "color": "red", "commanded": "on" if hazard else "off"},
                {"id": "led-white", "name": "White — model lighting", "color": "white", "commanded": "off" if self.fw["flame"] else "on"},
                {"id": "led-warm", "name": "Warm-white — model lighting", "color": "warm", "commanded": "off" if self.fw["flame"] else "on"},
            ]},
        }

    async def on_command(self, client: aiomqtt.Client, body: dict) -> None:
        cid, act, action = body.get("command_id"), body.get("actuator"), body.get("action")
        ack = lambda status, note="": client.publish(f"{self.base}/cmd_ack", json.dumps({"command_id": cid, "status": status, "note": note}), qos=1)  # noqa: E731
        if self.scenario == "uno_offline":
            return  # the controller never answers → the server expires the command
        await asyncio.sleep(0.8)
        if act == "fan" and action == "off" and (self.fw["smoke"] or time.time() < self.fw["cool_until"]):
            await ack("rejected", "Local rule: fan held ON during smoke / cooldown (simulated controller)")
            return
        if (act, action) not in {("fan", "on"), ("fan", "off"), ("buzzer", "test")}:
            await ack("rejected", "Not allowed by controller allow-list")
            return
        await ack("accepted")
        if act == "fan":
            self.fw["manual_fan"] = action
        else:
            self.fw["buzz_test_until"] = time.time() + 2
        await asyncio.sleep(0.5)
        await ack("executed_unverified", "Output driven (simulated); no feedback sensor")

    async def run(self) -> None:
        a = self.a
        will = aiomqtt.Will(topic=f"{self.base}/status", payload=json.dumps({"online": False}), qos=1, retain=True)
        async with aiomqtt.Client(a.host, a.port, username=a.username or None, password=a.password or None, identifier=a.gateway, will=will, keepalive=15) as client:
            await client.publish(f"{self.base}/status", json.dumps({"online": True, "fw": "0.1.0-sim", "boot_reason": "power_on"}), qos=1, retain=True)
            await client.subscribe(f"{self.base}/cmd", qos=1)
            print(f"[sim] connected as {a.gateway}; scenario={self.scenario}. Type a scenario name + Enter.", flush=True)

            async def listen() -> None:
                async for msg in client.messages:
                    try:
                        body = json.loads(msg.payload)
                    except ValueError:
                        continue
                    if body.get("controller") == a.controller:
                        asyncio.create_task(self.on_command(client, body))

            async def stdin() -> None:
                loop = asyncio.get_running_loop()
                while True:
                    line = (await loop.run_in_executor(None, sys.stdin.readline)).strip()
                    if not line:
                        if sys.stdin.closed or line == "":
                            await asyncio.sleep(1)
                        continue
                    if line == "quit":
                        raise SystemExit(0)
                    if line in SCENARIOS:
                        self.scenario = line
                        print(f"[sim] scenario → {line}", flush=True)

            async def loop_() -> None:
                while True:
                    self.step()
                    uno_up = self.scenario != "uno_offline"
                    hb = {"seq": self.nxt(), "uptime_s": int(time.time() - self.t0), "rssi": -55 - self.rng.randint(0, 6),
                          "controllers": [{"id": a.controller, "link_ok": uno_up, "last_rx_ms_ago": 150 if uno_up else None, "fw": "0.1.0-sim", "boot_reason": "power_on"}]}
                    await client.publish(f"{self.base}/heartbeat", json.dumps(hb), qos=1)
                    if uno_up:
                        await client.publish(f"{self.base}/telemetry", json.dumps({"seq": self.nxt(), "controller": a.controller, "readings": self.readings()}), qos=1)
                        await client.publish(f"{self.base}/actuators", json.dumps({"seq": self.nxt(), "controller": a.controller, "actuators": self.actuators()}), qos=1)
                        while self.events:
                            e = self.events.pop(0)
                            await client.publish(f"{self.base}/event", json.dumps({"seq": self.nxt(), "controller": a.controller, "kind": "action", **e}), qos=1)
                    gsm_ok = self.scenario != "gsm_outage"
                    attempts = [{k: v for k, v in g.items() if not k.startswith("_")} for g in self.gsm_attempts[-6:]]
                    await client.publish(f"{self.base}/gsm", json.dumps({"seq": self.nxt(), "module": {"id": a.gsm, "registered": gsm_ok, "csq": 17 if gsm_ok else 99, "operator": "Simulated 2G" if gsm_ok else None, "sim": "READY"}, "attempts": attempts}), qos=1)
                    await asyncio.sleep(a.interval)

            await asyncio.gather(listen(), stdin(), loop_())


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default="localhost")
    p.add_argument("--port", type=int, default=1883)
    p.add_argument("--root", default="orion")
    p.add_argument("--home", default="home-1")
    p.add_argument("--gateway", default="esp32-sim")
    p.add_argument("--controller", default="uno-sim")
    p.add_argument("--gsm", default="gsm-sim")
    p.add_argument("--username", default="")
    p.add_argument("--password", default="")
    p.add_argument("--scenario", default="normal", choices=SCENARIOS)
    p.add_argument("--interval", type=float, default=2.0)
    p.add_argument("--seed", type=int, default=7)
    a = p.parse_args()
    try:
        asyncio.run(Sim(a).run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
