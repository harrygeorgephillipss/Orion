from __future__ import annotations

import asyncio
from datetime import timedelta

import pytest
from sqlalchemy import select

from app.models import Device, Incident, Sensor, Telemetry
from app.services.ingest import IngestError
from app.db import sessionmaker
from tests.helpers import NORMAL, all_normal, nxt, reading, send, tick


async def fresh(model, id_, fn=lambda o: o):
    """Read a row in a new session and evaluate fn on it while the session is open."""
    async with sessionmaker()() as s:
        o = await s.get(model, id_)
        return fn(o)


async def overview(client, auth):
    r = await client.get("/api/v1/overview", headers=auth["viewer"])
    assert r.status_code == 200
    return r.json()


async def active(db, type_=None):
    q = select(Incident).where(Incident.state == "active")
    if type_:
        q = q.where(Incident.type == type_)
    db.expire_all()
    return list((await db.execute(q)).scalars())


async def test_registration_returns_one_time_mqtt_secret(gateway, client, auth):
    assert gateway["mqtt"]["username"] == "esp32-test"
    assert len(gateway["mqtt"]["password"]) >= 24
    r = await client.post("/api/v1/devices/gateways", json={"id": "esp32-test"}, headers=auth["admin"])
    assert r.status_code == 409


async def test_empty_overview_before_registration(client, auth):
    assert (await overview(client, auth))["status"] == "empty"


async def test_normal_flow_and_simulated_flags(gateway, client, auth, db):
    await all_normal()
    o = await overview(client, auth)
    assert o["status"] == "ok" and o["simulated"] is True
    assert set(o["sensors"]) == {"mq2-1", "flame-1", "water-1", "dht-1"}
    assert all(s["simulated"] for s in o["sensors"].values())
    assert o["sensors"]["dht-1"]["fields"]["temperature_c"] == 29.4
    assert o["controllers"]["esp32-test"]["is_gateway"] is True
    assert o["sensors"]["mq2-1"]["controller"] == "uno-test"
    assert o["gsm"]["network_registered"] is True
    assert not [i for i in o["incidents"] if i["state"] == "active"]
    n = (await db.execute(select(Telemetry))).scalars().all()
    assert len(n) == 5  # mq2, flame, water, temp, hum
    assert all(t.simulated for t in n)


async def test_rejects_unknown_gateway_sensor_and_bad_payloads(gateway):
    with pytest.raises(IngestError):
        await send("heartbeat", {"seq": 1}, gw="esp32-other")
    with pytest.raises(IngestError):
        await send("telemetry", {"seq": 1, "controller": "uno-test", "readings": [reading("nope", {"raw_adc": 1})]})
    with pytest.raises(IngestError):
        await send("telemetry", {"seq": 1, "controller": "uno-test", "readings": [{"sensor": "mq2-1"}]})
    with pytest.raises(IngestError):
        await send("telemetry", "not json")  # type: ignore[arg-type]
    with pytest.raises(IngestError):
        await send("bogus", {"seq": 1})
    with pytest.raises(IngestError):
        await send("telemetry", {"seq": 1, "controller": "uno-test", "readings": [reading("mq2-1", {"raw_adc": 5}, quality="excellent")]})


async def test_out_of_range_value_becomes_fault_not_value(gateway, db):
    await all_normal()
    await send("telemetry", {"seq": nxt(), "controller": "uno-test", "readings": [reading("dht-1", {"temperature_c": 300, "humidity_percent": 50})]})
    db.expire_all()
    s = await db.get(Sensor, "dht-1")
    assert s.quality == "fault" and s.fields["temperature_c"] is None and s.state == "unknown"
    assert [i.type for i in await active(db)] == ["sensor_fault"]


