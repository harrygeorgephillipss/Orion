"""Simulated home: start/stop, permissions, scenario switching, and that it really publishes over MQTT."""
import asyncio
import json

import aiomqtt
import pytest

from app.services import demo


async def _broker() -> bool:
    try:
        async with aiomqtt.Client("127.0.0.1", 1883, identifier="orion-demo-probe"):
            return True
    except aiomqtt.MqttError:
        return False


async def test_simulated_home(client, auth):
    assert (await client.get("/api/v1/devices/demo", headers=auth["viewer"])).json()["running"] is False
    assert (await client.post("/api/v1/devices/demo", headers=auth["member"])).status_code == 403
    assert (await client.post("/api/v1/devices/demo/scenario", json={"scenario": "flame"}, headers=auth["member"])).status_code == 404
    try:
        r = await client.post("/api/v1/devices/demo", headers=auth["admin"])
        assert r.status_code == 201
        assert (await client.post("/api/v1/devices/demo", headers=auth["admin"])).status_code == 409
        s = (await client.get("/api/v1/devices/demo", headers=auth["viewer"])).json()
        assert s["running"] is True and s["scenario"] == "normal" and "smoke_critical" in s["scenarios"]
        devs = (await client.get("/api/v1/devices", headers=auth["viewer"])).json()
        assert any(d["id"] == "esp32-sim" and d["simulated"] for d in devs["devices"])
        assert (await client.post("/api/v1/devices/demo/scenario", json={"scenario": "bogus"}, headers=auth["member"])).status_code == 422
        assert (await client.post("/api/v1/devices/demo/scenario", json={"scenario": "flame"}, headers=auth["viewer"])).status_code == 403
        assert (await client.post("/api/v1/devices/demo/scenario", json={"scenario": "flame"}, headers=auth["member"])).json()["scenario"] == "flame"
        if await _broker():  # the anonymous development broker (docs/TESTING.md)
            async with aiomqtt.Client("127.0.0.1", 1883, identifier="orion-demo-listener") as c:
                await c.subscribe("orion/home-1/esp32-sim/telemetry", qos=1)
                async with asyncio.timeout(15):
                    async for m in c.messages:
                        body = json.loads(m.payload)
                        flame = [x for x in body["readings"] if x["sensor"] == "flame-sim"][0]
                        if flame["state"] == "critical":
                            break
        else:
            pytest.skip("no development MQTT broker on 127.0.0.1:1883")
    finally:
        assert (await client.delete("/api/v1/devices/esp32-sim", headers=auth["owner"])).status_code == 200
        assert demo.running() is False
