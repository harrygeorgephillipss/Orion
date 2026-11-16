"""Password hashing (Argon2id), JWT access tokens and rotating refresh tokens."""
from __future__ import annotations

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from .config import get_settings

_ph = PasswordHasher()  # argon2id with library defaults
ALGO = "HS256"
# Verifying against this keeps unknown-user logins as slow as real ones (no user enumeration by timing).
_DUMMY_HASH = _ph.hash("orion-timing-equaliser")


def hash_password(pw: str) -> str:
    return _ph.hash(pw)


def verify_password(pw: str, h: str | None) -> bool:
    try:
        return _ph.verify(h or _DUMMY_HASH, pw) and h is not None
    except (VerifyMismatchError, VerificationError, InvalidHashError):
        return False


def password_problems(pw: str) -> list[str]:
    errs = []
    if len(pw) < 10:
        errs.append("Password must be at least 10 characters.")
    if pw.lower() == pw or pw.upper() == pw or not any(c.isdigit() for c in pw):
        errs.append("Use upper- and lower-case letters and at least one digit.")
    return errs


def create_access_token(user_id: str, role: str) -> tuple[str, int]:
    s = get_settings()
    now = datetime.now(timezone.utc)
    exp = now + timedelta(seconds=s.access_token_ttl_s)
    tok = jwt.encode({"sub": user_id, "role": role, "iat": now, "exp": exp, "typ": "access"}, s.secret_key, algorithm=ALGO)
    return tok, s.access_token_ttl_s


def decode_access_token(token: str) -> dict:
    s = get_settings()
    data = jwt.decode(token, s.secret_key, algorithms=[ALGO], options={"require": ["exp", "sub", "typ"]})
    if data.get("typ") != "access":
        raise jwt.InvalidTokenError("wrong token type")
    return data


def new_refresh_secret() -> tuple[str, str, str]:
    """Returns (jti, opaque token for the client, sha256 hash to store)."""
    jti = "rt-" + secrets.token_hex(12)
    raw = secrets.token_urlsafe(48)
    token = f"{jti}.{raw}"
    return jti, token, sha256(token)


def sha256(v: str) -> str:
    return hashlib.sha256(v.encode()).hexdigest()


def new_device_secret() -> tuple[str, str]:
    raw = secrets.token_urlsafe(24)
    return raw, _ph.hash(raw)
