"""System health, configuration, audit log and emergency contacts."""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, model_validator
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from .. import mqtt
from ..audit import audit
from ..bus import bus
from ..deps import client_ip, current_user, db_session, require_role
from ..models import AuditLog, NotificationContact, Role, User
from ..services.settings_store import DEFAULTS, get_config, get_config_row, set_config
from ..timeutil import ms

router = APIRouter(tags=["system"])


@router.get("/health")
async def health(db: AsyncSession = Depends(db_session)) -> dict:
    """Unauthenticated liveness/readiness probe. Reveals no home data."""
    try:
        await db.execute(text("select 1"))
        db_ok = True
    except Exception:
        db_ok = False
    return {"status": "ok" if db_ok else "degraded", "database": db_ok, "mqtt": mqtt.state.connected}


@router.get("/system/status")
async def system_status(_: User = Depends(require_role(Role.admin))) -> dict:
    return {"mqtt": {"connected": mqtt.state.connected, "last_error": mqtt.state.last_error, "received": mqtt.state.received, "rejected": mqtt.state.rejected}, "websocket_clients": bus.subscribers}


# ---------- configuration ----------
class Freshness(BaseModel):
    sensor_s: int = Field(ge=5, le=600)
    heartbeat_s: int = Field(ge=5, le=600)


class Thresholds(BaseModel):
    mq2_warning: int = Field(ge=0, le=4095)
    mq2_critical: int = Field(ge=0, le=4095)
    water_wet: int = Field(ge=0, le=4095)
    temp_advisory_c: float | None = Field(default=None, ge=-20, le=80)
    humidity_advisory: float | None = Field(default=None, ge=0, le=100)

    @model_validator(mode="after")
    def _order(self) -> "Thresholds":
        if self.mq2_warning >= self.mq2_critical:
            raise ValueError("mq2_critical must be higher than mq2_warning")
        return self


class Home(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    timezone: str = Field(max_length=60)


SCHEMAS = {"freshness": Freshness, "thresholds": Thresholds, "home": Home}


@router.get("/config")
async def get_all_config(_: User = Depends(current_user), db: AsyncSession = Depends(db_session)) -> dict:
    out = {}
    for k in DEFAULTS:
        row = await get_config_row(db, k)
        out[k] = {"value": await get_config(db, k), "version": row.version if row else 0, "updated_by": row.updated_by if row else None, "updated_at": ms(row.updated_at) if row else None}
    return out


@router.put("/config/{key}")
async def put_config(key: str, body: dict, request: Request, user: User = Depends(require_role(Role.admin)), db: AsyncSession = Depends(db_session)) -> dict:
    if key == "rooms":
        if not isinstance(body, dict) or len(body) > 64 or not all(isinstance(k, str) and isinstance(v, str) and len(k) <= 64 and len(v) <= 40 for k, v in body.items()):
            raise HTTPException(422, "rooms must map sensor ids to names (≤ 40 chars)")
        value = body
    elif key in SCHEMAS:
        try:
            value = SCHEMAS[key].model_validate(body).model_dump()
        except Exception as e:
            raise HTTPException(422, str(e)[:400])
    else:
        raise HTTPException(404, "Unknown config key")
    row = await set_config(db, key, value, user.name)
    # These settings never reach the safety controller: firmware thresholds are set in firmware and reported back.
    audit(db, "user", user.id, "config.update", key, {"value": value}, client_ip(request))
    await db.commit()
    bus.publish("update", reason="config")
    return {"key": key, "value": value, "version": row.version}


# ---------- audit ----------
@router.get("/audit")
async def audit_log(limit: int = 100, _: User = Depends(require_role(Role.admin)), db: AsyncSession = Depends(db_session)) -> list[dict]:
    rows = (await db.execute(select(AuditLog).order_by(AuditLog.at.desc()).limit(max(1, min(limit, 1000))))).scalars()
    return [{"at": ms(r.at), "actor_type": r.actor_type, "actor_id": r.actor_id, "action": r.action, "target": r.target, "detail": r.detail, "ip": r.ip} for r in rows]


# ---------- emergency contacts ----------
E164 = re.compile(r"^\+[1-9]\d{7,14}$")


class ContactIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    phone: str = Field(max_length=16)
    sms: bool = True
    call: bool = False
    enabled: bool = True

    @model_validator(mode="after")
    def _phone(self) -> "ContactIn":
        if not E164.match(self.phone):
            raise ValueError("phone must be in international format, e.g. +9198XXXXXXXX")
        return self


def _contact(c: NotificationContact, full: bool) -> dict:
    phone = c.phone if full else c.phone[:3] + " ••••• ••" + c.phone[-2:]
    return {"id": c.id, "name": c.name, "phone": phone, "sms": c.sms, "call": c.call, "enabled": c.enabled}


@router.get("/contacts")
async def list_contacts(user: User = Depends(current_user), db: AsyncSession = Depends(db_session)) -> list[dict]:
    full = user.role in (Role.owner, Role.admin)
    return [_contact(c, full) for c in (await db.execute(select(NotificationContact).order_by(NotificationContact.created_at))).scalars()]


@router.post("/contacts", status_code=201)
async def add_contact(body: ContactIn, request: Request, user: User = Depends(require_role(Role.admin)), db: AsyncSession = Depends(db_session)) -> dict:
    c = NotificationContact(**body.model_dump())
    db.add(c)
    await db.flush()
    audit(db, "user", user.id, "contact.create", c.id, {"name": c.name}, client_ip(request))  # number deliberately not logged
    await db.commit()
    return _contact(c, True)


@router.delete("/contacts/{contact_id}")
async def delete_contact(contact_id: str, request: Request, user: User = Depends(require_role(Role.admin)), db: AsyncSession = Depends(db_session)) -> dict:
    c = await db.get(NotificationContact, contact_id)
    if not c:
        raise HTTPException(404, "No such contact")
    await db.delete(c)
    audit(db, "user", user.id, "contact.delete", contact_id, ip=client_ip(request))
    await db.commit()
    return {"ok": True}
