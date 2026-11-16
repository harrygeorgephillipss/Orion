from __future__ import annotations

import json
from datetime import timedelta

import pytest
from starlette.testclient import TestClient

from app.db import sessionmaker
from app.models import Command
from app.services import commands
from tests.helpers import all_normal, send


class FakeBroker:
    def __init__(self, fail: bool = False) -> None:
        self.sent: list[tuple[str, dict]] = []
        self.fail = fail

    async def __call__(self, topic: str, payload: bytes, retain: bool = False) -> None:
        if self.fail:
            raise ConnectionError("broker down")
        self.sent.append((topic, json.loads(payload)))


async def post(client, auth, role="member", **body):
    return await client.post("/api/v1/commands", json={"actuator": "fan", "action": "on", **body}, headers=auth[role])


async def test_command_without_broker_fails_honestly(gateway, client, auth):
    r = await post(client, auth)
    assert r.status_code == 201
    c = r.json()
    assert c["status"] == "failed" and "not connected" in c["history"][-1]["note"]


async def test_command_lifecycle_unverified(gateway, client, auth):
    fb = FakeBroker()
    commands.set_publisher(fb)
    c = (await post(client, auth)).json()
    assert [h["status"] for h in c["history"]] == ["requested", "queued", "sent"]
    assert c["simulated"] is True
    topic, body = fb.sent[0]
    assert topic == "orion/home-1/esp32-test/cmd"
    assert body["command_id"] == c["id"] and body["actuator"] == "fan" and body["ttl_ms"] == 30000
    assert (await post(client, auth)).status_code == 409, "one command at a time per controller"
    await send("cmd_ack", {"command_id": c["id"], "status": "accepted"})
    await send("cmd_ack", {"command_id": c["id"], "status": "executed_unverified"})
    r = await client.get("/api/v1/commands", headers=auth["viewer"])
    got = r.json()[0]
    assert got["status"] == "unknown" and got["result"] == "executed_unverified", "never 'completed' without feedback"


async def test_controller_interlock_rejection(gateway, client, auth):
    commands.set_publisher(FakeBroker())
    c = (await post(client, auth, action="off")).json()
    await send("cmd_ack", {"command_id": c["id"], "status": "rejected", "note": "Fan held ON during smoke"})
    got = (await client.get("/api/v1/commands", headers=auth["viewer"])).json()[0]
    assert got["status"] == "rejected" and "smoke" in got["history"][-1]["note"]


async def test_disallowed_and_unknown_controller(gateway, client, auth):
    commands.set_publisher(FakeBroker())
    assert (await post(client, auth, actuator="door", action="open")).status_code == 422
    assert (await post(client, auth, actuator="mist", action="on")).status_code == 422
    assert (await post(client, auth, device_id="ghost")).status_code == 404
    assert (await post(client, auth, role="viewer")).status_code == 403


async def test_publish_failure_marks_failed(gateway, client, auth):
    commands.set_publisher(FakeBroker(fail=True))
    assert (await post(client, auth)).json()["status"] == "failed"


async def test_expiry(gateway, client, auth):
    commands.set_publisher(FakeBroker())
    c = (await post(client, auth)).json()
    async with sessionmaker()() as db:
        row = await db.get(Command, c["id"])
        row.expires_at = row.expires_at - timedelta(minutes=5)
        await db.commit()
        assert await commands.expire(db) == 1
        await db.commit()
    got = (await client.get("/api/v1/commands", headers=auth["viewer"])).json()[0]
    assert got["status"] == "expired"


async def test_ack_from_wrong_gateway_rejected(gateway, client, auth):
    from app.services.ingest import IngestError

    commands.set_publisher(FakeBroker())
    c = (await post(client, auth)).json()
    r = await client.post("/api/v1/devices/gateways", json={"id": "esp32-other"}, headers=auth["admin"])
    assert r.status_code == 201
    with pytest.raises(IngestError):
        await send("cmd_ack", {"command_id": c["id"], "status": "accepted"}, gw="esp32-other")


def test_websocket_requires_auth_and_streams(auth):
    from app.main import app

    tc = TestClient(app)
    with tc.websocket_connect("/api/v1/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "token": "nope"}))
        with pytest.raises(Exception):
            ws.receive_json()
    token = auth["viewer"]["Authorization"].split()[1]
    with tc.websocket_connect("/api/v1/ws") as ws:
        ws.send_text(json.dumps({"type": "auth", "token": token}))
        assert ws.receive_json()["type"] == "ready"
        # A real state change made through the API is pushed to the socket.
        r = tc.put("/api/v1/config/home", json={"name": "Test home", "timezone": "Asia/Kolkata"}, headers=auth["admin"])
        assert r.status_code == 200
        msg = ws.receive_json()
        while msg["type"] == "tick":
            msg = ws.receive_json()
        assert msg["type"] == "update" and msg["reason"] == "config"
        ws.send_text("ping")
        assert ws.receive_text() == "pong"


async def test_overview_reflects_ingest(gateway, client, auth):
    await all_normal()
    o = (await client.get("/api/v1/overview", headers=auth["viewer"])).json()
    assert o["controllers"]["uno-test"]["last_seen_at"] is not None


async def test_contacts_are_pushed_to_gateways_as_retained_config(gateway, client, auth):
    fb = FakeBroker()
    commands.set_publisher(fb)
    r = await client.post("/api/v1/contacts", json={"name": "Mum", "phone": "+919812345678", "sms": True, "call": True}, headers=auth["admin"])
    assert r.status_code == 201 and r.json()["gateways_updated"] == 1
    topic, body = fb.sent[-1]
    assert topic == "orion/home-1/esp32-test/config"
    assert body["contacts"] == [{"name": "Mum", "phone": "+919812345678", "sms": True, "call": True}]
    cid = r.json()["id"]
    assert (await client.delete(f"/api/v1/contacts/{cid}", headers=auth["admin"])).json()["gateways_updated"] == 1
    assert fb.sent[-1][1]["contacts"] == []
