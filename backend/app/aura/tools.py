"""Aura's tools. Every tool reads ORION data the user is allowed to see; none can change configuration, thresholds,
safety policies or device state. `propose_device_command` only records a proposal the user must confirm in the app.

Each tool declares the minimum role needed. Every call is validated (Pydantic) and written to the audit log.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from datetime import timedelta
from typing import Any, Awaitable, Callable, Literal

from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models import ROLE_RANK, AuraProposal, Incident, Role, User
from ..services import commands as cmds
from ..services import snapshot
from ..services.settings_store import get_config
from ..timeutil import ms
from ..timeutil import now as utcnow

SENSOR_METRIC = {"smoke": ("mq2", "mq2"), "flame": ("flame", "flame"), "water": ("water", "water"), "temperature": ("dht22", "temp"), "humidity": ("dht22", "hum")}


class _In(BaseModel):
    model_config = ConfigDict(extra="forbid")


class NoInput(_In):
    pass


class SensorIn(_In):
    sensor: Literal["smoke", "flame", "water", "temperature", "humidity", "all"] = "all"


class HistoryIn(_In):
    sensor: Literal["smoke", "flame", "water", "temperature", "humidity"]
    hours: int = Field(default=24, ge=1, le=168)


class AlertsIn(_In):
    filter: Literal["active", "recent"] = "active"
    limit: int = Field(default=6, ge=1, le=20)


class IncidentHistoryIn(_In):
    days: int = Field(default=7, ge=1, le=90)
    type: Literal["smoke", "flame", "water", "temperature", "sensor_stale", "sensor_fault", "controller", "gsm", "any"] = "any"


class PageIn(_In):
    page: Literal["home", "history", "alerts", "devices", "settings"]
    sensor: Literal["smoke", "flame", "water", "temperature", "humidity"] | None = None
    range: Literal["1h", "6h", "24h", "7d"] | None = None


class ProposeIn(_In):
    actuator: str = Field(max_length=32)
    action: str = Field(max_length=32)
    reason: str = Field(default="", max_length=300)


@dataclass
class Ctx:
    db: AsyncSession
    user: User
    snap: dict
    freshness: dict
    actions: list  # UI actions to send to the client (open page, proposal)


@dataclass
class Tool:
    name: str
    description: str
    model: type[BaseModel]
    min_role: Role
    run: Callable[[Ctx, Any], Awaitable[Any]]
    step: str

    def spec(self) -> dict:
        schema = self.model.model_json_schema()
        schema.pop("title", None)
        schema.setdefault("properties", {})
        schema["additionalProperties"] = False
        # Inputs stream as they're generated; service.py validates them with Pydantic before running anything.
        return {"name": self.name, "description": self.description, "input_schema": schema, "eager_input_streaming": True}


# ---------------- helpers ----------------
def _age(now_ms: int, t: int | None) -> str:
    if t is None:
        return "never"
    s = max(0, (now_ms - t) // 1000)
    return f"{s} s ago" if s < 120 else f"{s // 60} min ago" if s < 7200 else f"{s // 3600} h ago"


def _fresh(snap: dict, fr: dict, s: dict) -> str:
    now = snap["at"]
    if s.get("received_at") is None:
        return "NO READING RECEIVED"
    if now - s["received_at"] > fr["sensor_s"] * 1000:
        return f"STALE — last reading {_age(now, s['received_at'])} (last-known value, not current)"
    if s.get("quality") != "valid":
        return s.get("quality", "unknown").upper()
    return "fresh"


def _ctrl_online(snap: dict, fr: dict, c: dict) -> bool:
    if c.get("connected") is False or c.get("last_seen_at") is None:
        return False
    return snap["at"] - c["last_seen_at"] <= fr["heartbeat_s"] * 1000


def incident_brief(i: dict) -> dict:
    return {
        "id": i["id"], "type": i["type"], "what": f"{i['type'].replace('_', ' ')} — {i['source_label']}", "severity": i["severity"],
        "state": i["state"], "simulated": i["simulated"], "opened": i["opened_at"], "cleared": i["cleared_at"],
        "acknowledged_by": i["acknowledged_by"], "reading_at_open": i["snapshot"].get("value"), "peak": i["snapshot"].get("peak"),
        "threshold": i["snapshot"].get("threshold"), "device_reported_actions": [f"{a['action']} → {a['outcome']}" for a in i["actions"]][:8],
    }


def sensors_view(snap: dict, fr: dict, which: str = "all") -> list[dict]:
    out = []
    for s in snap.get("sensors", {}).values():
        if which != "all" and SENSOR_METRIC[which][0] != s["type"]:
            continue
        out.append({
            "id": s["id"], "type": s["type"], "room": s["room"], "freshness": _fresh(snap, fr, s), "device_state": s["state"],
            "fields": s["fields"], "fault": s["fault"], "recorded_at": s["recorded_at"], "simulated": s["simulated"],
            "note": {"mq2": "raw ADC count, NOT ppm; uncalibrated", "water": "cannot estimate leak volume", "flame": "digital trip; polarity to be verified"}.get(s["type"]),
        })
    return out


def controllers_view(snap: dict, fr: dict) -> list[dict]:
    return [{"id": c["id"], "name": c["name"], "role": c["role"], "gateway": c["is_gateway"], "online": _ctrl_online(snap, fr, c),
             "last_seen": _age(snap["at"], c["last_seen_at"]), "firmware": c["firmware_version"], "simulated": c["simulated"],
             "wifi_rssi_dbm": c.get("wifi_rssi_dbm")} for c in snap.get("controllers", {}).values()]


def gsm_view(snap: dict, fr: dict) -> dict:
    g = snap.get("gsm")
    if not g:
        return {"status": "no GSM module registered"}
    reported = g["last_report_at"] is not None and snap["at"] - g["last_report_at"] <= fr["heartbeat_s"] * 1000
    return {"reported_recently": reported, "network_registered": reported and g["network_registered"], "signal_csq": g["csq"], "operator": g["operator"],
            "simulated": g["simulated"], "recent_attempts": [f"{a['type']} {a['status']} ({a['note']})" for a in snap.get("gsmAttempts", [])[:5]],
            "note": "'sent' means the modem accepted the message; delivery is not confirmed"}


# ---------------- tools ----------------
async def t_status(c: Ctx, _: NoInput) -> dict:
    s = c.snap
    if s.get("status") != "ok":
        return {"data_status": s.get("status"), "note": s.get("message", "no data")}
    active = [incident_brief(i) for i in s["incidents"] if i["state"] == "active"]
    return {"data_source": "SIMULATED devices" if s.get("simulated") else ("live (some devices simulated)" if s.get("contains_simulated") else "live hardware"),
            "active_incidents": active, "sensors": sensors_view(s, c.freshness), "controllers": controllers_view(s, c.freshness), "gsm": gsm_view(s, c.freshness)}


async def t_sensors(c: Ctx, i: SensorIn) -> Any:
    return sensors_view(c.snap, c.freshness, i.sensor) if c.snap.get("status") == "ok" else {"data_status": c.snap.get("status")}


async def t_history(c: Ctx, i: HistoryIn) -> dict:
    stype, metric = SENSOR_METRIC[i.sensor]
    sensor = next((s for s in c.snap.get("sensors", {}).values() if s["type"] == stype), None)
    if not sensor:
        return {"note": f"no {i.sensor} sensor is registered"}
    now = int(time.time() * 1000)
    pts = [p for p in await snapshot.history(c.db, sensor["id"], metric, now - i.hours * 3600_000, now, 48) if p["v"] is not None]
    if not pts:
        return {"sensor": i.sensor, "hours": i.hours, "note": "no valid readings stored in this window"}
    vals = [p["v"] for p in pts]
    hi, lo = max(pts, key=lambda p: p["v"]), min(pts, key=lambda p: p["v"])
    return {"sensor": i.sensor, "hours": i.hours, "simulated": sensor["simulated"], "max": {"value": hi["v"], "at": hi["t"]}, "min": {"value": lo["v"], "at": lo["t"]},
            "average": round(sum(vals) / len(vals), 2), "points": [[p["t"], p["v"]] for p in pts][-48:], "times": "epoch milliseconds"}


async def t_alerts(c: Ctx, i: AlertsIn) -> list[dict]:
    incs = c.snap.get("incidents", [])
    if i.filter == "active":
        incs = [x for x in incs if x["state"] == "active"]
    return [incident_brief(x) for x in incs[: i.limit]]


async def t_incident_history(c: Ctx, i: IncidentHistoryIn) -> list[dict]:
    q = select(Incident).where(Incident.opened_at >= utcnow() - timedelta(days=i.days)).order_by(Incident.opened_at.desc()).limit(30)
    if i.type != "any":
        q = q.where(Incident.type == i.type)
    return [incident_brief(snapshot.incident_dict(x)) for x in (await c.db.execute(q)).scalars()]


async def t_devices(c: Ctx, _: NoInput) -> dict:
    s = c.snap
    return {"outputs_as_commanded_no_feedback": s.get("actuators") or "no outputs reported", "recent_commands": [f"{x['actuator']} {x['action']}: {x['status']}" for x in s.get("commands", [])[:5]],
            "allowed_remote_commands": [f"{a} {b}" for (a, b) in cmds.ALLOWED], "note": "No output has a feedback sensor; ORION knows only what was commanded."}


async def t_gsm(c: Ctx, _: NoInput) -> dict:
    return gsm_view(c.snap, c.freshness)


async def t_controllers(c: Ctx, _: NoInput) -> Any:
    return controllers_view(c.snap, c.freshness) + [{"pipeline_sequence_gaps": c.snap.get("pipeline", {}).get("seqGaps")}]


async def t_open_page(c: Ctx, i: PageIn) -> str:
    c.actions.append({"type": "open_page", "page": i.page, "sensor": i.sensor, "range": i.range})
    return "The page will be shown to the user."


async def t_propose(c: Ctx, i: ProposeIn) -> str:
    if (i.actuator, i.action) not in cmds.ALLOWED:
        return f"Not allowed: '{i.actuator} {i.action}' is not a remote command. Only: " + ", ".join(f"{a} {b}" for (a, b) in cmds.ALLOWED) + ". Door, SG90, mist maker and safety settings cannot be changed remotely."
    if ROLE_RANK[c.user.role] < ROLE_RANK[Role.member]:
        return "This user's role (viewer) cannot send device commands."
    p = AuraProposal(user_id=c.user.id, actuator=i.actuator, action=i.action, reason=i.reason, expires_at=utcnow() + timedelta(minutes=2))
    c.db.add(p)
    await c.db.flush()
    c.actions.append({"type": "proposal", "id": p.id, "actuator": i.actuator, "action": i.action, "description": cmds.ALLOWED[(i.actuator, i.action)], "reason": i.reason, "expires_at": ms(p.expires_at)})
    return "A confirmation has been shown to the user. Nothing has run; the user decides. The controller may still refuse it."


TOOLS: list[Tool] = [
    Tool("get_system_status", "Current overall picture: active incidents, every sensor with freshness, boards, GSM. Use for 'is everything OK?' questions.", NoInput, Role.viewer, t_status, "Checked the current status"),
    Tool("get_sensor_readings", "Latest readings with freshness and quality for one sensor type or all.", SensorIn, Role.viewer, t_sensors, "Checked sensor readings"),
    Tool("get_sensor_history", "Stored readings of one sensor over the last N hours (1–168): min, max, average and up to 48 points.", HistoryIn, Role.viewer, t_history, "Looked at sensor history"),
    Tool("get_alerts", "Active or recent incidents with readings, thresholds and what the devices reported doing.", AlertsIn, Role.viewer, t_alerts, "Checked alerts"),
    Tool("get_incident_history", "Incidents opened in the last N days (1–90), optionally of one type.", IncidentHistoryIn, Role.viewer, t_incident_history, "Looked through incident history"),
    Tool("get_device_status", "Outputs (fan, buzzer, servos, LEDs, relay) as commanded, recent commands and the allowed remote commands.", NoInput, Role.viewer, t_devices, "Checked devices"),
    Tool("get_gsm_status", "SIM800C network registration, signal and recent SMS/call attempts.", NoInput, Role.viewer, t_gsm, "Checked texts and calls"),
    Tool("get_controller_health", "ESP32 and UNO connectivity, last seen, firmware, Wi-Fi signal, message gaps.", NoInput, Role.viewer, t_controllers, "Checked the boards"),
    Tool("open_dashboard_page", "Show the user a page of the ORION app (home, history, alerts, devices, settings). For history you may pick sensor and range.", PageIn, Role.viewer, t_open_page, "Opened a page"),
    Tool("propose_device_command", "Ask the user to confirm an allowed device command (fan on, fan off, buzzer test). Shows a confirmation only — it never runs anything itself.", ProposeIn, Role.viewer, t_propose, "Asked you to confirm a command"),
]
BY_NAME = {t.name: t for t in TOOLS}


def tools_for(user: User, voice: bool) -> list[Tool]:
    return [t for t in TOOLS if ROLE_RANK[user.role] >= ROLE_RANK[t.min_role]]


async def freshness(db: AsyncSession) -> dict:
    return await get_config(db, "freshness")
