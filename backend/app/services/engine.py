"""Incident engine and health monitor.

Rules (ported from the prototype's simulated backend, sources.js `_incidentEngine`):
- Device-reported hazard states are authoritative (the safety controller decides smoke/flame/water locally).
- A stale or missing reading is never treated as normal.
- When the gateway is silent, one root-cause incident is raised instead of one per downstream sensor;
  likewise a silent controller is reported once instead of once per sensor.
- Incidents clear only after the condition has been normal for the clear-hold period — never by a button.
- A hazard whose sensor has gone stale is held open: absence of data is not evidence the hazard ended.
"""
from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..bus import bus
from ..config import get_settings
from ..models import ActivityEvent, Device, DeviceKind, GsmModule, Incident, IncidentEvent, Sensor
from ..timeutil import now as utcnow
from .settings_store import get_config

log = logging.getLogger("orion.engine")
_lock = asyncio.Lock()

HAZARD_TYPES = ("smoke", "flame", "water", "temperature")
BASE_LABEL = {"mq2": "MQ-2", "flame": "Flame sensor", "water": "Water sensor", "dht22": "DHT22"}


@dataclass
class Cond:
    key: str
    type: str
    source_id: str
    severity: str
    value: object
    unit: str
    threshold: str
    label: str
    simulated: bool = False
    extra: dict = field(default_factory=dict)


def sensor_label(s: Sensor, rooms: dict) -> str:
    room = rooms.get(s.id) or s.room
    base = BASE_LABEL.get(s.type, s.label or s.id)
    return f"{base} · {room}" if room else base


async def evaluate(db: AsyncSession) -> bool:
    """Run one evaluation pass. Returns True if anything changed. Caller commits."""
    async with _lock:
        return await _evaluate(db)


