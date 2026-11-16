"""Builds the overview snapshot in the same shape the web app's data adapter expects (see frontend/src/sources.js)."""
from __future__ import annotations

from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import ActivityEvent, AuditLog, Command, Device, DeviceKind, GsmAttempt, GsmModule, Incident, Sensor, Telemetry
from ..timeutil import from_ms, ms
from ..timeutil import now as utcnow
from .settings_store import get_config


def incident_dict(i: Incident) -> dict:
    return {
        "id": i.id, "key": i.key, "type": i.type, "source_id": i.source_id, "source_label": i.source_label, "severity": i.severity,
        "state": i.state, "simulated": i.simulated, "opened_at": ms(i.opened_at), "last_seen_at": ms(i.last_seen_at), "cleared_at": ms(i.cleared_at),
        "acknowledged_by": i.acknowledged_by, "acknowledged_at": ms(i.acknowledged_at), "snapshot": i.snapshot or {},
        "events": [{"at": ms(e.at), "text": e.text} for e in i.events],
        "actions": [{"at": ms(a.at), "actor": a.actor, "action": a.action, "outcome": a.outcome, "gsm": a.gsm_attempt_id} for a in i.actions],
    }


def command_dict(c: Command) -> dict:
    return {
        "id": c.id, "device_id": c.device_id, "actuator": c.actuator, "action": c.action, "requested_by": c.requested_by, "origin": c.origin,
        "simulated": c.simulated, "created_at": ms(c.created_at), "expires_at": ms(c.expires_at), "status": c.status,
        "completed_at": ms(c.completed_at), "result": c.result, "history": [{"at": ms(h.at), "status": h.status, "note": h.note} for h in c.history],
    }


def sensor_dict(s: Sensor) -> dict:
    return {
        "id": s.id, "type": s.type, "label": s.label, "room": s.room, "controller": s.device_id, "simulated": s.simulated,
        "fields": s.fields or {}, "state": s.state, "quality": s.quality, "fault": s.fault, "fw_threshold": s.fw_threshold,
        "warmup_remaining_s": s.warmup_remaining_s, "recorded_at": ms(s.recorded_at), "received_at": ms(s.received_at), "sequence": s.sequence,
        "unit": {"mq2": "adc_raw", "water": "adc_raw", "flame": "digital", "dht22": "c_rh"}.get(s.type, ""),
    }


def device_dict(d: Device) -> dict:
    info = d.info or {}
    return {
        "id": d.id, "name": d.name, "kind": d.kind.value, "role": d.role, "is_gateway": d.kind == DeviceKind.gateway, "parent_id": d.parent_id,
        "simulated": d.simulated, "last_seen_at": ms(d.last_seen_at), "firmware_version": d.firmware_version, "boot_reason": d.boot_reason,
        "wifi_rssi_dbm": info.get("wifi_rssi_dbm"), "uptime_s": info.get("uptime_s"), "link_ok": info.get("link_ok"),
        "connected": info.get("connected", d.last_seen_at is not None) if d.kind == DeviceKind.gateway else info.get("link_ok"),
        "logic": "3.3 V (not 5 V tolerant)" if d.kind == DeviceKind.gateway else "5 V",
    }


