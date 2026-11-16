"""ORION backend entrypoint: `uvicorn app.main:app`."""
from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from sqlalchemy import func, select

from . import mqtt
from .api import aura, auth, data, devices, system, users, ws
from .audit import audit
from .bus import bus
from .config import get_settings
from .db import sessionmaker
from .models import Role, User
from .security import hash_password, password_problems
from .services import commands, engine

log = logging.getLogger("orion")


async def bootstrap_owner() -> None:
    """Create the first owner from ORION_BOOTSTRAP_OWNER_* if the user table is empty."""
    st = get_settings()
    async with sessionmaker()() as db:
        if (await db.execute(select(func.count()).select_from(User))).scalar_one():
            return
        if not (st.bootstrap_owner_email and st.bootstrap_owner_password):
            log.warning("No users exist. Set ORION_BOOTSTRAP_OWNER_EMAIL/PASSWORD or run `python -m app.cli create-user`.")
            return
        if probs := password_problems(st.bootstrap_owner_password):
            raise RuntimeError("ORION_BOOTSTRAP_OWNER_PASSWORD is too weak: " + " ".join(probs))
        db.add(User(email=st.bootstrap_owner_email.lower(), name=st.bootstrap_owner_name, password_hash=hash_password(st.bootstrap_owner_password), role=Role.owner))
        audit(db, "system", "bootstrap", "user.create_owner", st.bootstrap_owner_email.lower())
        await db.commit()
        log.info("Created owner account %s", st.bootstrap_owner_email)


async def monitor() -> None:
    """Periodic health pass: stale sensors, missing heartbeats, clear-holds and command expiry happen even with no traffic."""
    st = get_settings()
    while True:
        try:
            async with sessionmaker()() as db:
                changed = await engine.evaluate(db)
                expired = await commands.expire(db)
                await db.commit()
            bus.publish("tick")
            if changed or expired:
                bus.publish("update", reason="monitor")
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("monitor pass failed")
        await asyncio.sleep(st.monitor_interval_s)


@asynccontextmanager
async def lifespan(app: FastAPI):
    st = get_settings()
    await bootstrap_owner()
    tasks = [asyncio.create_task(monitor(), name="monitor")]
    if st.mqtt_enabled:
        tasks.append(asyncio.create_task(mqtt.run(), name="mqtt"))
    yield
    for t in tasks:
        t.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


def create_app() -> FastAPI:
    st = get_settings()
    app = FastAPI(title="ORION API", version="0.2.0", lifespan=lifespan, docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)
    if st.cors_list:
        app.add_middleware(CORSMiddleware, allow_origins=st.cors_list, allow_credentials=True, allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"], allow_headers=["Authorization", "Content-Type"])

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        resp = await call_next(request)
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("X-Frame-Options", "DENY")
        resp.headers.setdefault("Referrer-Policy", "no-referrer")
        resp.headers.setdefault("Permissions-Policy", "camera=(), geolocation=(), microphone=(self)")
        if request.url.path.startswith("/api/"):
            resp.headers.setdefault("Cache-Control", "no-store")
        if st.is_production:
            resp.headers.setdefault("Strict-Transport-Security", "max-age=31536000")
        return resp

    @app.exception_handler(Exception)
    async def unhandled(request: Request, exc: Exception):  # never leak stack traces to clients
        log.exception("unhandled error on %s", request.url.path)
        return JSONResponse({"detail": "Internal server error"}, status_code=500)

    for r in (auth.router, users.router, devices.router, data.router, system.router, aura.router, ws.router):
        app.include_router(r, prefix="/api/v1")

    # Serve the built single-file web app on the same origin (cookies + no CORS needed).
    fe = Path(st.frontend_dir) if st.frontend_dir else Path(__file__).resolve().parents[2] / "frontend"
    index = fe / "index.html"
    if index.is_file():
        @app.get("/", include_in_schema=False)
        async def root() -> FileResponse:
            return FileResponse(index, headers={"Cache-Control": "no-cache"})

    return app


app = create_app()
