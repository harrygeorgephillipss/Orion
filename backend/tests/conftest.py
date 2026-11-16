"""Test setup: a real PostgreSQL test database (migrated with Alembic), no MQTT unless a test starts it."""
from __future__ import annotations

import os

os.environ.setdefault("ORION_DATABASE_URL", "postgresql+asyncpg://orion:orion-dev@localhost:5432/orion_test")
os.environ["ORION_SECRET_KEY"] = "t" * 64
os.environ["ORION_MQTT_ENABLED"] = "false"
os.environ["ORION_CLEAR_HOLD_S"] = "1"
os.environ["ORION_BOOTSTRAP_OWNER_EMAIL"] = ""

import subprocess
import sys
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from sqlalchemy import text

from app import db as dbm
from app.models import Role, User
from app.ratelimit import command_limiter, login_limiter
from app.security import hash_password

ROOT = Path(__file__).resolve().parents[1]
PASSWORD = "Correct-Horse-9"


@pytest.fixture(scope="session", autouse=True)
def migrate() -> None:
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=ROOT, check=True, env=os.environ.copy(), capture_output=True)


@pytest_asyncio.fixture(scope="session")
async def engine():
    eng = dbm.init_engine(os.environ["ORION_DATABASE_URL"], null_pool=True)
    yield eng
    await eng.dispose()


@pytest_asyncio.fixture(autouse=True)
async def clean(engine):
    async with engine.begin() as c:
        tables = ", ".join(t.name for t in reversed(dbm.Base.metadata.sorted_tables))
        await c.execute(text(f"TRUNCATE {tables} RESTART IDENTITY CASCADE"))
    login_limiter.reset()
    command_limiter.reset()
    from app.services import commands

    commands.set_publisher(None)
    yield


@pytest_asyncio.fixture
async def db(engine):
    async with dbm.sessionmaker()() as s:
        yield s


@pytest_asyncio.fixture
async def client(engine):
    from app.main import app

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        yield c


async def make_user(db, email: str, role: Role, name: str | None = None) -> User:
    u = User(email=email, name=name or email.split("@")[0], role=role, password_hash=hash_password(PASSWORD))
    db.add(u)
    await db.commit()
    return u


async def login(client, email: str, client_kind: str = "web") -> dict:
    r = await client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD, "client": client_kind})
    assert r.status_code == 200, r.text
    return r.json()


@pytest_asyncio.fixture
async def users(db):
    out = {}
    for role in Role:
        out[role.value] = await make_user(db, f"{role.value}@example.com", role)
    return out


@pytest_asyncio.fixture
async def auth(client, users):
    """Authorization headers per role."""
    h = {}
    for role in Role:
        tok = (await login(client, f"{role.value}@example.com"))["access_token"]
        h[role.value] = {"Authorization": f"Bearer {tok}"}
    login_limiter.reset()
    return h


GATEWAY = {
    "id": "esp32-test", "name": "ESP32", "simulated": True, "gsm_module_id": "gsm-test",
    "controllers": [{"id": "uno-test", "sensors": [
        {"id": "mq2-1", "type": "mq2", "label": "MQ-2 smoke / gas", "room": "Hall"},
        {"id": "flame-1", "type": "flame", "label": "Flame sensor", "room": "Kitchen"},
        {"id": "water-1", "type": "water", "label": "Water sensor", "room": "Utility"},
        {"id": "dht-1", "type": "dht22", "label": "DHT22", "room": "Living room"},
    ]}],
}


@pytest_asyncio.fixture
async def gateway(client, auth):
    r = await client.post("/api/v1/devices/gateways", json=GATEWAY, headers=auth["admin"])
    assert r.status_code == 201, r.text
    return r.json()
