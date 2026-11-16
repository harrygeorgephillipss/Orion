"""Turns ORION events into push notifications for every user who wants them.

Sent for: incident opened or escalated (smoke, flame, water, temperature = hazard; sensor stale/fault, controller
offline, GSM failure = degraded). Simulated incidents are NOT pushed unless PUSH_SIMULATED is enabled, so a test
never alarms a phone as if it were real.
"""
from __future__ import annotations

import logging
import os

from sqlalchemy import delete, select

from ..bus import bus
from ..db import sessionmaker
from ..models import Incident, PushToken, User, UserPreference
from .fcm import FcmClient, load_client

log = logging.getLogger("orion.push")
TITLES = {"smoke": "Smoke or gas detected", "flame": "Flame detected", "water": "Water leak detected", "temperature": "High temperature",
          "sensor_stale": "Sensor stopped reporting", "sensor_fault": "Sensor fault", "controller": "Controller not responding", "gsm": "SMS/call alerts unavailable"}


def build(inc: Incident, escalated: bool, tz: str = "Asia/Kolkata") -> tuple[str, str, dict[str, str], bool]:
    from zoneinfo import ZoneInfo

    critical = inc.severity == "critical"
    title = ("ORION — " if not inc.simulated else "[SIMULATED] ORION — ") + TITLES.get(inc.type, inc.type) + (" (CRITICAL)" if escalated else "")
    at = inc.opened_at.astimezone(ZoneInfo(tz)).strftime("%d %b %H:%M:%S")
    body = f"{inc.source_label} · {inc.severity.upper()} · {at}"
    if critical:
        body += " · If there is real danger, get out and call 112 / 101."
    data = {"incident_id": inc.id, "type": inc.type, "severity": inc.severity, "source": inc.source_id, "label": inc.source_label,
            "opened_at": str(int(inc.opened_at.timestamp() * 1000)), "simulated": "true" if inc.simulated else "false"}
    return title, body, data, critical


async def deliver(client: FcmClient, incident_id: str, escalated: bool = False) -> int:
    push_sim = os.environ.get("PUSH_SIMULATED", "").lower() in ("1", "true", "yes")
    async with sessionmaker()() as db:
        inc = await db.get(Incident, incident_id)
        if not inc or (inc.simulated and not push_sim):
            return 0
        level = "critical" if inc.severity == "critical" else "warning" if inc.severity == "warning" else "degraded"
        rows = (await db.execute(select(PushToken, User).join(User, User.id == PushToken.user_id).where(User.is_active.is_(True)))).all()
        prefs = {p.user_id: p.value for p in (await db.execute(select(UserPreference))).scalars()}
        title, body, data, critical = build(inc, escalated)
        sent = 0
        for tok, user in rows:
            if not (prefs.get(user.id, {}).get("push") or {}).get(level, True):
                continue
            ok, err = await client.send(tok.token, title, body, data, critical)
            if ok:
                sent += 1
            elif err == "unregistered":
                await db.execute(delete(PushToken).where(PushToken.token == tok.token))
            else:
                tok.last_error = err
        await db.commit()
        return sent


async def run() -> None:
    client = load_client()
    if client is None:
        log.info("Push disabled (FCM_PROJECT_ID / FCM_SERVICE_ACCOUNT_FILE not set)")
        return
    q = bus.subscribe()
    try:
        while True:
            m = await q.get()
            if m.get("type") in ("incident_opened", "incident_escalated"):
                try:
                    await deliver(client, m["incident_id"], m["type"] == "incident_escalated")
                except Exception:
                    log.exception("push delivery failed")
    finally:
        bus.unsubscribe(q)


