"""Device command management.

Lifecycle: requested → queued (validated) → sent (published to the gateway) → accepted | rejected
           → unknown ("done · unconfirmed", no feedback sensor) | completed (feedback-verified) | failed | expired.
The safety controller (UNO) is the final authority: it can reject any command (e.g. fan OFF during smoke).
Nothing here can disable local protection; only allow-listed, time-limited actions exist.
"""
from __future__ import annotations

import json
import logging
from datetime import timedelta
from typing import Awaitable, Callable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..bus import bus
from ..config import get_settings
from ..models import Command, CommandStep, Device, DeviceKind
from ..timeutil import ms
from ..timeutil import now as utcnow

log = logging.getLogger("orion.commands")

# (actuator, action) pairs that may be requested remotely. Door/servo, mist maker and SG90 are deliberately absent.
ALLOWED: dict[tuple[str, str], str] = {
    ("fan", "on"): "Turn the exhaust fan on",
    ("fan", "off"): "Turn the exhaust fan off (refused by the controller during smoke/cooldown)",
    ("buzzer", "test"): "Sound the buzzer for 2 s",
}

Publisher = Callable[[str, bytes], Awaitable[None]]
_publisher: Publisher | None = None


def set_publisher(p: Publisher | None) -> None:
    global _publisher
    _publisher = p


class CommandError(Exception):
    def __init__(self, msg: str, code: int = 400) -> None:
        super().__init__(msg)
        self.code = code


async def create(db: AsyncSession, *, device_id: str | None, actuator: str, action: str, actor: str, origin: str = "user") -> Command:
    if (actuator, action) not in ALLOWED:
        raise CommandError(f"'{actuator} {action}' is not an allowed remote command", 422)
    st = get_settings()
    if device_id:
        ctrl = await db.get(Device, device_id)
    else:  # default: the only controller (single-home deployments)
        ctrls = list((await db.execute(select(Device).where(Device.kind == DeviceKind.controller))).scalars())
        ctrl = ctrls[0] if len(ctrls) == 1 else None
        if ctrl is None and len(ctrls) > 1:
            raise CommandError("Several controllers are registered — specify device_id", 422)
    if ctrl is None or ctrl.kind != DeviceKind.controller:
        raise CommandError("No such controller", 404)
    busy = (await db.execute(select(Command).where(Command.device_id == ctrl.id, Command.status.in_(["requested", "queued", "sent", "accepted"])))).scalars().first()
    if busy:
        raise CommandError("Another command for this controller is still in progress", 409)
    now = utcnow()
    cmd = Command(device_id=ctrl.id, actuator=actuator, action=action, requested_by=actor, origin=origin, simulated=ctrl.simulated, created_at=now, expires_at=now + timedelta(seconds=st.command_ttl_s), status="requested")
    cmd.history = [CommandStep(at=now, status="requested", note=f"{actor} requested {actuator} → {action}")]
    db.add(cmd)
    await db.flush()

    gw = await db.get(Device, ctrl.parent_id) if ctrl.parent_id else None
    cmd.status = "queued"
    cmd.history.append(CommandStep(at=now, status="queued", note="Validated: role, allow-list, expiry"))
    if gw is None:
        _finish(cmd, "failed", "Controller has no gateway — command not sent")
        return cmd
    if _publisher is None:
        _finish(cmd, "failed", "Server is not connected to the MQTT broker — command not sent")
        return cmd
    topic = f"{st.mqtt_topic_root}/{gw.home_id}/{gw.id}/cmd"
    body = {"command_id": cmd.id, "controller": ctrl.id, "actuator": actuator, "action": action, "expires_at": ms(cmd.expires_at), "ttl_ms": st.command_ttl_s * 1000}
    try:
        await _publisher(topic, json.dumps(body).encode())
    except Exception as e:  # broker down etc.
        log.warning("publish failed: %s", e)
        _finish(cmd, "failed", f"Could not publish to the broker ({type(e).__name__})")
        return cmd
    cmd.status = "sent"
    cmd.history.append(CommandStep(at=utcnow(), status="sent", note="Published to gateway " + gw.name))
    bus.publish("command", command_id=cmd.id, status=cmd.status)
    return cmd


def _finish(cmd: Command, status: str, note: str) -> None:
    now = utcnow()
    cmd.status = status
    cmd.completed_at = now
    cmd.result = status
    cmd.history.append(CommandStep(at=now, status=status, note=note))
    bus.publish("command", command_id=cmd.id, status=status)


async def expire(db: AsyncSession) -> int:
    """Commands with no device answer before expiry become 'expired' (never silently 'done')."""
    now = utcnow()
    rows = (await db.execute(select(Command).where(Command.status.in_(["requested", "queued", "sent"]), Command.expires_at < now))).scalars().all()
    for c in rows:
        _finish(c, "expired", "No device response before expiry")
    # accepted but never reported executed: the controller took it, but nothing confirmed the output changed
    acc = (await db.execute(select(Command).where(Command.status == "accepted", Command.expires_at < now))).scalars().all()
    for c in acc:
        _finish(c, "unknown", "Accepted, but no execution report before expiry — physical result unknown")
    return len(rows) + len(acc)
