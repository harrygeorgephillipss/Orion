"""Overview snapshot, telemetry history, incidents, commands."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..audit import audit
from ..bus import bus
from ..deps import client_ip, current_user, db_session, require_role
from ..models import Command, Incident, IncidentEvent, Role, Sensor, User
from ..ratelimit import command_limiter, limit
from ..services import commands as cmds
from ..services import snapshot
from ..timeutil import now as utcnow

router = APIRouter(tags=["data"])
METRIC_TYPES = {"mq2": "mq2", "flame": "flame", "water": "water", "temp": "dht22", "hum": "dht22"}


@router.get("/overview")
async def overview(_: User = Depends(current_user), db: AsyncSession = Depends(db_session)) -> dict:
    return await snapshot.overview(db)


@router.get("/telemetry")
async def telemetry(
    series: str = Query(max_length=140, description="<sensor_id>:<metric>"),
    from_ms: int = Query(alias="from", ge=0),
    to_ms: int = Query(alias="to", ge=0),
    max_points: int = Query(default=2000, ge=10, le=5000),
    _: User = Depends(current_user),
    db: AsyncSession = Depends(db_session),
) -> dict:
    if ":" not in series:
        raise HTTPException(422, "series must be <sensor_id>:<metric>")
    sensor_id, metric = series.rsplit(":", 1)
    s = await db.get(Sensor, sensor_id)
    if s is None or METRIC_TYPES.get(metric) != s.type:
        raise HTTPException(404, "No such series")
    if to_ms <= from_ms or to_ms - from_ms > 400 * 86400e3:
        raise HTTPException(422, "Invalid time range (max 400 days)")
    pts = await snapshot.history(db, sensor_id, metric, from_ms, to_ms, max_points)
    return {"series": series, "simulated": s.simulated, "points": pts}


@router.get("/incidents")
async def incidents(
    state: str = Query(default="all", pattern="^(all|active|cleared)$"),
    limit_: int = Query(default=50, alias="limit", ge=1, le=500),
    _: User = Depends(current_user),
    db: AsyncSession = Depends(db_session),
) -> list[dict]:
    q = select(Incident).order_by(Incident.opened_at.desc()).limit(limit_)
    if state != "all":
        q = q.where(Incident.state == state)
    return [snapshot.incident_dict(i) for i in (await db.execute(q)).scalars()]


@router.post("/incidents/{incident_id}/ack")
async def acknowledge(incident_id: str, request: Request, user: User = Depends(require_role(Role.member)), db: AsyncSession = Depends(db_session)) -> dict:
    inc = await db.get(Incident, incident_id)
    if not inc:
        raise HTTPException(404, "Incident not found")
    if inc.acknowledged_at:
        raise HTTPException(409, "Already acknowledged")
    inc.acknowledged_by, inc.acknowledged_at = user.name, utcnow()
    inc.events.append(IncidentEvent(at=inc.acknowledged_at, text=f"Acknowledged by {user.name} — acknowledgement does not clear or silence the hazard"))
    audit(db, "user", user.id, "incident.acknowledge", inc.id, ip=client_ip(request))
    await db.commit()
    bus.publish("update", reason="ack")
    return {"ok": True}


class CommandIn(BaseModel):
    actuator: str = Field(max_length=32)
    action: str = Field(max_length=32)
    device_id: str | None = Field(default=None, max_length=64)


@router.post("/commands", status_code=201, dependencies=[Depends(limit(command_limiter, "cmd"))])
async def create_command(body: CommandIn, request: Request, user: User = Depends(require_role(Role.member)), db: AsyncSession = Depends(db_session)) -> dict:
    try:
        cmd = await cmds.create(db, device_id=body.device_id, actuator=body.actuator, action=body.action, actor=user.name)
    except cmds.CommandError as e:
        audit(db, "user", user.id, "command.refused", f"{body.actuator}:{body.action}", {"reason": str(e)}, client_ip(request))
        await db.commit()
        raise HTTPException(e.code, str(e))
    audit(db, "user", user.id, "command.create", cmd.id, {"actuator": cmd.actuator, "action": cmd.action, "status": cmd.status}, client_ip(request))
    await db.commit()
    bus.publish("update", reason="command")
    return snapshot.command_dict(cmd)


@router.get("/commands")
async def list_commands(_: User = Depends(current_user), db: AsyncSession = Depends(db_session)) -> list[dict]:
    return [snapshot.command_dict(c) for c in (await db.execute(select(Command).order_by(Command.created_at.desc()).limit(50))).scalars()]


@router.get("/commands/allowed")
async def allowed_commands(_: User = Depends(current_user)) -> list[dict]:
    return [{"actuator": a, "action": b, "description": d} for (a, b), d in cmds.ALLOWED.items()]
