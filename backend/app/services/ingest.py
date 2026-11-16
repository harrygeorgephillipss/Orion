"""Device message ingest (MQTT → validated → database → real-time bus).

Topic layout:  {root}/{home_id}/{gateway_id}/{kind}
kind ∈ status | heartbeat | telemetry | actuators | event | gsm | cmd_ack
Full protocol: hardware/communication/PROTOCOL.md

Security model: the broker's ACL only lets a gateway publish under its own {gateway_id}; this module additionally
rejects unknown gateways, controllers that are not children of the publishing gateway, and unregistered sensors.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..bus import bus
from ..models import ActivityEvent, Command, CommandStep, Device, DeviceKind, GsmAttempt, GsmModule, Incident, IncidentAction, IncidentEvent, Sensor, Telemetry
from ..timeutil import now as utcnow
from . import engine

log = logging.getLogger("orion.ingest")

MAX_AGE_MS = 10 * 60 * 1000  # readings claiming to be older than this are clamped and flagged

# Plausible ranges for each stored metric; anything outside is stored as a fault, never as a value.
RANGES = {"raw_adc": (0, 4095), "temperature_c": (-40.0, 80.0), "humidity_percent": (0.0, 100.0)}
METRICS = {"mq2": [("mq2", "raw_adc")], "flame": [("flame", "detected")], "water": [("water", "raw_adc")], "dht22": [("temp", "temperature_c"), ("hum", "humidity_percent")]}
QUALITIES = Literal["valid", "warming_up", "fault", "disconnected"]
STATES = Literal["normal", "warning", "critical", "unknown"]


class _M(BaseModel):
    model_config = ConfigDict(extra="ignore")


class StatusMsg(_M):
    online: bool
    fw: str | None = Field(default=None, max_length=40)
    boot_reason: str | None = Field(default=None, max_length=40)


class CtrlHb(_M):
    id: str = Field(max_length=64)
    link_ok: bool
    last_rx_ms_ago: int | None = Field(default=None, ge=0)
    fw: str | None = Field(default=None, max_length=40)
    boot_reason: str | None = Field(default=None, max_length=40)


class HeartbeatMsg(_M):
    seq: int = Field(ge=0)
    uptime_s: int | None = Field(default=None, ge=0)
    rssi: int | None = Field(default=None, ge=-127, le=0)
    controllers: list[CtrlHb] = []


class Reading(_M):
    sensor: str = Field(max_length=64)
    fields: dict[str, Any]
    quality: QUALITIES
    state: STATES = "unknown"
    age_ms: int = Field(default=0, ge=0)
    fault: str | None = Field(default=None, max_length=120)
    fw_threshold: dict[str, float] | None = None
    warmup_remaining_s: int | None = Field(default=None, ge=0)


class TelemetryMsg(_M):
    seq: int = Field(ge=0)
    controller: str = Field(max_length=64)
    readings: list[Reading] = Field(max_length=32)


class ActuatorsMsg(_M):
    seq: int = Field(ge=0)
    controller: str = Field(max_length=64)
    actuators: dict[str, Any]


class EventMsg(_M):
    seq: int = Field(ge=0)
    controller: str = Field(max_length=64)
    kind: Literal["action", "fault", "info"] = "action"
    hazard: str | None = Field(default=None, max_length=32)  # smoke | flame | water …
    sensor: str | None = Field(default=None, max_length=64)
    text: str = Field(max_length=300)
    age_ms: int = Field(default=0, ge=0)


class GsmModuleMsg(_M):
    id: str = Field(max_length=64)
    registered: bool
    csq: int | None = Field(default=None, ge=0, le=99)
    operator: str | None = Field(default=None, max_length=60)
    sim: str | None = Field(default=None, max_length=32)


class GsmAttemptMsg(_M):
    id: str = Field(max_length=64)
    type: Literal["sms", "call"]
    destination: str = Field(max_length=60)
    status: Literal["queued", "sending", "sent", "delivered", "failed", "timeout", "answered"]
    note: str = Field(default="", max_length=200)
    error_code: str | None = Field(default=None, max_length=40)
    hazard: str | None = Field(default=None, max_length=32)
    sensor: str | None = Field(default=None, max_length=64)
    age_ms: int = Field(default=0, ge=0)


class GsmMsg(_M):
    seq: int = Field(ge=0)
    module: GsmModuleMsg
    attempts: list[GsmAttemptMsg] = Field(default=[], max_length=20)


class CmdAckMsg(_M):
    command_id: str = Field(max_length=40)
    status: Literal["accepted", "rejected", "executed_unverified", "verified", "failed"]
    note: str = Field(default="", max_length=200)


class IngestError(Exception):
    pass


def _parse(model: type[BaseModel], payload: bytes | str) -> Any:
    try:
        return model.model_validate(json.loads(payload))
    except (ValueError, ValidationError) as e:
        raise IngestError(f"invalid {model.__name__}: {str(e)[:300]}") from e


def _mask(dest: str) -> str:
    digits = [c for c in dest if c.isdigit()]
    if len(digits) < 4:
        return dest[:30]
    return "•••• " + "".join(digits[-2:])


async def _gateway(db: AsyncSession, home_id: str, gateway_id: str) -> Device:
    gw = await db.get(Device, gateway_id)
    if gw is None or gw.kind != DeviceKind.gateway or gw.home_id != home_id:
        raise IngestError(f"unknown gateway {gateway_id!r} for home {home_id!r}")
    return gw


async def _controller(db: AsyncSession, gw: Device, controller_id: str) -> Device:
    c = await db.get(Device, controller_id)
    if c is None or c.kind != DeviceKind.controller or c.parent_id != gw.id:
        raise IngestError(f"controller {controller_id!r} is not registered under gateway {gw.id!r}")
    return c


def _track_seq(gw: Device, seq: int) -> None:
    if gw.last_seq is not None:
        if seq > gw.last_seq + 1:
            gw.seq_gaps += seq - gw.last_seq - 1
        elif seq <= gw.last_seq and gw.last_seq - seq > 5:
            pass  # restart: counter reset
    gw.last_seq = seq


# A device silent for longer than this starts a new "online period" when it is heard again (start-up grace).
ONLINE_GAP = timedelta(seconds=60)


def _seen(d: Device, at: datetime) -> None:
    if d.last_seen_at is None or at - d.last_seen_at > ONLINE_GAP or d.online_since is None or (d.info or {}).get("connected") is False:
        d.online_since = at
    if (d.info or {}).get("connected") is False:
        d.info = {**d.info, "connected": True}
    d.last_seen_at = max(at, d.last_seen_at) if d.last_seen_at else at


def _recorded(received: datetime, age_ms: int) -> datetime:
    return received - timedelta(milliseconds=min(age_ms, MAX_AGE_MS))


# Fields each sensor type may report. Anything else in a reading is dropped (devices can't stuff the database).
ALLOWED_FIELDS = {"mq2": {"raw_adc"}, "flame": {"detected", "digital_value", "raw_adc"}, "water": {"raw_adc", "wet"}, "dht22": {"temperature_c", "humidity_percent"}}


async def handle(db: AsyncSession, topic: str, payload: bytes | str, root: str = "orion", retained: bool = False) -> str:
    """Process one message. Returns the message kind. Raises IngestError for rejected messages. Caller commits."""
    parts = topic.split("/")
    if len(parts) != 4 or parts[0] != root:
        raise IngestError(f"unexpected topic {topic!r}")
    _, home_id, gateway_id, kind = parts
    gw = await _gateway(db, home_id, gateway_id)
    now = utcnow()
    simulated = gw.simulated

    if kind == "status":
        m = _parse(StatusMsg, payload)
        if m.online and retained:
            # A retained "online" replayed by the broker (e.g. after a server restart) says nothing about now.
            gw.firmware_version = m.fw or gw.firmware_version
            return kind
        if m.online:
            _seen(gw, now)
            gw.firmware_version = m.fw or gw.firmware_version
            gw.boot_reason = m.boot_reason or gw.boot_reason
            db.add(ActivityEvent(at=now, severity="info", source=gw.name, text=f"Gateway connected (boot reason: {m.boot_reason or 'unknown'})"))
        else:
            # Last-will message from the broker: the gateway's connection dropped. Offline immediately;
            # last_seen_at keeps the true time it was last heard from.
            gw.info = {**(gw.info or {}), "connected": False, "disconnected_at": now.isoformat()}
            gw.online_since = None
            db.add(ActivityEvent(at=now, severity="degraded", source=gw.name, text="Gateway disconnected (broker last-will)"))
        bus.publish("device_status", device_id=gw.id, online=m.online)

    elif kind == "heartbeat":
        m = _parse(HeartbeatMsg, payload)
        _track_seq(gw, m.seq)
        _seen(gw, now)
        gw.info = {**(gw.info or {}), "uptime_s": m.uptime_s, "wifi_rssi_dbm": m.rssi}
        for ch in m.controllers:
            c = await _controller(db, gw, ch.id)
            was_online = c.last_seen_at is not None
            c.info = {**(c.info or {}), "link_ok": ch.link_ok}
            if ch.link_ok and ch.last_rx_ms_ago is not None:
                _seen(c, _recorded(now, ch.last_rx_ms_ago))
            if ch.fw:
                c.firmware_version = ch.fw
            if ch.boot_reason:
                c.boot_reason = ch.boot_reason
            if not ch.link_ok and was_online:
                bus.publish("device_status", device_id=c.id, online=False)

    elif kind == "telemetry":
        m = _parse(TelemetryMsg, payload)
        _track_seq(gw, m.seq)
        _seen(gw, now)
        ctrl = await _controller(db, gw, m.controller)
        _seen(ctrl, now)
        for r in m.readings:
            s = await db.get(Sensor, r.sensor)
            if s is None or s.device_id != ctrl.id:
                raise IngestError(f"sensor {r.sensor!r} is not registered on controller {ctrl.id!r}")
            rec = _recorded(now, r.age_ms)
            allowed = ALLOWED_FIELDS.get(s.type, set())
            fields = {k: v for k, v in r.fields.items() if k in allowed and (v is None or isinstance(v, (bool, int, float)))}
            quality, fault = r.quality, r.fault
            for _, fld in METRICS.get(s.type, []):
                v = fields.get(fld)
                if fld in RANGES and v is not None:
                    lo, hi = RANGES[fld]
                    if not isinstance(v, (int, float)) or isinstance(v, bool) or not (lo <= v <= hi):
                        fields[fld] = None
                        quality, fault = "fault", f"{fld} out of range ({v!r})"
            if s.type == "water" and "wet" not in fields and fields.get("raw_adc") is not None and r.fw_threshold and "wet" in r.fw_threshold:
                fields["wet"] = fields["raw_adc"] >= r.fw_threshold["wet"]
            s.fields, s.quality, s.fault = fields, quality, fault
            s.state = r.state if quality == "valid" else "unknown"
            s.fw_threshold = r.fw_threshold
            s.warmup_remaining_s = r.warmup_remaining_s
            s.recorded_at, s.received_at, s.sequence = rec, now, m.seq
            for metric, fld in METRICS.get(s.type, []):
                v = fields.get(fld)
                val = None if (quality != "valid" or v is None) else float(v)
                db.add(Telemetry(sensor_id=s.id, metric=metric, value=val, quality=quality, recorded_at=rec, received_at=now, simulated=simulated))
        bus.publish("telemetry", controller=ctrl.id, sensors=[r.sensor for r in m.readings])

    elif kind == "actuators":
        m = _parse(ActuatorsMsg, payload)
        _seen(gw, now)
        ctrl = await _controller(db, gw, m.controller)
        prev = ctrl.actuators or {}
        ctrl.actuators = {**prev, **m.actuators, "_reported_at": now.isoformat()}
        changes = [k for k, v in m.actuators.items() if prev.get(k) != v]
        if changes:
            bus.publish("actuators", controller=ctrl.id, changed=changes)

    elif kind == "event":
        m = _parse(EventMsg, payload)
        _seen(gw, now)
        ctrl = await _controller(db, gw, m.controller)
        at = _recorded(now, m.age_ms)
        await engine.evaluate(db)  # make sure a hazard reported in the same burst already has its incident
        inc = await _hazard_incident(db, m.hazard, m.sensor)
        if inc is not None:
            inc.actions.append(IncidentAction(at=at, actor="firmware", action=m.text, outcome="reported by controller"))
            inc.events.append(IncidentEvent(at=at, text="Firmware reported: " + m.text))
        src = {"smoke": "Smoke response", "flame": "Flame response", "water": "Water response"}.get(m.hazard or "", ctrl.name)
        db.add(ActivityEvent(at=at, severity="info" if m.kind != "fault" else "degraded", source=src, text="Firmware reported: " + m.text, incident_id=inc.id if inc else None))

    elif kind == "gsm":
        m = _parse(GsmMsg, payload)
        _seen(gw, now)
        mod = await db.get(GsmModule, m.module.id)
        if mod is None or mod.gateway_id != gw.id:
            raise IngestError(f"GSM module {m.module.id!r} is not registered on gateway {gw.id!r}")
        was = mod.network_registered
        mod.network_registered, mod.csq, mod.operator, mod.sim_status, mod.last_report_at = m.module.registered, m.module.csq, m.module.operator, m.module.sim, now
        if was != mod.network_registered:
            bus.publish("gsm_status", module=mod.id, registered=mod.network_registered)
        for a in m.attempts:
            row = await db.get(GsmAttempt, a.id)
            at = _recorded(now, a.age_ms)
            if row is None:
                row = GsmAttempt(id=a.id, module_id=mod.id, type=a.type, destination=_mask(a.destination), status=a.status, note=a.note, error_code=a.error_code, incident_type=a.hazard, simulated=simulated, created_at=at, updated_at=now)
                db.add(row)
                await engine.evaluate(db)
                inc = await _hazard_incident(db, a.hazard, a.sensor)
                row.incident_id = inc.id if inc else None
            elif row.status != a.status:
                row.status, row.note, row.error_code, row.updated_at = a.status, a.note, a.error_code, now
            else:
                continue
            bus.publish("gsm_attempt", attempt_id=row.id, kind=row.type, status=row.status, simulated=simulated)
            if row.incident_id:
                inc = await db.get(Incident, row.incident_id)
                if inc is not None:
                    label = ("SMS" if row.type == "sms" else "Voice call") + " to " + row.destination
                    act = next((x for x in inc.actions if x.gsm_attempt_id == row.id), None)
                    outcome = row.status + (f" — {row.note}" if row.note else "")
                    if act is None:
                        inc.actions.append(IncidentAction(at=row.created_at, actor="firmware", action=label, outcome=outcome, gsm_attempt_id=row.id))
                    else:
                        act.outcome = outcome

    elif kind == "cmd_ack":
        m = _parse(CmdAckMsg, payload)
        _seen(gw, now)
        cmd = await db.get(Command, m.command_id)
        if cmd is None:
            raise IngestError(f"unknown command {m.command_id!r}")
        ctrl = await db.get(Device, cmd.device_id)
        if ctrl is None or ctrl.parent_id != gw.id:
            raise IngestError("command acknowledged by a gateway that does not own it")
        if cmd.status in ("completed", "failed", "rejected", "expired", "unknown"):
            return kind  # late ack after a terminal state: ignore, but don't error
        note = m.note or {"accepted": "Controller accepted command", "rejected": "Controller rejected command", "executed_unverified": "Output driven by controller; physical result unverified (no feedback sensor)", "verified": "Output change confirmed by a feedback sensor", "failed": "Controller reported failure"}[m.status]
        mapping = {"accepted": "accepted", "rejected": "rejected", "executed_unverified": "unknown", "verified": "completed", "failed": "failed"}
        cmd.status = mapping[m.status]
        cmd.history.append(CommandStep(at=now, status=cmd.status, note=note))
        if cmd.status != "accepted":
            cmd.completed_at = now
            cmd.result = m.status
        bus.publish("command", command_id=cmd.id, status=cmd.status)

    else:
        raise IngestError(f"unknown message kind {kind!r}")

    changed = await engine.evaluate(db)
    bus.publish("update", reason=kind, incidents_changed=changed)
    return kind


async def _hazard_incident(db: AsyncSession, hazard: str | None, sensor_id: str | None) -> Incident | None:
    if not hazard:
        return None
    if sensor_id:
        inc = await engine.active_incident_by_key(db, f"haz:{sensor_id}")
        if inc:
            return inc
    type_ = {"smoke": "smoke", "flame": "flame", "water": "water"}.get(hazard)
    if not type_:
        return None
    return (await db.execute(select(Incident).where(Incident.type == type_, Incident.state == "active").order_by(Incident.opened_at.desc()))).scalars().first()
