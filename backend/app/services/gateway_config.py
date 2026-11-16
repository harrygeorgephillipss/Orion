"""Configuration sent to gateways over MQTT (retained on `{root}/{home}/{gateway}/config`).

Currently: the emergency contacts used for LOCAL SMS/call alerts. The ESP32 stores them in flash, so alerts keep
working without the server or internet. Only that gateway and the backend can read the topic (broker ACL).
"""
from __future__ import annotations

import json
import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import get_settings
from ..models import Device, DeviceKind, NotificationContact
from . import commands

log = logging.getLogger("orion.config")


async def payload(db: AsyncSession) -> dict:
    rows = (await db.execute(select(NotificationContact).where(NotificationContact.enabled.is_(True)).order_by(NotificationContact.created_at))).scalars()
    contacts = [{"name": c.name[:20], "phone": c.phone, "sms": c.sms, "call": c.call} for c in rows][:5]
    return {"version": 1, "contacts": contacts}


async def push_all(db: AsyncSession) -> int:
    """Publish the config to every gateway. Returns how many were sent (0 if the broker is not connected)."""
    pub = commands._publisher
    if pub is None:
        return 0
    st = get_settings()
    body = json.dumps(await payload(db)).encode()
    gws = (await db.execute(select(Device).where(Device.kind == DeviceKind.gateway))).scalars().all()
    n = 0
    for g in gws:
        try:
            await pub(f"{st.mqtt_topic_root}/{g.home_id}/{g.id}/config", body, retain=True)
            n += 1
        except Exception as e:  # broker down: the next (re)connect publishes again
            log.warning("config publish to %s failed: %s", g.id, e)
    return n
