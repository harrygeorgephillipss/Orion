"""Aura: safety layer, tool permissions, proposals, memory, audit — using the scripted MockProvider (no AI key needed)."""
from __future__ import annotations

import json
from datetime import timedelta

import pytest
from sqlalchemy import select

from app.config import get_settings
from app.db import sessionmaker
from app.models import AuditLog, AuraMessage, AuraProposal, Command
from tests.helpers import all_normal, nxt, reading, send


@pytest.fixture
def mock_ai():
    st = get_settings()
    old = st.aura_provider
    st.aura_provider = "mock"
    yield
    st.aura_provider = old


async def chat(client, auth, role, message, **kw):
    r = await client.post("/api/v1/aura/chat", json={"message": message, **kw}, headers=auth[role])
    assert r.status_code == 200, r.text
    return [json.loads(line[6:]) for line in r.text.split("\n") if line.startswith("data: ")]


async def test_unconfigured_ai_still_gives_emergency_advice(client, auth):
    st = await client.get("/api/v1/aura/status", headers=auth["viewer"])
    assert st.json()["available"] is False
    evs = await chat(client, auth, "viewer", "there is smoke in the kitchen, help")
    assert evs[0]["type"] == "safety" and "112" in evs[0]["text"]
    assert evs[-1]["type"] == "unavailable"


async def test_malayalam_emergency_words_trigger_safety(client, auth):
    evs = await chat(client, auth, "viewer", "അടുക്കളയിൽ തീ")
    assert evs[0]["type"] == "safety"


async def test_answer_uses_tools_and_labels_simulated(gateway, client, auth, mock_ai):
    await all_normal()
    evs = await chat(client, auth, "viewer", "what is the temperature?")
    kinds = [e["type"] for e in evs]
    assert "step" in kinds and kinds[-1] == "done"
    done = evs[-1]
    assert "29.4" in done["text"] and '"simulated": true' in done["text"]
    async with sessionmaker()() as db:
        msgs = (await db.execute(select(AuraMessage).where(AuraMessage.conversation_id == done["conversation_id"]))).scalars().all()
        assert [m.role for m in msgs] == ["user", "assistant"]
        logs = (await db.execute(select(AuditLog).where(AuditLog.actor_type == "aura"))).scalars().all()
        assert any(l.action == "aura.tool.get_sensor_readings" for l in logs)
    # conversation memory is per user
    assert (await client.get(f"/api/v1/aura/conversations/{done['conversation_id']}", headers=auth["member"])).status_code == 404
    assert (await client.get(f"/api/v1/aura/conversations/{done['conversation_id']}", headers=auth["viewer"])).status_code == 200


async def test_stale_data_reported_as_stale(gateway, client, auth, mock_ai, db):
    from app.models import Sensor

    await all_normal()
    s = await db.get(Sensor, "dht-1")
    s.received_at = s.received_at - timedelta(minutes=10)
    await db.commit()
    done = (await chat(client, auth, "viewer", "temperature?"))[-1]
    assert "STALE" in done["text"]


async def test_proposal_requires_confirmation_and_never_runs_itself(gateway, client, auth, mock_ai):
    await all_normal()
    evs = await chat(client, auth, "member", "please turn on the fan")
    props = [e for e in evs if e["type"] == "action" and str(e.get("id", "")).startswith("prop")]
    assert len(props) == 1 and props[0]["actuator"] == "fan"
    async with sessionmaker()() as db:
        assert (await db.execute(select(Command))).scalars().all() == [], "Aura must not create commands itself"
    pid = props[0]["id"]
    assert (await client.post(f"/api/v1/aura/proposals/{pid}/confirm", headers=auth["owner"])).status_code == 404, "only the user it was shown to"
    r = await client.post(f"/api/v1/aura/proposals/{pid}/confirm", headers=auth["member"])
    assert r.status_code == 200 and r.json()["origin"] == "aura_proposal"
    assert (await client.post(f"/api/v1/aura/proposals/{pid}/confirm", headers=auth["member"])).status_code == 409


async def test_viewer_and_forbidden_commands_get_no_proposal(gateway, client, auth, mock_ai):
    evs = await chat(client, auth, "viewer", "turn on the fan")
    assert not [e for e in evs if e["type"] == "action"]
    assert "viewer" in evs[-1]["text"]
    evs = await chat(client, auth, "owner", "unlock the door")
    assert not [e for e in evs if e["type"] == "action"]
    assert "Not allowed" in evs[-1]["text"]


async def test_expired_proposal(gateway, client, auth, mock_ai):
    evs = await chat(client, auth, "member", "turn on the fan")
    pid = next(e["id"] for e in evs if e["type"] == "action")
    async with sessionmaker()() as db:
        p = await db.get(AuraProposal, pid)
        p.expires_at = p.expires_at - timedelta(minutes=10)
        await db.commit()
    assert (await client.post(f"/api/v1/aura/proposals/{pid}/confirm", headers=auth["member"])).status_code == 410


async def test_real_critical_incident_forces_safety_preamble(client, auth, mock_ai):
    r = await client.post("/api/v1/devices/gateways", json={"id": "esp32-real", "controllers": [{"id": "uno-real", "sensors": [{"id": "flame-r", "type": "flame", "label": "Flame"}]}]}, headers=auth["admin"])
    assert r.status_code == 201
    await send("heartbeat", {"seq": nxt(), "controllers": [{"id": "uno-real", "link_ok": True, "last_rx_ms_ago": 10}]}, gw="esp32-real")
    await send("telemetry", {"seq": nxt(), "controller": "uno-real", "readings": [reading("flame-r", {"detected": True}, state="critical")]}, gw="esp32-real")
    evs = await chat(client, auth, "viewer", "hello")
    assert evs[0]["type"] == "safety" and "active emergency" in evs[0]["text"]


async def test_open_page_action_and_tool_set_is_read_only(gateway, client, auth, mock_ai):
    from app.aura.tools import TOOLS

    names = {t.name for t in TOOLS}
    assert names == {"get_system_status", "get_sensor_readings", "get_sensor_history", "get_alerts", "get_incident_history", "get_device_status",
                     "get_gsm_status", "get_controller_health", "open_dashboard_page", "propose_device_command"}
    evs = await chat(client, auth, "viewer", "show me the temperature chart")
    act = [e for e in evs if e["type"] == "action"]
    assert act and act[0]["page"] == "history"


async def test_preferences_are_user_owned(client, auth):
    r = await client.put("/api/v1/aura/preferences", json={"language": "ml", "speak_replies": False}, headers=auth["viewer"])
    assert r.status_code == 200
    assert (await client.get("/api/v1/aura/preferences", headers=auth["viewer"])).json()["language"] == "ml"
    assert (await client.get("/api/v1/aura/preferences", headers=auth["member"])).json()["language"] == "auto"
