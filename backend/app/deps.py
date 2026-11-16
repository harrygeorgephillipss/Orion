"""FastAPI dependencies: DB session, current user, role checks."""
from __future__ import annotations

from collections.abc import AsyncIterator

import jwt
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from .db import sessionmaker
from .models import ROLE_RANK, Role, User
from .security import decode_access_token

_bearer = HTTPBearer(auto_error=False)


async def db_session() -> AsyncIterator[AsyncSession]:
    async with sessionmaker()() as s:
        yield s


async def user_from_token(db: AsyncSession, token: str) -> User:
    try:
        data = decode_access_token(token)
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid or expired token", headers={"WWW-Authenticate": "Bearer"})
    user = await db.get(User, data["sub"])
    if not user or not user.is_active:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "User not found or disabled", headers={"WWW-Authenticate": "Bearer"})
    return user


async def current_user(creds: HTTPAuthorizationCredentials | None = Depends(_bearer), db: AsyncSession = Depends(db_session)) -> User:
    if not creds or creds.scheme.lower() != "bearer":
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Authentication required", headers={"WWW-Authenticate": "Bearer"})
    return await user_from_token(db, creds.credentials)


def require_role(minimum: Role):
    async def dep(user: User = Depends(current_user)) -> User:
        if ROLE_RANK[user.role] < ROLE_RANK[minimum]:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Requires role {minimum.value} or higher")
        return user

    return dep


def client_ip(request: Request) -> str:
    return request.client.host if request.client else ""
