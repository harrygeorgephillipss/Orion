from __future__ import annotations

import json

from app.db import sessionmaker
from app.services import engine, ingest

SEQ = {"n": 0}


def nxt() -> int:
    SEQ["n"] += 1
    return SEQ["n"]


async def send(kind: str, payload: dict, gw: str = "esp32-test", home: str = "home-1") -> str:
    async with sessionmaker()() as db:
        k = await ingest.handle(db, f"orion/{home}/{gw}/{kind}", json.dumps(payload))
        await db.commit()
        return k


async def tick() -> bool:
    async with sessionmaker()() as db:
        ch = await engine.evaluate(db)
        await db.commit()
        return ch


def reading(sensor: str, fields: dict, state: str = "normal", quality: str = "valid", **kw) -> dict:
    return {"sensor": sensor, "fields": fields, "state": state, "quality": quality, "age_ms": 300, **kw}


NORMAL = [
    reading("mq2-1", {"raw_adc": 170}, fw_threshold={"warning": 350, "critical": 500}),
    reading("flame-1", {"detected": False, "digital_value": 1}),
    reading("water-1", {"raw_adc": 30, "wet": False}, fw_threshold={"wet": 300}),
    reading("dht-1", {"temperature_c": 29.4, "humidity_percent": 71.0}),
]


async def all_normal() -> None:
    await send("heartbeat", {"seq": nxt(), "uptime_s": 100, "rssi": -60, "controllers": [{"id": "uno-test", "link_ok": True, "last_rx_ms_ago": 200, "fw": "0.1.0"}]})
    await send("telemetry", {"seq": nxt(), "controller": "uno-test", "readings": NORMAL})
    await send("gsm", {"seq": nxt(), "module": {"id": "gsm-test", "registered": True, "csq": 17, "operator": "Test 2G"}})


def dumps(o) -> str:
    return json.dumps(o)
