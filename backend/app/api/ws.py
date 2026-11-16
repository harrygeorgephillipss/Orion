"""WebSocket: real-time events for the web and Android apps.

Protocol: the client connects to /api/v1/ws and must send {"type":"auth","token":"<access token>"} within 5 s
(tokens are not put in URLs, which end up in logs). The server answers {"type":"ready"} and then streams events:
update, telemetry, incident_opened, incident_escalated, incident_cleared, device_status, actuators, command,
gsm_status, gsm_attempt, server_status. Clients re-fetch /overview on "update" (debounced) for the full state.
"""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from ..bus import bus
from ..db import sessionmaker
from ..deps import user_from_token

router = APIRouter()


@router.websocket("/ws")
async def ws(socket: WebSocket) -> None:
    await socket.accept()
    try:
        first = await asyncio.wait_for(socket.receive_text(), timeout=5)
        msg = json.loads(first)
        if msg.get("type") != "auth" or not isinstance(msg.get("token"), str):
            raise ValueError("auth required")
        async with sessionmaker()() as db:
            user = await user_from_token(db, msg["token"])
    except (asyncio.TimeoutError, ValueError, HTTPException, WebSocketDisconnect):
        try:
            await socket.close(code=4401, reason="authentication required")
        except Exception:
            pass
        return

    q = bus.subscribe()
    await socket.send_json({"type": "ready", "user": user.name})

    async def pump() -> None:
        while True:
            await socket.send_json(await q.get())

    async def drain() -> None:  # keep reading so disconnects and pings are noticed
        while True:
            m = await socket.receive_text()
            if m == "ping":
                await socket.send_text("pong")

    tasks = [asyncio.create_task(pump()), asyncio.create_task(drain())]
    try:
        await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for t in tasks:
            t.cancel()
        bus.unsubscribe(q)