async def overview(db: AsyncSession) -> dict:
    now = utcnow()
    devices = list((await db.execute(select(Device).order_by(Device.id))).scalars())
    if not devices:
        return {"status": "empty", "at": ms(now), "message": "No devices are registered yet."}
    sensors = list((await db.execute(select(Sensor).order_by(Sensor.id))).scalars())
    gsm = (await db.execute(select(GsmModule).order_by(GsmModule.id))).scalars().first()
    attempts = list((await db.execute(select(GsmAttempt).order_by(GsmAttempt.created_at.desc()).limit(20))).scalars())
    active = list((await db.execute(select(Incident).where(Incident.state == "active").order_by(Incident.opened_at.desc()))).scalars())
    recent = list((await db.execute(select(Incident).where(Incident.state == "cleared").order_by(Incident.opened_at.desc()).limit(50))).scalars())
    events = list((await db.execute(select(ActivityEvent).order_by(ActivityEvent.at.desc()).limit(100))).scalars())
    commands = list((await db.execute(select(Command).order_by(Command.created_at.desc()).limit(10))).scalars())
    logs = list((await db.execute(select(AuditLog).order_by(AuditLog.at.desc()).limit(40))).scalars())

    # Merge actuator reports from every controller (single-controller homes: just the UNO's report).
    actuators: dict = {}
    for d in devices:
        if d.kind == DeviceKind.controller and d.actuators:
            actuators.update({k: v for k, v in d.actuators.items() if not k.startswith("_")})
    if actuators and "mist" not in actuators:
        actuators["mist"] = {"id": "mist", "name": "Mist maker", "installed": False, "commanded": "off", "remote": "disabled", "feedback": False}

    any_sim = any(d.simulated for d in devices)
    all_sim = all(d.simulated for d in devices)
    return {
        "status": "ok", "mode": "live", "at": ms(now),
        "simulated": all_sim, "contains_simulated": any_sim,
        "sensors": {s.id: sensor_dict(s) for s in sensors},
        "controllers": {d.id: device_dict(d) for d in devices},
        "gsm": None if gsm is None else {
            "id": gsm.id, "module": gsm.module, "simulated": gsm.simulated, "network_registered": gsm.network_registered,
            "operator": gsm.operator, "csq": gsm.csq, "sim": gsm.sim_status, "last_report_at": ms(gsm.last_report_at),
        },
        "gsmAttempts": [{
            "id": a.id, "type": a.type, "destination": a.destination, "status": a.status, "note": a.note, "error_code": a.error_code,
            "incident_id": a.incident_id, "simulated": a.simulated, "created_at": ms(a.created_at), "updated_at": ms(a.updated_at),
        } for a in attempts],
        "actuators": actuators or None,
        "incidents": [incident_dict(i) for i in active + recent],
        "events": [{"id": e.id, "at": ms(e.at), "severity": e.severity, "source": e.source, "text": e.text, "incident_id": e.incident_id} for e in events],
        "commands": [command_dict(c) for c in commands],
        "logs": [{"at": ms(l.at), "level": "info", "msg": f"audit: {l.action} {l.target} by {l.actor_type}:{l.actor_id}"} for l in logs],
        "pipeline": {"seqGaps": sum(d.seq_gaps for d in devices)},
    }


async def history(db: AsyncSession, sensor_id: str, metric: str, frm_ms: int, to_ms: int, max_points: int = 2000) -> list[dict]:
    """Readings in [from, to]. Long ranges are averaged into buckets so the response stays small."""
    frm, to = from_ms(frm_ms), from_ms(to_ms)
    base = select(Telemetry).where(Telemetry.sensor_id == sensor_id, Telemetry.metric == metric, Telemetry.recorded_at >= frm, Telemetry.recorded_at <= to)
    n = (await db.execute(select(func.count()).select_from(base.subquery()))).scalar_one()
    if n <= max_points:
        rows = (await db.execute(base.order_by(Telemetry.recorded_at))).scalars()
        out, prev = [], None
        for r in rows:
            out.append({"t": ms(r.recorded_at), "r": ms(r.received_at), "v": r.value, "q": r.quality, "i": (ms(r.recorded_at) - prev) if prev else 2000, "sim": r.simulated})
            prev = ms(r.recorded_at)
        return out
    bucket_s = max(1, int((to_ms - frm_ms) / 1000 / max_points))
    b = func.floor(func.extract("epoch", Telemetry.recorded_at) / bucket_s)
    q = (
        select(b.label("b"), func.avg(Telemetry.value), func.max(Telemetry.received_at), func.count(Telemetry.value), func.bool_or(Telemetry.simulated))
        .where(Telemetry.sensor_id == sensor_id, Telemetry.metric == metric, Telemetry.recorded_at >= frm, Telemetry.recorded_at <= to)
        .group_by("b").order_by("b")
    )
    out = []
    for bk, avg, recv, cnt, sim in (await db.execute(q)).all():
        t = int((float(bk) * bucket_s + bucket_s / 2) * 1000)
        out.append({"t": t, "r": ms(recv), "v": None if cnt == 0 else round(float(avg), 2), "q": "valid" if cnt else "no_data", "i": bucket_s * 1000, "sim": bool(sim)})
    return out


async def prune_telemetry(db: AsyncSession, keep_days: int = 90) -> int:
    from sqlalchemy import delete

    res = await db.execute(delete(Telemetry).where(Telemetry.recorded_at < utcnow() - timedelta(days=keep_days)))
    return res.rowcount or 0
