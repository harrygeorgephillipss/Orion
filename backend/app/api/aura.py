"""Aura endpoints: status, streamed chat (Server-Sent Events), command proposals, conversations, preferences."""
from __future__ import annotations

import json
import logging
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..audit import audit
from ..aura import providers, service
from ..deps import client_ip, current_user, db_session, require_role
from ..db import sessionmaker
from ..models import AuraConversation, AuraMessage, AuraProposal, Role, User, UserPreference
from ..ratelimit import RateLimiter
from ..services import commands as cmds
from ..services import snapshot
from ..timeutil import ms
from ..timeutil import now as utcnow

router = APIRouter(prefix="/aura", tags=["aura"])
log = logging.getLogger("orion.aura")
aura_limiter = RateLimiter(limit=20, window_s=60)


class ChatIn(BaseModel):
    message: str = Field(min_length=1, max_length=2000)
    conversation_id: str | None = Field(default=None, max_length=40)
    language: str = Field(default="auto", max_length=8)
    voice: bool = False
    page: str | None = Field(default=None, max_length=20)


@router.get("/status")
async def status(_: User = Depends(current_user)) -> dict:
    return providers.status()


@router.post("/chat")
async def chat(body: ChatIn, request: Request, user: User = Depends(current_user)) -> StreamingResponse:
    aura_limiter.check(f"aura:{user.id}")
    ip = client_ip(request)

    async def gen():
        # Own session: the stream outlives the request-scoped dependency.
        async with sessionmaker()() as db:
            u = await db.get(User, user.id)
            try:
                async for e in service.chat(db, u, body.message, body.conversation_id, body.language, body.voice, body.page, ip):
                    yield f"data: {json.dumps(e, default=str)}\n\n"
                await db.commit()
            except Exception:
                log.exception("aura chat failed")
                await db.rollback()
                yield "data: " + json.dumps({"type": "error", "code": "server", "message": "Aura hit a server error."}) + "\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})


@router.post("/proposals/{pid}/confirm")
async def confirm(pid: str, request: Request, user: User = Depends(require_role(Role.member)), db: AsyncSession = Depends(db_session)) -> dict:
    p = await db.get(AuraProposal, pid)
    if not p or p.user_id != user.id:
        raise HTTPException(404, "No such proposal")
    if p.status != "pending":
        raise HTTPException(409, f"Proposal already {p.status}")
    if p.expires_at < utcnow():
        p.status = "expired"
        await db.commit()
        raise HTTPException(410, "This suggestion expired — ask Aura again or use the Devices page")
    try:
        cmd = await cmds.create(db, device_id=None, actuator=p.actuator, action=p.action, actor=user.name, origin="aura_proposal")
    except cmds.CommandError as e:
        raise HTTPException(e.code, str(e))
    p.status, p.command_id = "confirmed", cmd.id
    audit(db, "user", user.id, "aura.proposal.confirm", p.id, {"command": cmd.id, "actuator": p.actuator, "action": p.action}, client_ip(request))
    await db.commit()
    return snapshot.command_dict(cmd)


@router.post("/proposals/{pid}/decline")
async def decline(pid: str, user: User = Depends(current_user), db: AsyncSession = Depends(db_session)) -> dict:
    p = await db.get(AuraProposal, pid)
    if not p or p.user_id != user.id:
        raise HTTPException(404, "No such proposal")
    if p.status == "pending":
        p.status = "declined"
        audit(db, "user", user.id, "aura.proposal.decline", p.id)
        await db.commit()
    return {"ok": True}


@router.get("/conversations")
async def conversations(user: User = Depends(current_user), db: AsyncSession = Depends(db_session)) -> list[dict]:
    rows = (await db.execute(select(AuraConversation).where(AuraConversation.user_id == user.id).order_by(AuraConversation.updated_at.desc()).limit(50))).scalars()
    return [{"id": c.id, "title": c.title, "updated_at": ms(c.updated_at)} for c in rows]


@router.get("/conversations/{cid}")
async def conversation(cid: str, user: User = Depends(current_user), db: AsyncSession = Depends(db_session)) -> dict:
    c = await db.get(AuraConversation, cid)
    if not c or c.user_id != user.id:
        raise HTTPException(404, "No such conversation")
    msgs = (await db.execute(select(AuraMessage).where(AuraMessage.conversation_id == cid).order_by(AuraMessage.id))).scalars()
    return {"id": c.id, "title": c.title, "messages": [{"role": m.role, "text": m.text, "at": ms(m.at), "meta": m.meta} for m in msgs]}


@router.delete("/conversations/{cid}")
async def delete_conversation(cid: str, user: User = Depends(current_user), db: AsyncSession = Depends(db_session)) -> dict:
    c = await db.get(AuraConversation, cid)
    if not c or c.user_id != user.id:
        raise HTTPException(404, "No such conversation")
    await db.delete(c)
    await db.commit()
    return {"ok": True}


class PrefsIn(BaseModel):
    language: str = Field(default="auto", max_length=8)
    speak_replies: bool = True
    voice_rate: float = Field(default=1.0, ge=0.5, le=2.0)
    hands_free: bool = False
    push: dict[Literal["critical", "warning", "degraded"], bool] = {"critical": True, "warning": True, "degraded": True}


@router.get("/preferences")
async def get_prefs(user: User = Depends(current_user), db: AsyncSession = Depends(db_session)) -> dict:
    row = await db.get(UserPreference, user.id)
    return PrefsIn(**(row.value if row else {})).model_dump()


@router.put("/preferences")
async def put_prefs(body: PrefsIn, user: User = Depends(current_user), db: AsyncSession = Depends(db_session)) -> dict:
    row = await db.get(UserPreference, user.id)
    if row:
        row.value, row.updated_at = body.model_dump(), utcnow()
    else:
        db.add(UserPreference(user_id=user.id, value=body.model_dump()))
    await db.commit()
    return body.model_dump()
