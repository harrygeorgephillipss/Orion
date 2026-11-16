"""Register / unregister a phone for push notifications."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from ..deps import current_user, db_session
from ..models import PushToken, User
from ..push.fcm import load_client

router = APIRouter(prefix="/push", tags=["push"])


class TokenIn(BaseModel):
    token: str = Field(min_length=20, max_length=300)
    platform: str = Field(default="android", pattern="^(android|ios|web)$")


@router.get("/status")
async def status(_: User = Depends(current_user)) -> dict:
    return {"enabled": load_client() is not None}


@router.post("/register")
async def register(body: TokenIn, user: User = Depends(current_user), db: AsyncSession = Depends(db_session)) -> dict:
    row = await db.get(PushToken, body.token)
    if row:
        row.user_id, row.platform, row.last_error = user.id, body.platform, None
    else:
        db.add(PushToken(token=body.token, user_id=user.id, platform=body.platform))
    await db.commit()
    return {"ok": True}


@router.post("/unregister")
async def unregister(body: TokenIn, user: User = Depends(current_user), db: AsyncSession = Depends(db_session)) -> dict:
    row = await db.get(PushToken, body.token)
    if row and row.user_id == user.id:
        await db.delete(row)
        await db.commit()
    return {"ok": True}
