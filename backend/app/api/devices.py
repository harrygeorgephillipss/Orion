"""Device registration and status (admin+ registers; any signed-in user can read)."""
from __future__ import annotations

import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..audit import audit
from ..config import get_settings
from ..deps import client_ip, current_user, db_session, require_role
from ..models import Device, DeviceKind, GsmModule, Role, Sensor, User
from ..security import new_device_secret
from ..services import broker_users
from ..services.snapshot import device_dict, sensor_dict

router = APIRouter(prefix="/devices", tags=["devices"])
ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{1,62}$")


def _check_id(v: str) -> str:
    if not ID_RE.match(v):
        raise ValueError("ids: 2–63 chars, lowercase letters, digits, '.', '_' or '-'")
    return v


class SensorIn(BaseModel):
    id: str
    type: Literal["mq2", "flame", "water", "dht22"]
    label: str = Field(min_length=1, max_length=80)
    room: str = Field(default="", max_length=60)
    _v = field_validator("id")(_check_id)


class ControllerIn(BaseModel):
    id: str
    name: str = Field(default="Arduino UNO", max_length=80)
    role: str = Field(default="Safety controller — reads sensors, drives outputs", max_length=160)
    sensors: list[SensorIn] = Field(default=[], max_length=32)
    _v = field_validator("id")(_check_id)


class GatewayIn(BaseModel):
    """Registers an ESP32 gateway together with the controllers and sensors behind it."""

    id: str
    name: str = Field(default="ESP32", max_length=80)
    role: str = Field(default="Gateway — Wi-Fi/MQTT to server, SIM800C", max_length=160)
    simulated: bool = False
    gsm_module_id: str | None = None
    controllers: list[ControllerIn] = Field(default=[], max_length=8)
    _v = field_validator("id")(_check_id)


@router.get("")
async def list_devices(_: User = Depends(current_user), db: AsyncSession = Depends(db_session)) -> dict:
    devs = list((await db.execute(select(Device).order_by(Device.id))).scalars())
    sens = list((await db.execute(select(Sensor).order_by(Sensor.id))).scalars())
    return {"devices": [device_dict(d) for d in devs], "sensors": [sensor_dict(s) for s in sens]}


@router.post("/gateways", status_code=201)
async def register_gateway(body: GatewayIn, request: Request, actor: User = Depends(require_role(Role.admin)), db: AsyncSession = Depends(db_session)) -> dict:
    st = get_settings()
    if body.gsm_module_id:
        try:
            _check_id(body.gsm_module_id)
        except ValueError as e:
            raise HTTPException(422, str(e))
    ids = [body.id] + [c.id for c in body.controllers] + [s.id for c in body.controllers for s in c.sensors] + ([body.gsm_module_id] if body.gsm_module_id else [])
    if len(set(ids)) != len(ids):
        raise HTTPException(422, "Device, sensor and module ids must be unique")
    for i in ids:
        if await db.get(Device, i) or await db.get(Sensor, i) or await db.get(GsmModule, i):
            raise HTTPException(409, f"Id {i!r} is already registered")
    secret, secret_hash = new_device_secret()
    gw = Device(id=body.id, home_id=st.home_id, kind=DeviceKind.gateway, name=body.name, role=body.role, simulated=body.simulated, secret_hash=secret_hash)
    db.add(gw)
    await db.flush()
    for c in body.controllers:
        db.add(Device(id=c.id, home_id=st.home_id, kind=DeviceKind.controller, name=c.name, role=c.role, parent_id=gw.id, simulated=body.simulated))
    await db.flush()
    for c in body.controllers:
        for s in c.sensors:
            db.add(Sensor(id=s.id, device_id=c.id, type=s.type, label=s.label, room=s.room, simulated=body.simulated))
    if body.gsm_module_id:
        db.add(GsmModule(id=body.gsm_module_id, gateway_id=gw.id, simulated=body.simulated))
    audit(db, "user", actor.id, "device.register", gw.id, {"simulated": body.simulated, "controllers": [c.id for c in body.controllers]}, client_ip(request))
    await db.commit()
    root = st.mqtt_topic_root
    added = broker_users.upsert(gw.id, secret)
    return await _setup_info(db, gw, secret) | {
        "gateway_id": gw.id, "home_id": st.home_id, "simulated": body.simulated, "broker_account_created": added,
        # Shown ONCE. Configure it on the broker (scripts/mqtt_passwd.py) and in the gateway firmware.
        "mqtt": {"username": gw.id, "password": secret, "publish": f"{root}/{st.home_id}/{gw.id}/+", "subscribe": f"{root}/{st.home_id}/{gw.id}/cmd"},
    }


async def _setup_info(db: AsyncSession, gw: Device, secret: str) -> dict:
    """Everything the app needs to build the ESP32 setup code (docs/USER_GUIDE.md)."""
    ctrls = list((await db.execute(select(Device).where(Device.parent_id == gw.id))).scalars())
    ctrl = ctrls[0] if ctrls else None
    sens = list((await db.execute(select(Sensor).where(Sensor.device_id == ctrl.id))).scalars()) if ctrl else []
    gsm = (await db.execute(select(GsmModule).where(GsmModule.gateway_id == gw.id))).scalars().first()
    by_type = {s.type: s.id for s in sens}
    return {"setup": {"home": gw.home_id, "gateway": gw.id, "password": secret, "controller": ctrl.id if ctrl else "", "gsm": gsm.id if gsm else "",
                      "mq2": by_type.get("mq2", ""), "flame": by_type.get("flame", ""), "water": by_type.get("water", ""), "dht": by_type.get("dht22", ""),
                      "mqtt_port": 8883 if get_settings().mqtt_tls else 1883, "lan_host": get_settings().lan_host}}


@router.post("/{device_id}/rotate-secret")
async def rotate_secret(device_id: str, request: Request, actor: User = Depends(require_role(Role.admin)), db: AsyncSession = Depends(db_session)) -> dict:
    """New broker password for a gateway (lost setup code, or re-setup). The old password stops working."""
    gw = await db.get(Device, device_id)
    if not gw or gw.kind != DeviceKind.gateway:
        raise HTTPException(404, "No such gateway")
    secret, gw.secret_hash = new_device_secret()
    audit(db, "user", actor.id, "device.rotate_secret", gw.id, ip=client_ip(request))
    await db.commit()
    added = broker_users.upsert(gw.id, secret)
    return await _setup_info(db, gw, secret) | {"gateway_id": gw.id, "broker_account_created": added, "mqtt": {"username": gw.id, "password": secret}}


@router.delete("/{device_id}")
async def delete_device(device_id: str, request: Request, actor: User = Depends(require_role(Role.owner)), db: AsyncSession = Depends(db_session)) -> dict:
    d = await db.get(Device, device_id)
    if not d:
        raise HTTPException(404, "No such device")
    children = list((await db.execute(select(Device).where(Device.parent_id == d.id))).scalars())
    for c in children:
        await db.delete(c)
    await db.delete(d)
    audit(db, "user", actor.id, "device.delete", device_id, {"children": [c.id for c in children]}, client_ip(request))
    await db.commit()
    if d.kind == DeviceKind.gateway:
        broker_users.remove(device_id)
    return {"ok": True}
