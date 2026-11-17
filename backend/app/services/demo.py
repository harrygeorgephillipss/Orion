"""Simulated home ("demo"): runs the device simulator inside the server.

For trying ORION without hardware. The gateway is registered as *simulated*, so every reading, alert and SMS
attempt it produces is labelled simulated in the API, the apps and Aura, and push notifications are not sent for
it. It uses the real path (MQTT broker -> ingest -> database -> WebSocket), but proves nothing about real hardware.
"""
from __future__ import annotations

import argparse
import asyncio
import importlib.util
import logging
from pathlib import Path

from ..config import get_settings

log = logging.getLogger("orion.demo")
GATEWAY, CONTROLLER, GSM = "esp32-sim", "uno-sim", "gsm-sim"
SPEC = {
    "id": GATEWAY, "name": "ESP32 (simulated)", "simulated": True, "gsm_module_id": GSM,
    "controllers": [{"id": CONTROLLER, "name": "Arduino UNO (simulated)", "sensors": [
        {"id": "mq2-sim", "type": "mq2", "label": "MQ-2 smoke / gas", "room": "Hall"},
        {"id": "flame-sim", "type": "flame", "label": "Flame sensor", "room": "Kitchen"},
        {"id": "water-sim", "type": "water", "label": "Water sensor", "room": "Utility area"},
        {"id": "dht-sim", "type": "dht22", "label": "DHT22 temperature / humidity", "room": "Living room"},
    ]}],
}
_PATHS = [Path("/srv/orion/sim/sim_device.py"), Path(__file__).resolve().parents[3] / "hardware" / "communication" / "sim_device.py"]
_state: dict = {"task": None, "sim": None}


def _module():
    for p in _PATHS:
        if p.exists():
            spec = importlib.util.spec_from_file_location("orion_sim_device", p)
            mod = importlib.util.module_from_spec(spec)
            assert spec.loader
            spec.loader.exec_module(mod)
            return mod
    raise RuntimeError("device simulator not found")


def scenarios() -> list[str]:
    return list(_module().SCENARIOS)


def running() -> bool:
    t = _state["task"]
    return bool(t and not t.done())


def scenario() -> str | None:
    return _state["sim"].scenario if running() and _state["sim"] else None


def set_scenario(name: str) -> None:
    if _state["sim"]:
        _state["sim"].scenario = name


async def _run(secret: str) -> None:
    st = get_settings()
    mod = _module()
    a = argparse.Namespace(host=st.mqtt_host, port=st.mqtt_port, root=st.mqtt_topic_root, home=st.home_id, gateway=GATEWAY,
                           controller=CONTROLLER, gsm=GSM, username=GATEWAY, password=secret, scenario="normal",
                           interval=2.0, seed=7, interactive=False)
    sim = mod.Sim(a)
    _state["sim"] = sim
    delay = 2.0
    while True:  # the broker may need a few seconds to load the new account
        try:
            await sim.run()
        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - keep retrying; logged without secrets
            log.warning("simulated home: %s; retrying in %.0fs", type(e).__name__, delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30.0)


def start(secret: str) -> None:
    stop()
    _state["task"] = asyncio.create_task(_run(secret), name="demo")


def stop() -> None:
    t = _state["task"]
    if t and not t.done():
        t.cancel()
    _state["task"] = None
    _state["sim"] = None


async def resume() -> None:
    """After a server restart: give the simulated gateway a fresh password and start it again."""
    from ..db import sessionmaker
    from ..models import Device
    from ..security import new_device_secret
    from . import broker_users

    async with sessionmaker()() as db:
        gw = await db.get(Device, GATEWAY)
        if not gw or not gw.simulated:
            return
        secret, gw.secret_hash = new_device_secret()
        await db.commit()
    broker_users.upsert(GATEWAY, secret)
    start(secret)
