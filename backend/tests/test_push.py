"""Push: registration, FCM HTTP v1 message shape, preference filtering, simulated incidents not pushed, stale tokens removed."""
from __future__ import annotations

import json

import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from sqlalchemy import select

from app.db import sessionmaker
from app.models import Incident, PushToken
from app.push.dispatcher import deliver
from app.push.fcm import FcmClient
from tests.helpers import nxt, reading, send

KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
PEM = KEY.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()
SA = {"client_email": "orion@test.iam.gserviceaccount.com", "private_key": PEM, "token_uri": "https://oauth2.googleapis.com/token"}


def fake_fcm(sent: list, dead: set):
    def handler(req: httpx.Request) -> httpx.Response:
        if req.url.host == "oauth2.googleapis.com":
            body = dict(x.split("=", 1) for x in req.content.decode().split("&"))
            claims = jwt.decode(body["assertion"], KEY.public_key(), algorithms=["RS256"], audience=SA["token_uri"])
            assert claims["scope"].endswith("firebase.messaging")
            return httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})
        assert req.headers["authorization"] == "Bearer tok"
        msg = json.loads(req.content)["message"]
        if msg["token"] in dead:
            return httpx.Response(404, json={"error": {"status": "NOT_FOUND"}})
        sent.append(msg)
        return httpx.Response(200, json={"name": "projects/p/messages/1"})
    return httpx.MockTransport(handler)


async def register(client, auth, role, token):
    r = await client.post("/api/v1/push/register", json={"token": token}, headers=auth[role])
    assert r.status_code == 200


async def real_flame(client, auth):
    r = await client.post("/api/v1/devices/gateways", json={"id": "esp32-real", "controllers": [{"id": "uno-real", "sensors": [{"id": "flame-r", "type": "flame", "label": "Flame", "room": "Kitchen"}]}]}, headers=auth["admin"])
    assert r.status_code == 201
    await send("heartbeat", {"seq": nxt(), "controllers": [{"id": "uno-real", "link_ok": True, "last_rx_ms_ago": 10}]}, gw="esp32-real")
    await send("telemetry", {"seq": nxt(), "controller": "uno-real", "readings": [reading("flame-r", {"detected": True}, state="critical")]}, gw="esp32-real")
    async with sessionmaker()() as db:
        return (await db.execute(select(Incident).where(Incident.type == "flame"))).scalar_one().id


async def test_push_for_real_critical_incident(client, auth):
    await register(client, auth, "viewer", "token-viewer-" + "x" * 20)
    await register(client, auth, "member", "token-member-" + "x" * 20)
    await register(client, auth, "owner", "token-dead---" + "x" * 20)
    r = await client.put("/api/v1/aura/preferences", json={"push": {"critical": False, "warning": True, "degraded": True}}, headers=auth["member"])
    assert r.status_code == 200
    inc_id = await real_flame(client, auth)
    sent: list = []
    fcm = FcmClient("proj", SA, transport=fake_fcm(sent, {"token-dead---" + "x" * 20}))
    n = await deliver(fcm, inc_id)
    assert n == 1, "member opted out of critical pushes; owner's token is dead"
    m = sent[0]
    assert m["token"].startswith("token-viewer")
    assert m["notification"]["title"] == "ORION — Flame detected"
    assert "Kitchen" in m["notification"]["body"] and "112" in m["notification"]["body"]
    assert m["data"]["type"] == "flame" and m["data"]["severity"] == "critical" and m["data"]["simulated"] == "false"
    assert m["android"]["priority"] == "HIGH" and m["android"]["notification"]["channel_id"] == "orion_emergency"
    async with sessionmaker()() as db:
        toks = [t.token for t in (await db.execute(select(PushToken))).scalars()]
    assert not any(t.startswith("token-dead") for t in toks), "unregistered tokens are removed"


async def test_simulated_incidents_are_not_pushed(gateway, client, auth):
    from tests.helpers import all_normal

    await register(client, auth, "viewer", "token-viewer-" + "y" * 20)
    await all_normal()
    await send("telemetry", {"seq": nxt(), "controller": "uno-test", "readings": [reading("water-1", {"raw_adc": 700}, state="warning")]})
    async with sessionmaker()() as db:
        inc = (await db.execute(select(Incident).where(Incident.type == "water"))).scalar_one()
    sent: list = []
    assert await deliver(FcmClient("proj", SA, transport=fake_fcm(sent, set())), inc.id) == 0
    assert sent == []


async def test_push_register_validation(client, auth):
    assert (await client.post("/api/v1/push/register", json={"token": "short"}, headers=auth["viewer"])).status_code == 422
    assert (await client.post("/api/v1/push/register", json={"token": "x" * 30})).status_code == 401
    assert (await client.get("/api/v1/push/status", headers=auth["viewer"])).json() == {"enabled": False}
