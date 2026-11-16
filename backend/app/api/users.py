"""User management (owner/admin)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..audit import audit
from ..deps import client_ip, current_user, db_session, require_role
from ..models import ROLE_RANK, RefreshToken, Role, User
from ..timeutil import now as utcnow
from ..security import hash_password, password_problems, verify_password
from .auth import user_out

router = APIRouter(prefix="/users", tags=["users"])


class UserIn(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=200)
    role: Role = Role.viewer


class UserPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    role: Role | None = None
    is_active: bool | None = None


class PasswordIn(BaseModel):
    current_password: str = Field(max_length=200)
    new_password: str = Field(max_length=200)


@router.get("")
async def list_users(_: User = Depends(require_role(Role.admin)), db: AsyncSession = Depends(db_session)) -> list[dict]:
    return [user_out(u) | {"is_active": u.is_active} for u in (await db.execute(select(User).order_by(User.created_at))).scalars()]


@router.post("", status_code=201)
async def create_user(body: UserIn, request: Request, actor: User = Depends(require_role(Role.admin)), db: AsyncSession = Depends(db_session)) -> dict:
    if ROLE_RANK[body.role] >= ROLE_RANK[actor.role] and actor.role != Role.owner:
        raise HTTPException(403, "You can only create users with a lower role than your own")
    if probs := password_problems(body.password):
        raise HTTPException(422, " ".join(probs))
    if (await db.execute(select(User).where(User.email == body.email.lower()))).scalars().first():
        raise HTTPException(409, "A user with this email already exists")
    u = User(email=body.email.lower(), name=body.name, password_hash=hash_password(body.password), role=body.role)
    db.add(u)
    await db.flush()
    audit(db, "user", actor.id, "user.create", u.id, {"role": body.role.value}, client_ip(request))
    await db.commit()
    return user_out(u)


@router.patch("/{user_id}")
async def patch_user(user_id: str, body: UserPatch, request: Request, actor: User = Depends(require_role(Role.admin)), db: AsyncSession = Depends(db_session)) -> dict:
    u = await db.get(User, user_id)
    if not u:
        raise HTTPException(404, "No such user")
    if u.id == actor.id and (body.is_active is False or (body.role is not None and body.role != actor.role)):
        raise HTTPException(422, "You cannot disable yourself or change your own role")
    if actor.role != Role.owner:
        # Admins may only manage users ranked below them, and only grant roles below their own.
        if u.id != actor.id and ROLE_RANK[u.role] >= ROLE_RANK[actor.role]:
            raise HTTPException(403, "You can only change users with a lower role than your own")
        if body.role is not None and ROLE_RANK[body.role] >= ROLE_RANK[actor.role]:
            raise HTTPException(403, "You can only grant roles lower than your own")
    for k in ("name", "role", "is_active"):
        v = getattr(body, k)
        if v is not None:
            setattr(u, k, v)
    if body.is_active is False or body.role is not None:
        # Disabled or re-roled users must sign in again everywhere.
        await db.execute(update(RefreshToken).where(RefreshToken.user_id == u.id, RefreshToken.revoked_at.is_(None)).values(revoked_at=utcnow()))
    audit(db, "user", actor.id, "user.update", u.id, body.model_dump(exclude_none=True, mode="json"), client_ip(request))
    await db.commit()
    return user_out(u) | {"is_active": u.is_active}


@router.post("/me/password")
async def change_password(body: PasswordIn, request: Request, user: User = Depends(current_user), db: AsyncSession = Depends(db_session)) -> dict:
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(403, "Current password is wrong")
    if probs := password_problems(body.new_password):
        raise HTTPException(422, " ".join(probs))
    user.password_hash = hash_password(body.new_password)
    # Sign out every other session (refresh tokens); the caller signs in again with the new password.
    await db.execute(update(RefreshToken).where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None)).values(revoked_at=utcnow()))
    audit(db, "user", user.id, "user.password_change", ip=client_ip(request))
    await db.commit()
    return {"ok": True}
