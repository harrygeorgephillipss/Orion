"""Audit trail: every security- or safety-relevant mutation is recorded."""
from __future__ import annotations

from sqlalchemy.ext.asyncio import AsyncSession

from .models import AuditLog


def audit(db: AsyncSession, actor_type: str, actor_id: str, action: str, target: str = "", detail: dict | None = None, ip: str = "") -> None:
    db.add(AuditLog(actor_type=actor_type, actor_id=actor_id, action=action, target=target, detail=detail or {}, ip=ip))