async def test_smoke_escalation_firmware_action_and_gsm_link(gateway, db):
    await all_normal()
    await send("telemetry", {"seq": nxt(), "controller": "uno-test", "readings": [reading("mq2-1", {"raw_adc": 420}, state="warning", fw_threshold={"warning": 350, "critical": 500})]})
    [inc] = await active(db, "smoke")
    assert inc.severity == "warning" and inc.simulated
    await send("event", {"seq": nxt(), "controller": "uno-test", "hazard": "smoke", "sensor": "mq2-1", "text": "Buzzer ON; exhaust fan ON"})
    await send("telemetry", {"seq": nxt(), "controller": "uno-test", "readings": [reading("mq2-1", {"raw_adc": 560}, state="critical", fw_threshold={"warning": 350, "critical": 500})]})
    await send("gsm", {"seq": nxt(), "module": {"id": "gsm-test", "registered": True, "csq": 15}, "attempts": [{"id": "a1", "type": "sms", "destination": "+919800000042", "status": "sent", "note": "Modem accepted (+CMGS)", "hazard": "smoke", "sensor": "mq2-1"}]})
    inc = await fresh(Incident, inc.id)
    assert inc.severity == "critical"
    assert inc.snapshot["peak"] == 560
    acts = [a.action for a in inc.actions]
    assert "Buzzer ON; exhaust fan ON" in acts
    sms = next(a for a in inc.actions if a.gsm_attempt_id == "a1")
    assert "42" in sms.action and "9800000042" not in sms.action, "destination must be masked"
    assert sms.outcome.startswith("sent")


async def test_clear_hold_then_cleared(gateway, db):
    await all_normal()
    await send("telemetry", {"seq": nxt(), "controller": "uno-test", "readings": [reading("water-1", {"raw_adc": 640}, state="warning", fw_threshold={"wet": 300})]})
    [inc] = await active(db, "water")
    inc_id = inc.id
    await send("telemetry", {"seq": nxt(), "controller": "uno-test", "readings": NORMAL})
    assert len(await active(db, "water")) == 1, "must not clear before the clear-hold"
    await asyncio.sleep(1.1)
    await send("telemetry", {"seq": nxt(), "controller": "uno-test", "readings": NORMAL})
    assert await active(db, "water") == []
    assert await fresh(Incident, inc_id, lambda o: o.cleared_at) is not None


async def test_acknowledge_does_not_clear(gateway, client, auth, db):
    await all_normal()
    await send("telemetry", {"seq": nxt(), "controller": "uno-test", "readings": [reading("flame-1", {"detected": True, "digital_value": 0}, state="critical")]})
    [inc] = await active(db, "flame")
    assert (await client.post(f"/api/v1/incidents/{inc.id}/ack", headers=auth["viewer"])).status_code == 403
    r = await client.post(f"/api/v1/incidents/{inc.id}/ack", headers=auth["member"])
    assert r.status_code == 200
    assert (await client.post(f"/api/v1/incidents/{inc.id}/ack", headers=auth["member"])).status_code == 409
    assert len(await active(db, "flame")) == 1


async def test_stale_hazard_is_held_open(gateway, db):
    await all_normal()
    await send("telemetry", {"seq": nxt(), "controller": "uno-test", "readings": [reading("mq2-1", {"raw_adc": 420}, state="warning")]})
    s = await db.get(Sensor, "mq2-1")
    s.received_at = s.received_at - timedelta(minutes=5)
    await db.commit()
    await tick()
    await asyncio.sleep(1.1)
    await tick()
    [inc] = await active(db, "smoke")
    assert inc.held_stale is True
    assert {i.type for i in await active(db)} >= {"smoke", "sensor_stale"}


async def test_gateway_lwt_gives_one_root_cause_incident(gateway, db):
    await all_normal()
    await send("status", {"online": False})
    types = sorted(i.type for i in await active(db))
    assert types == ["controller"], types
    [inc] = await active(db)
    assert inc.source_id == "esp32-test"


async def test_controller_link_loss_reported_once(gateway, db):
    await all_normal()
    await send("heartbeat", {"seq": nxt(), "controllers": [{"id": "uno-test", "link_ok": False}]})
    c = await db.get(Device, "uno-test")
    c.last_seen_at = c.last_seen_at - timedelta(minutes=2)
    for sid in ("mq2-1", "flame-1", "water-1", "dht-1"):
        s = await db.get(Sensor, sid)
        s.received_at = s.received_at - timedelta(minutes=2)
    await db.commit()
    await tick()
    incs = await active(db)
    assert [(i.type, i.source_id) for i in incs] == [("controller", "uno-test")]


async def test_gsm_not_registered_is_degraded(gateway, db):
    await all_normal()
    await send("gsm", {"seq": nxt(), "module": {"id": "gsm-test", "registered": False, "csq": 99}})
    assert [i.type for i in await active(db)] == ["gsm"]


