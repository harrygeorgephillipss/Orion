"""Authentication: login, token refresh (rotating, reuse-detecting), logout, current user."""
from __future__ import annotations

from datetime import timedelta
from typing import Literal

from fastapi import APIRouter, Cookie, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..audit import audit
from ..config import get_settings
from ..deps import client_ip, current_user, db_session
from ..models import RefreshToken, User
from ..ratelimit import limit, login_limiter
from ..security import create_access_token, new_refresh_secret, sha256, verify_password
from ..timeutil import now as utcnow

router = APIRouter(prefix="/auth", tags=["auth"])
COOKIE = "orion_refresh"


class LoginIn(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=200)
    client: Literal["web", "mobile"] = "web"


class RefreshIn(BaseModel):
    refresh_token: str | None = Field(default=None, max_length=200)
    client: Literal["web", "mobile"] = "web"


def user_out(u: User) -> dict:
    return {"id": u.id, "email": u.email, "name": u.name, "role": u.role.value}


async def _issue(db: AsyncSession, user: User, response: Response, client: str, ua: str, family: str | None = None) -> dict:
    st = get_settings()
    jti, token, h = new_refresh_secret()
    db.add(RefreshToken(id=jti, user_id=user.id, family_id=family or jti, token_hash=h, expires_at=utcnow() + timedelta(seconds=st.refresh_token_ttl_s), user_agent=ua[:200]))
    access, ttl = create_access_token(user.id, user.role.value)
    out = {"access_token": access, "token_type": "bearer", "expires_in": ttl, "user": user_out(user)}
    if client == "mobile":
        out["refresh_token"] = token  # stored by the app in Android secure storage
    else:  # browsers: refresh token only in an httpOnly cookie, never readable by JavaScript
        response.set_cookie(COOKIE, token, max_age=st.refresh_token_ttl_s, httponly=True, secure=st.is_production, samesite="strict", path="/api/v1/auth")
    return out


@router.post("/login", dependencies=[Depends(limit(login_limiter, "login"))])
async def login(body: LoginIn, request: Request, response: Response, db: AsyncSession = Depends(db_session)) -> dict:
    st = get_settings()
    user = (await db.execute(select(User).where(User.email == body.email.lower()))).scalars().first()
    now = utcnow()
    if user and user.locked_until and user.locked_until > now:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Account temporarily locked after repeated failed sign-ins")
    ok = verify_password(body.password, user.password_hash if user else None)
    if not ok or not user or not user.is_active:
        if user:
            user.failed_logins += 1
            if user.failed_logins >= st.login_max_failures:
                user.locked_until = now + timedelta(seconds=st.login_lock_s)
                user.failed_logins = 0
            audit(db, "user", user.id, "auth.login_failed", ip=client_ip(request))
            await db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Wrong email or password")
    user.failed_logins, user.locked_until = 0, None
    out = await _issue(db, user, response, body.client, request.headers.get("user-agent", ""))
    audit(db, "user", user.id, "auth.login", detail={"client": body.client}, ip=client_ip(request))
    await db.commit()
    return out


@router.post("/refresh")
async def refresh(body: RefreshIn, request: Request, response: Response, db: AsyncSession = Depends(db_session), cookie: str | None = Cookie(default=None, alias=COOKIE)) -> dict:
    token = body.refresh_token or cookie
    if not token or "." not in token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "No refresh token")
    row = await db.get(RefreshToken, token.split(".", 1)[0])
    now = utcnow()
    if row is None or row.token_hash != sha256(token):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid refresh token")
    if row.revoked_at is not None:
        # A rotated token was used again: likely stolen. Revoke the whole family.
        await db.execute(update(RefreshToken).where(RefreshToken.family_id == row.family_id, RefreshToken.revoked_at.is_(None)).values(revoked_at=now))
        audit(db, "user", row.user_id, "auth.refresh_reuse_detected", ip=client_ip(request))
        await db.commit()
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Refresh token reuse detected — please sign in again")
    if row.expires_at < now:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Refresh token expired")
    user = await db.get(User, row.user_id)
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User disabled")
    row.revoked_at = now
    out = await _issue(db, user, response, body.client, request.headers.get("user-agent", ""), family=row.family_id)
    await db.commit()
    return out


@router.post("/logout")
async def logout(body: RefreshIn, response: Response, db: AsyncSession = Depends(db_session), cookie: str | None = Cookie(default=None, alias=COOKIE)) -> dict:
    token = body.refresh_token or cookie
    if token and "." in token:
        row = await db.get(RefreshToken, token.split(".", 1)[0])
        if row and row.token_hash == sha256(token):
            await db.execute(update(RefreshToken).where(RefreshToken.family_id == row.family_id).values(revoked_at=utcnow()))
            audit(db, "user", row.user_id, "auth.logout")
            await db.commit()
    response.delete_cookie(COOKIE, path="/api/v1/auth")
    return {"ok": True}


@router.get("/me")
async def me(user: User = Depends(current_user)) -> dict:
    return user_out(user)
