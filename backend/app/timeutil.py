from __future__ import annotations

from datetime import datetime, timezone


def now() -> datetime:
    return datetime.now(timezone.utc)


def ms(dt: datetime | None) -> int | None:
    return None if dt is None else int(dt.timestamp() * 1000)


def from_ms(v: int | float | None) -> datetime | None:
    return None if v is None else datetime.fromtimestamp(v / 1000, tz=timezone.utc)