async def test_temperature_advisory_from_config(gateway, client, auth, db):
    await all_normal()
    cfg = {"mq2_warning": 350, "mq2_critical": 500, "water_wet": 300, "temp_advisory_c": 29.0, "humidity_advisory": None}
    assert (await client.put("/api/v1/config/thresholds", json=cfg, headers=auth["member"])).status_code == 403
    assert (await client.put("/api/v1/config/thresholds", json={**cfg, "mq2_critical": 100}, headers=auth["admin"])).status_code == 422
    assert (await client.put("/api/v1/config/thresholds", json=cfg, headers=auth["admin"])).status_code == 200
    await tick()
    [inc] = await active(db, "temperature")
    assert inc.severity == "warning"


async def test_history_and_downsampling(gateway, client, auth):
    for i in range(30):
        await send("telemetry", {"seq": nxt(), "controller": "uno-test", "readings": [reading("mq2-1", {"raw_adc": 100 + i}, age_ms=(30 - i) * 2000)]})
    import time

    now = int(time.time() * 1000)
    r = await client.get("/api/v1/telemetry", params={"series": "mq2-1:mq2", "from": now - 3600e3, "to": now + 1000}, headers=auth["viewer"])
    assert r.status_code == 200
    pts = r.json()["points"]
    assert len(pts) == 30 and pts[0]["v"] == 100 and r.json()["simulated"] is True
    r = await client.get("/api/v1/telemetry", params={"series": "mq2-1:mq2", "from": now - 3600e3, "to": now + 1000, "max_points": 10}, headers=auth["viewer"])
    assert len(r.json()["points"]) <= 11
    assert (await client.get("/api/v1/telemetry", params={"series": "mq2-1:temp", "from": 0, "to": 1}, headers=auth["viewer"])).status_code == 404


async def test_sequence_gaps_counted(gateway, client, auth):
    await send("heartbeat", {"seq": 10})
    await send("heartbeat", {"seq": 14})
    o = await client.get("/api/v1/overview", headers=auth["viewer"])
    assert o.json()["pipeline"]["seqGaps"] == 3


async def test_contacts_are_masked_for_non_admins(client, auth):
    r = await client.post("/api/v1/contacts", json={"name": "Mum", "phone": "+919812345678"}, headers=auth["admin"])
    assert r.status_code == 201
    assert (await client.post("/api/v1/contacts", json={"name": "X", "phone": "98123"}, headers=auth["admin"])).status_code == 422
    v = (await client.get("/api/v1/contacts", headers=auth["viewer"])).json()
    assert "812345" not in v[0]["phone"]
    a = (await client.get("/api/v1/contacts", headers=auth["owner"])).json()
    assert a[0]["phone"] == "+919812345678"


async def test_lwt_keeps_true_last_seen_and_reconnect_recovers(gateway, db, client, auth):
    await all_normal()
    before = (await client.get("/api/v1/overview", headers=auth["viewer"])).json()["controllers"]["esp32-test"]["last_seen_at"]
    await send("status", {"online": False})
    o = (await client.get("/api/v1/overview", headers=auth["viewer"])).json()["controllers"]["esp32-test"]
    assert o["connected"] is False and o["last_seen_at"] == before, "LWT must not fake the last-seen time"
    await all_normal()
    o = (await client.get("/api/v1/overview", headers=auth["viewer"])).json()["controllers"]["esp32-test"]
    assert o["connected"] is True


async def test_retained_online_status_does_not_mark_gateway_seen(gateway, db):
    from app.db import sessionmaker
    from app.services import ingest as ing

    async with sessionmaker()() as s:
        await ing.handle(s, "orion/home-1/esp32-test/status", '{"online": true, "fw": "1.0"}', retained=True)
        await s.commit()
    assert await fresh(Device, "esp32-test", lambda d: d.last_seen_at) is None


async def test_unknown_reading_fields_are_dropped(gateway, db):
    await all_normal()
    await send("telemetry", {"seq": nxt(), "controller": "uno-test", "readings": [reading("mq2-1", {"raw_adc": 200, "junk": "x" * 5000, "nested": {"a": 1}})]})
    f = await fresh(Sensor, "mq2-1", lambda s: s.fields)
    assert f == {"raw_adc": 200}
