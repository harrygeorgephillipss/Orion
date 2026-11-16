"""End-to-end through a real Mosquitto broker: device publishes → backend ingests → command flows back.
Needs a development broker on localhost:1883 that accepts anonymous clients (see docs/TESTING.md).
Skipped when none is reachable, or when the broker on that port requires passwords."""
from __future__ import annotations

import asyncio
import json
import socket

import aiomqtt
import pytest
from sqlalchemy import select

from app import mqtt
from app.config import get_settings
from app.db import sessionmaker
from app.models import Sensor
from app.services import commands


def anonymous_broker() -> bool:
    try:
        socket.create_connection(("127.0.0.1", 1883), timeout=1).close()
    except OSError:
        return False

    async def probe() -> bool:
        try:
            async with aiomqtt.Client("127.0.0.1", 1883, identifier="orion-test-probe"):
                return True
        except aiomqtt.MqttError:
            return False

    return asyncio.run(probe())


pytestmark = pytest.mark.skipif(not anonymous_broker(), reason="no anonymous development MQTT broker on localhost:1883")


async def test_device_to_backend_and_command_back(gateway, client, auth):
    st = get_settings()
    task = asyncio.create_task(mqtt.run())
    try:
        for _ in range(50):
            if mqtt.state.connected:
                break
            await asyncio.sleep(0.1)
        assert mqtt.state.connected, mqtt.state.last_error
        base = f"{st.mqtt_topic_root}/{st.home_id}/esp32-test"
        async with aiomqtt.Client("127.0.0.1", 1883, identifier="sim-esp32-test") as dev:
            await dev.subscribe(base + "/cmd", qos=1)
            await dev.publish(base + "/heartbeat", json.dumps({"seq": 1, "controllers": [{"id": "uno-test", "link_ok": True, "last_rx_ms_ago": 100}]}), qos=1)
            await dev.publish(base + "/telemetry", json.dumps({"seq": 2, "controller": "uno-test", "readings": [{"sensor": "mq2-1", "fields": {"raw_adc": 222}, "quality": "valid", "state": "normal"}]}), qos=1)
            ok = False
            for _ in range(50):
                async with sessionmaker()() as db:
                    s = (await db.execute(select(Sensor).where(Sensor.id == "mq2-1"))).scalar_one()
                    if s.fields.get("raw_adc") == 222:
                        ok = True
                        break
                await asyncio.sleep(0.1)
            assert ok, "telemetry did not reach the database"
            assert commands._publisher is not None
            r = await client.post("/api/v1/commands", json={"actuator": "buzzer", "action": "test"}, headers=auth["member"])
            assert r.json()["status"] == "sent"
            msg = await asyncio.wait_for(anext(aiter(dev.messages)), timeout=5)
            body = json.loads(msg.payload)
            assert body["actuator"] == "buzzer" and body["command_id"] == r.json()["id"]
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        commands.set_publisher(None)
        mqtt.state.connected = False