async def _evaluate(db: AsyncSession) -> bool:
    st = get_settings()
    now = utcnow()
    fresh_cfg = await get_config(db, "freshness")
    thresholds = await get_config(db, "thresholds")
    rooms = await get_config(db, "rooms")
    fresh = timedelta(seconds=fresh_cfg["sensor_s"])
    hb = timedelta(seconds=fresh_cfg["heartbeat_s"])
    clear_hold = timedelta(seconds=st.clear_hold_s)

    devices = {d.id: d for d in (await db.execute(select(Device))).scalars()}
    sensors = list((await db.execute(select(Sensor))).scalars())
    gsms = list((await db.execute(select(GsmModule))).scalars())

    def offline(d: Device | None) -> bool:
        if d is None or d.last_seen_at is None or (d.info or {}).get("connected") is False:
            return True
        return now - d.last_seen_at > hb

    def stale(s: Sensor) -> bool:
        return s.received_at is None or now - s.received_at > fresh

    def in_grace(d: Device | None, window: timedelta) -> bool:
        # Just after a board (re)connects, give never-reported sensors/modules one freshness window before alerting.
        return d is not None and d.online_since is not None and now - d.online_since <= window

    gateways = [d for d in devices.values() if d.kind == DeviceKind.gateway]
    conds: list[Cond] = []

    # --- hazards (only from fresh readings; device state is authoritative) ---
    for s in sensors:
        if stale(s):
            continue
        lab = sensor_label(s, rooms)
        f = s.fields or {}
        thr = s.fw_threshold or {}
        if s.type == "mq2" and s.state in ("warning", "critical"):
            conds.append(Cond(f"haz:{s.id}", "smoke", s.id, s.state, f.get("raw_adc"), "adc_raw", f"warning {thr.get('warning', '?')} / critical {thr.get('critical', '?')} (firmware; uncalibrated)", lab, s.simulated))
        elif s.type == "flame" and s.state == "critical":
            conds.append(Cond(f"haz:{s.id}", "flame", s.id, "critical", "detected", "digital", "digital trip (firmware debounced)", lab, s.simulated))
        elif s.type == "water" and s.state in ("warning", "critical"):
            conds.append(Cond(f"haz:{s.id}", "water", s.id, s.state, f.get("raw_adc"), "adc_raw", f"wet ≥ {thr.get('wet', '?')} (firmware)", lab, s.simulated))
        elif s.type == "dht22" and s.quality == "valid":
            t, lim = f.get("temperature_c"), thresholds.get("temp_advisory_c")
            if t is not None and lim is not None and t >= lim:
                conds.append(Cond(f"temp:{s.id}", "temperature", s.id, "warning", t, "°C", f"advisory ≥ {lim} °C (app setting)", lab, s.simulated))

    # --- degraded conditions with root-cause grouping ---
    gw_down = {g.id for g in gateways if offline(g)}
    for g in gateways:
        if g.id in gw_down:
            why = "gateway disconnected (broker reported connection loss)" if (g.info or {}).get("connected") is False else "gateway heartbeat missing"
            conds.append(Cond(f"hb:{g.id}", "controller", g.id, "degraded", why + " — all telemetry stale", "", f"heartbeat {fresh_cfg['heartbeat_s']} s", g.name, g.simulated))
    for d in devices.values():
        if d.kind != DeviceKind.controller:
            continue
        if d.parent_id in gw_down:
            continue  # its gateway is the root cause
        if offline(d):
            conds.append(Cond(f"hb:{d.id}", "controller", d.id, "degraded", "heartbeat missing — its sensors are stale", "", f"heartbeat {fresh_cfg['heartbeat_s']} s", d.name, d.simulated))
    for s in sensors:
        ctrl = devices.get(s.device_id)
        if ctrl is None or offline(ctrl) or ctrl.parent_id in gw_down:
            continue
        lab = sensor_label(s, rooms)
        if stale(s):
            if s.received_at is None and in_grace(ctrl, fresh):
                continue
            conds.append(Cond(f"stale:{s.id}", "sensor_stale", s.id, "degraded", "no readings", "", f"freshness {fresh_cfg['sensor_s']} s", lab, s.simulated))
        elif s.quality in ("fault", "disconnected"):
            conds.append(Cond(f"fault:{s.id}", "sensor_fault", s.id, "degraded", s.fault or s.quality, "", "quality = valid", lab, s.simulated))
    for m in gsms:
        if m.gateway_id in gw_down:
            continue
        reported = m.last_report_at is not None and now - m.last_report_at <= hb
        if m.last_report_at is None and in_grace(devices.get(m.gateway_id), hb):
            continue
        if not reported:
            conds.append(Cond(f"gsm:{m.id}", "gsm", m.id, "degraded", "no status report", "", "GSM status heartbeat", f"{m.module} GSM", m.simulated))
        elif not m.network_registered:
            conds.append(Cond(f"gsm:{m.id}", "gsm", m.id, "degraded", "not registered on network", "", "network registered", f"{m.module} GSM", m.simulated))

    # --- open / update ---
    changed = False
    active_rows = {i.key: i for i in (await db.execute(select(Incident).where(Incident.state == "active"))).scalars()}
    seen: set[str] = set()
    for c in conds:
        seen.add(c.key)
        inc = active_rows.get(c.key)
        if inc is None:
            inc = Incident(
                key=c.key, type=c.type, source_id=c.source_id, source_label=c.label, severity=c.severity, state="active",
                simulated=c.simulated, opened_at=now, last_seen_at=now,
                snapshot={"value": c.value, "unit": c.unit, "threshold": c.threshold, "config_version": None},
            )
            inc.events = [IncidentEvent(at=now, text=f"Opened: {c.type.replace('_', ' ')} ({c.severity})")]
            inc.actions = []
            db.add(inc)
            await db.flush()
            active_rows[c.key] = inc
            db.add(ActivityEvent(at=now, severity=c.severity, source=c.label, text=f"Incident opened — {c.type.replace('_', ' ')} ({c.severity.upper()})", incident_id=inc.id))
            bus.publish("incident_opened", incident_id=inc.id, incident_type=c.type, severity=c.severity, source=c.label, simulated=c.simulated)
            log.warning("incident opened %s %s %s", inc.id, c.key, c.severity)
            changed = True
        else:
            inc.last_seen_at = now
            if inc.normal_since is not None:
                inc.normal_since = None
                inc.events.append(IncidentEvent(at=now, text="Condition reported again; clear-hold cancelled"))
            if inc.held_stale:
                inc.held_stale = False
            if c.severity == "critical" and inc.severity == "warning":
                inc.severity = "critical"
                inc.events.append(IncidentEvent(at=now, text="Escalated to CRITICAL"))
                db.add(ActivityEvent(at=now, severity="critical", source=c.label, text="Incident escalated to CRITICAL", incident_id=inc.id))
                bus.publish("incident_escalated", incident_id=inc.id, incident_type=c.type, severity="critical", source=c.label, simulated=c.simulated)
                changed = True
            if isinstance(c.value, (int, float)) and not isinstance(c.value, bool):
                peak = inc.snapshot.get("peak")
                if not isinstance(peak, (int, float)) or c.value > peak:
                    inc.snapshot = {**inc.snapshot, "peak": c.value}

    # --- clearing (sensor/state logic only) ---
    by_id = {s.id: s for s in sensors}
    for key, inc in active_rows.items():
        if key in seen:
            continue
        src = by_id.get(inc.source_id)
        if inc.type in HAZARD_TYPES and src is not None and stale(src):
            if not inc.held_stale:
                inc.held_stale = True
                inc.normal_since = None
                inc.events.append(IncidentEvent(at=now, text="Source sensor stale — incident held open (cannot confirm the hazard has cleared)"))
                changed = True
            continue
        inc.held_stale = False
        if inc.normal_since is None:
            inc.normal_since = now
            inc.events.append(IncidentEvent(at=now, text=f"Condition no longer reported; clear-hold started ({int(clear_hold.total_seconds())} s)"))
            changed = True
        elif now - inc.normal_since >= clear_hold:
            inc.state = "cleared"
            inc.cleared_at = now
            inc.events.append(IncidentEvent(at=now, text="Cleared: condition normal for the clear-hold period"))
            db.add(ActivityEvent(at=now, severity="info", source=inc.source_label, text="Incident cleared by sensor/state logic", incident_id=inc.id))
            bus.publish("incident_cleared", incident_id=inc.id, incident_type=inc.type, source=inc.source_label, simulated=inc.simulated)
            changed = True
    return changed


async def active_incident_by_key(db: AsyncSession, key: str) -> Incident | None:
    return (await db.execute(select(Incident).where(Incident.key == key, Incident.state == "active"))).scalars().first()
